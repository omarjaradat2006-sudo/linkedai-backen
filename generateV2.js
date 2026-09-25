'use strict';
// generateV2.js — server-authoritative generation for LinkedAI.
//
// WHY THIS EXISTS
// The extension used to charge credits in the browser and then wait on the AI.
// Chrome destroys an extension popup the moment it loses focus, and terminates
// an extension's background worker when a fetch() takes more than 30 seconds.
// A user who clicked away mid-generation, or whose resume took a while, could be
// charged with nothing to show for it.
//
// HOW THIS FIXES IT
// The server owns the whole transaction:
//     verify the user -> check the balance -> generate -> ONE Firestore write
//     that deducts the credits AND saves the result.
// Credits are only ever deducted in the same write that stores the result, so
// "charged but no result" cannot happen. If the browser disappears halfway
// through, this handler keeps running, finishes, and saves the result; the
// extension collects it from Firestore the next time it opens.
//
// It acts with the user's own Firebase ID token, which the existing Firestore
// rules already allow (users may read and write their own document), so no new
// admin credentials or rule changes are needed.
//
// Mounted additively from server.js:
//     const registerGenerateV2 = require('./generateV2');
//     registerGenerateV2(app);
// The legacy POST /generate route is untouched, so installs of older extension
// versions keep working.

const COSTS = { resume: 35, coverletter: 25, optimizer: 20, outreach: 10 };
const FREE_CREDITS = 150;
const HISTORY_KEEP = 40;
const JOBS_KEEP = 25;

const MODE_SETTINGS = {
  resume:      { maxTokens: 3200, temperature: 0.5 },
  coverletter: { maxTokens: 1600, temperature: 0.7 },
  outreach:    { maxTokens: 1200, temperature: 0.8 },
  optimizer:   { maxTokens: 1800, temperature: 0.6 },
};

// ---------------------------------------------------------------------------
// Firestore typed-value helpers
// ---------------------------------------------------------------------------
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = enc(x);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function dec(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = dec(x);
    return o;
  }
  return null;
}
function decDoc(doc) {
  const o = {};
  for (const [k, v] of Object.entries((doc && doc.fields) || {})) o[k] = dec(v);
  return o;
}
// Map keys used in field paths must be quoted unless they are plain identifiers.
function seg(k) { return /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + String(k).replace(/`/g, '\\`') + '`'; }

// ---------------------------------------------------------------------------
// Profile normalisation
// The website saves jobs with one `dates` string and education as school /
// degree / eduYear; the extension's older form saved startDate / endDate and a
// single `education` string. Reading the wrong names is what produced
// "? – Present" and an invented "High School Diploma or Equivalent".
// ---------------------------------------------------------------------------
function str(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }

function normalizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const skills = Array.isArray(p.skills) ? p.skills.map(str).filter(Boolean).join(', ') : str(p.skills);

  const jobs = (Array.isArray(p.jobs) ? p.jobs : []).map((j) => {
    j = j || {};
    const start = str(j.startDate || j.start);
    const end = str(j.endDate || j.end);
    let dates = str(j.dates);
    if (!dates && (start || end)) dates = start ? `${start} – ${end || 'Present'}` : end;
    dates = dates.replace(/\?/g, '').replace(/^\s*[–-]\s*|\s*[–-]\s*$/g, '').trim();
    return { title: str(j.title), company: str(j.company), dates, description: String(j.description || '').trim() };
  }).filter((j) => j.title || j.company || j.description);

  const education = [];
  if (Array.isArray(p.education)) {
    for (const e of p.education) {
      if (!e) continue;
      if (typeof e === 'string') { if (str(e)) education.push({ text: str(e) }); continue; }
      const item = { degree: str(e.degree || e.program), school: str(e.school), year: str(e.year) };
      if (item.degree || item.school) education.push(item);
    }
  } else if (str(p.education)) {
    education.push({ text: str(p.education) });
  }
  if (str(p.school) || str(p.degree)) {
    education.unshift({ degree: str(p.degree), school: str(p.school), year: str(p.eduYear) });
  }

  return {
    name: str(p.name || p.fullName),
    email: str(p.email),
    phone: str(p.phone),
    location: str(p.location),
    linkedin: str(p.linkedin || p.links),
    headline: str(p.headline),
    skills,
    jobs,
    education,
    certifications: str(p.certifications),
    languages: str(p.languages),
    achievements: str(p.achievements),
    extra: str(p.extra),
    availability: str(p.availability),
  };
}

function readiness(mode, profile) {
  const missing = [];
  if (mode === 'resume' || mode === 'coverletter') {
    if (!profile.name) missing.push('your name');
    if (!profile.jobs.some((j) => j.title || j.company)) missing.push('at least one job or role');
  }
  return missing;
}

function sanitizePage(pd) {
  pd = pd && typeof pd === 'object' ? pd : {};
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, 12).map((x) => s(x, n)) : []);
  return {
    isJobPosting: !!pd.isJobPosting,
    jobTitle: s(pd.jobTitle, 200).trim(),
    jobCompany: s(pd.jobCompany, 200).trim(),
    jobDescription: s(pd.jobDescription, 7000).trim(),
    name: s(pd.name, 200).trim(),
    headline: s(pd.headline, 400).trim(),
    location: s(pd.location, 120).trim(),
    about: s(pd.about, 2600).trim(),
    experience: list(pd.experience, 450),
    education: list(pd.education, 250),
    skills: list(pd.skills, 80),
    certifications: list(pd.certifications, 200),
  };
}

// ---------------------------------------------------------------------------
// Writing rules shared by every prompt
// ---------------------------------------------------------------------------
const BANNED = [
  'leverage', 'utilize', 'spearhead', 'orchestrate', 'synergy', 'robust', 'dynamic', 'seamless',
  'cutting-edge', 'best-in-class', 'world-class', 'results-driven', 'detail-oriented',
  'attention to detail', 'team player', 'hard worker', 'go-getter', 'self-starter', 'passionate',
  'proven track record', 'fast-paced environment', 'hit the ground running', 'from day one',
  'wear many hats', 'think outside the box', 'responsible for', 'tasked with', 'assisted with',
  'helped to', 'delve', 'tapestry', 'testament to', 'landscape', 'navigate', 'unlock', 'elevate',
  'I am excited to', 'I am writing to apply', 'I believe I would be a great fit',
  'I would love the opportunity', 'align with your values', 'look no further',
];
const STYLE_RULES = `Write in plain, specific, human English. Vary sentence length. No em-dashes used as dramatic pauses. No "not only X but also Y". No stacked abstract nouns like "dedication, drive and passion". Never use these words or phrases: ${BANNED.join(', ')}.`;

function jobsBlock(profile) {
  if (!profile.jobs.length) return '(none given)';
  return profile.jobs.map((j, i) =>
    `[${i}] ${j.title || 'Role'}${j.company ? ' — ' + j.company : ''}${j.dates ? ' (' + j.dates + ')' : ''}\n` +
    `    In their own words: "${(j.description || '(no description)').replace(/"/g, "'").slice(0, 1500)}"`
  ).join('\n');
}
function educationText(profile) {
  if (!profile.education.length) return '(none given)';
  return profile.education.map((e) => e.text || [e.degree, e.school, e.year].filter(Boolean).join(', ')).join('; ');
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function resumePrompt(profile, page) {
  const system = `You are a senior resume writer. The resume you write will be sent to a real employer under the candidate's name, so every statement must be true to the candidate's own information. You tailor emphasis, order and wording to the target job. You never invent employers, job titles, dates, tools, equipment, software, certifications, degrees, numbers or responsibilities that the candidate did not give you. ${STYLE_RULES}`;
  const user = `TARGET JOB
Title: ${page.jobTitle || '(not shown)'}
Company: ${page.jobCompany || '(not shown)'}
Posting:
"""
${page.jobDescription || '(the posting text could not be read; use the title)'}
"""

CANDIDATE — these are the only facts you may use
Name: ${profile.name}
Skills they listed: ${profile.skills || '(none listed)'}
Certifications: ${profile.certifications || '(none)'}
Languages: ${profile.languages || '(none)'}
Achievements and other information: ${[profile.achievements, profile.extra].filter(Boolean).join(' | ') || '(none)'}
Education (added to the resume automatically; do not write it): ${educationText(profile)}

WORK HISTORY — refer to jobs by their number
${jobsBlock(profile)}

WRITE
1. "headline": the target job title, optionally followed by one or two of the candidate's real qualifications taken from their skills or certifications, separated by " · ". No numbers.
2. "summary": 3 to 5 sentences, 60 to 100 words. Who they are professionally, what they have actually done that matters for this posting, and what they bring. Mention the target company at most once, and only if it reads naturally. Use the fuller end of this range when the work history is short.
3. "experience": one entry for EVERY job in the work history, ordered by relevance to the posting. Each entry: {"jobIndex": <number>, "title": "...", "company": "...", "bullets": [...]}.
   - The resume must fill a full page. Give the most relevant job 5 to 7 bullets and every other job 3 to 5.
   - Each bullet is one sentence of 14 to 26 words, starting with a strong verb.
   - Build the bullets from, in order: (a) every duty the candidate mentioned, each as its own bullet; (b) how that work is normally carried out in that exact role; (c) the standard everyday duties that anyone holding that exact job title at that kind of employer performs, described plainly and without exaggeration. When the candidate's own description is short, lean on (b) and (c) so the page is full.
   - NEVER add: numbers they did not give, supervisory or management duties, promotions, awards, named software or systems, licences or certifications, or equipment that needs a licence or certification (such as a forklift) unless it appears in their skills or certifications.
   - Use the posting's vocabulary where it truly describes the work.
   - Fix obvious capitalisation or spelling in job titles and company names, but never change what a title means.
4. "skills": 10 to 14 short items: skills the candidate listed, plus skills that are part of the everyday work of a job they held. Phrase them in the posting's terms when equivalent. Most relevant first. Never add a licence, certification or named software they did not list, and never add a skill only because the posting asks for it.
5. "highlights": 0 to 3 short lines taken ONLY from their achievements and other information (for example languages or awards). Use an empty list if there is nothing.

NUMBERS: use a number or percentage only if that exact figure appears in the candidate's own text above. Otherwise describe the result in words.

Return ONLY this JSON object, with no markdown and no commentary:
{"headline":"","summary":"","experience":[{"jobIndex":0,"title":"","company":"","bullets":[""]}],"skills":[""],"highlights":[""]}`;
  return { system, user };
}

const LETTER_STYLES = {
  direct: 'Open with the single strongest reason this candidate fits the role, in the first sentence. No warm-up and no restating the job title back at them.',
  story: 'Open with one concrete moment from the candidate\'s real work history that shows the main thing this employer wants, then connect it plainly to the role. Grounded and factual, never sentimental.',
  formal: 'Use a traditional professional register with conventional structure and complete sentences. Restrained and precise without being stiff.',
};

function letterPrompt(profile, page, style) {
  const system = `You write cover letters that sound like a capable person wrote them for one specific job. Every claim must be true to the candidate's own information; never invent experience, employers, tools, credentials or numbers. ${STYLE_RULES}`;
  const user = `JOB
Title: ${page.jobTitle || '(not shown)'}
Company: ${page.jobCompany || '(not shown)'}
Posting:
"""
${page.jobDescription || '(the posting text could not be read; use the title)'}
"""

CANDIDATE — the only facts you may use
Name: ${profile.name}
Skills: ${profile.skills || '(none listed)'}
Education: ${educationText(profile)}
Certifications: ${profile.certifications || '(none)'}
Other: ${[profile.achievements, profile.extra, profile.languages].filter(Boolean).join(' | ') || '(none)'}
Work history:
${jobsBlock(profile)}

STYLE: ${LETTER_STYLES[style] || LETTER_STYLES.direct}

WRITE three or four paragraphs, 230 to 320 words in total:
- why this role, and the strongest real reason the candidate fits it;
- two or three specific requirements from the posting, each matched to something concrete the candidate actually did;
- a short close stating availability and a plain request for a conversation.
The letter must fall apart if another company's name were swapped in. Use numbers only if they appear in the candidate's own text. Do not include a greeting line or a sign-off; they are added separately.

Return ONLY this JSON object, no markdown:
{"subject":"","paragraphs":["",""]}`;
  return { system, user };
}

function outreachPrompt(profile, page, goal, goalContext) {
  const goals = {
    sales: `The sender is selling ${goalContext ? '"' + goalContext + '"' : 'a product or service'}. Connect it to something specific in the recipient's work, without a hard pitch.`,
    recruiting: 'The sender wants to recruit this person. Reference their specific experience and why it fits.',
    jobseeking: `The sender is looking for ${goalContext ? 'a "' + goalContext + '" role' : 'a role'} and wants a conversation, not a favour.`,
    networking: 'The sender wants to build a genuine professional connection. Find a real point of overlap.',
  };
  const system = `You write LinkedIn messages that get replies because they are specific, short and human. ${STYLE_RULES}`;
  const user = `RECIPIENT (from their LinkedIn page)
Name: ${page.name || '(unknown)'}
Headline: ${page.headline || ''}
Location: ${page.location || ''}
About: ${page.about || ''}
Experience: ${page.experience.join(' | ') || ''}
Skills: ${page.skills.join(', ') || ''}

SENDER
Name: ${profile.name || '(not given)'}
Current role: ${profile.jobs[0] ? [profile.jobs[0].title, profile.jobs[0].company].filter(Boolean).join(' at ') : '(not given)'}
Skills: ${profile.skills || '(not given)'}

GOAL: ${goals[goal] || goals.networking}

WRITE
- "summary": two sentences on who the recipient is and the best angle for reaching out.
- "messages": three different messages. Each must reference at least one specific, real detail from the recipient's page. Never open with "I came across your profile" or "I hope this finds you well".
  1. professional, under 110 words;
  2. warm and conversational, under 110 words;
  3. direct, under 280 characters so it fits a LinkedIn connection note.

Return ONLY this JSON object, no markdown:
{"summary":"","messages":["","",""]}`;
  return { system, user };
}

function optimizerPrompt(page) {
  const system = `You rewrite LinkedIn profiles so they are specific, searchable and credible. Keep every fact true to the profile text; never invent employers, titles, numbers or credentials. ${STYLE_RULES}`;
  const user = `CURRENT PROFILE
Name: ${page.name || ''}
Headline: ${page.headline || ''}
About: ${page.about || '(empty)'}
Experience: ${page.experience.join(' | ') || '(none)'}
Education: ${page.education.join(' | ') || '(none)'}
Skills: ${page.skills.join(', ') || '(none)'}

WRITE
- "headline": under 220 characters, specific and keyword-rich, no buzzwords.
- "about": first person, 180 to 300 words, with a strong specific first line.
- "experienceBullets": three rewritten experience bullets that lead with outcomes. Use numbers only if they appear in the profile text above.

Return ONLY this JSON object, no markdown:
{"headline":"","about":"","experienceBullets":["","",""]}`;
  return { system, user };
}

// ---------------------------------------------------------------------------
// Output guards
// ---------------------------------------------------------------------------
function numbersIn(text) {
  const out = new Set();
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = parseFloat(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(String(n));
  }
  return out;
}
function profileNumbers(profile) {
  const parts = [profile.skills, profile.certifications, profile.languages, profile.achievements, profile.extra,
    profile.availability, educationText(profile), ...profile.jobs.map((j) => [j.title, j.company, j.dates, j.description].join(' '))];
  return numbersIn(parts.join(' '));
}
function unsupported(text, allowed) {
  for (const n of numbersIn(text)) if (!allowed.has(n)) return true;
  return false;
}
function clean(t) {
  return String(t == null ? '' : t)
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}
function cleanHeadline(h, page, profile) {
  const parts = String(h || '').split(/\s*[|·•]\s*/).map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/\d|%/.test(x)).slice(0, 3);
  if (parts.length) return parts.join(' · ');
  return page.jobTitle || (profile.jobs[0] && profile.jobs[0].title) || '';
}
function matchJob(entry, jobs) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const c = norm(entry.company); const t = norm(entry.title);
  let best = -1; let score = 0;
  jobs.forEach((j, i) => {
    let s = 0;
    if (c && norm(j.company) && (norm(j.company).includes(c) || c.includes(norm(j.company)))) s += 2;
    if (t && norm(j.title) && (norm(j.title).includes(t) || t.includes(norm(j.title)))) s += 1;
    if (s > score) { score = s; best = i; }
  });
  return best;
}
function editDistance(a, b) {
  const m = a.length; const n = b.length;
  if (Math.abs(m - n) > 6) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[m][n];
}
// The model may fix spelling or capitalisation ("mcdonalds" -> "McDonald's") but
// may not rename a job ("Delivery Driver" -> "Logistics Specialist").
function keepTrueName(modelValue, profileValue) {
  const mv = clean(modelValue); const pv = clean(profileValue);
  if (!pv) return mv;
  if (!mv) return pv;
  const key = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const a = key(mv); const b = key(pv);
  if (a === b || editDistance(a, b) <= Math.max(2, Math.floor(b.length * 0.15))) return mv;
  return pv;
}
function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
function sentences(text) { return String(text || '').match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || []; }

// Deterministic assembly: contact details, dates, education, certifications and
// languages always come from the profile, never from the model, so none of them
// can be invented.
function finalizeResume(raw, profile, page) {
  const experience = [];
  const used = new Set();
  for (const e of Array.isArray(raw.experience) ? raw.experience : []) {
    let idx = Number.isInteger(e && e.jobIndex) ? e.jobIndex : -1;
    if (!profile.jobs[idx]) idx = matchJob(e || {}, profile.jobs);
    const pj = profile.jobs[idx];
    if (!pj || used.has(idx)) continue; // drops any job the model invented
    used.add(idx);
    const bullets = (Array.isArray(e.bullets) ? e.bullets : []).map(clean).filter((b) => b.length > 12).slice(0, 7);
    experience.push({ title: keepTrueName(e.title, pj.title), company: keepTrueName(e.company, pj.company), duration: pj.dates, bullets });
  }
  profile.jobs.forEach((pj, i) => {
    if (!used.has(i)) experience.push({ title: pj.title, company: pj.company, duration: pj.dates, bullets: [] });
  });

  return {
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    linkedin: profile.linkedin,
    headline: cleanHeadline(raw.headline, page, profile),
    summary: clean(raw.summary),
    experience,
    skills: dedupe((Array.isArray(raw.skills) ? raw.skills : []).map(clean).filter(Boolean)).slice(0, 14),
    education: profile.education,
    certifications: profile.certifications,
    languages: profile.languages,
    highlights: (Array.isArray(raw.highlights) ? raw.highlights : []).map(clean).filter(Boolean).slice(0, 3),
  };
}

function finalizeLetter(raw, profile, page) {
  const paragraphs = (Array.isArray(raw.paragraphs) ? raw.paragraphs : []).map(clean).filter(Boolean).slice(0, 4);
  const company = page.jobCompany || '';
  const greeting = company ? `Dear Hiring Team at ${company},` : 'Dear Hiring Manager,';
  const closing = ['Sincerely,', profile.name, profile.phone, profile.email].filter(Boolean).join('\n');
  const subject = clean(raw.subject) || `Application for ${page.jobTitle || 'the role'}${profile.name ? ' — ' + profile.name : ''}`;
  return {
    subject, greeting, paragraphs, closing,
    paragraph1: paragraphs[0] || '', paragraph2: paragraphs[1] || '', paragraph3: paragraphs.slice(2).join('\n\n'),
    letter: [greeting, ...paragraphs, closing].join('\n\n'),
    sender: { name: profile.name, email: profile.email, phone: profile.phone, location: profile.location },
  };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------
class PublicError extends Error {
  constructor(msg, status = 502) { super(msg); this.publicMessage = msg; this.status = status; }
}

function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || global.fetch || require('node-fetch');
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  const API_KEY = env.FIREBASE_API_KEY;
  const PROJECT = env.FIREBASE_PROJECT_ID || 'linkedai-ff45f';
  const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
  const MODEL = env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  const iso = () => new Date(now()).toISOString();
  const reply = (status, json) => ({ status, json });

  async function lookup(idToken) {
    const r = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.users && d.users[0]) || null;
  }

  async function getDoc(uid, token) {
    const r = await fetchImpl(`${FIRESTORE}/users/${uid}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return null;
    if (!r.ok) throw new PublicError('Could not load your account. Please try again.', 503);
    return r.json();
  }

  async function patch(uid, token, fields, masks, precondition) {
    const q = masks.map((m) => 'updateMask.fieldPaths=' + encodeURIComponent(m));
    if (precondition) q.push('currentDocument.updateTime=' + encodeURIComponent(precondition));
    return fetchImpl(`${FIRESTORE}/users/${uid}?${q.join('&')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }),
    });
  }

  function balanceOf(d) {
    if (typeof d.credits === 'number' && Number.isFinite(d.credits)) return d.credits;
    return Math.max(0, FREE_CREDITS - (Number(d.generationsUsed) || 0) * 30);
  }

  async function claude(system, user, settings, extraMessages) {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new PublicError('The AI is not configured on the server yet.', 500);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 110000) : null;
    try {
      const messages = [{ role: 'user', content: user }].concat(extraMessages || []);
      const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: settings.maxTokens, temperature: settings.temperature, system, messages }),
        signal: ctl ? ctl.signal : undefined,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        log.error('anthropic error', r.status, String(t).slice(0, 300));
        if (r.status === 429 || r.status === 529) throw new PublicError('The AI is busy right now. Please try again in a minute. You were not charged.');
        throw new PublicError('The AI could not finish this one. Please try again. You were not charged.');
      }
      const d = await r.json();
      return (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    } catch (e) {
      if (e instanceof PublicError) throw e;
      log.error('anthropic call failed', e && e.message);
      throw new PublicError('The AI took too long to respond. Please try again. You were not charged.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function parseJson(text) {
    const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  async function claudeJson(prompt, settings) {
    const text = await claude(prompt.system, prompt.user, settings);
    let obj = parseJson(text);
    if (!obj) {
      const retry = await claude(prompt.system, prompt.user, settings, [
        { role: 'assistant', content: String(text || '').slice(0, 8000) || '{}' },
        { role: 'user', content: 'That was not a valid JSON object. Return only the JSON object, nothing else.' },
      ]);
      obj = parseJson(retry);
    }
    if (!obj) throw new PublicError('The AI returned something unreadable. Please try again. You were not charged.');
    return obj;
  }

  // Rewrites only the sentences that contain a number the candidate never gave,
  // and tells the model exactly which numbers to remove so real ones survive.
  async function repairNumbers(items, allowed) {
    const bad = items
      .filter((it) => it.text && unsupported(it.text, allowed))
      .map((it) => Object.assign(it, { remove: [...numbersIn(it.text)].filter((n) => !allowed.has(n)) }));
    if (!bad.length) return;
    try {
      const prompt = {
        system: 'You edit resume and cover letter sentences. You remove specific numbers that the candidate never provided, rephrasing so the sentence still reads naturally. You keep every other number and fact exactly as it is, and you never add new facts.',
        user: 'For each item, rewrite "sentence" so it no longer contains any of the numbers listed in "remove". Keep all other numbers and details unchanged. Return ONLY a JSON object {"sentences":[...]} with one rewritten sentence per item, in the same order.\n' +
          JSON.stringify(bad.map((b) => ({ sentence: b.text, remove: b.remove }))),
      };
      const out = await claudeJson(prompt, { maxTokens: 900, temperature: 0.2 });
      const fixed = Array.isArray(out.sentences) ? out.sentences : [];
      bad.forEach((b, i) => {
        const f = typeof fixed[i] === 'string' ? clean(fixed[i]) : '';
        b.set(f && !unsupported(f, allowed) ? f : null);
      });
    } catch (e) {
      bad.forEach((b) => b.set(null));
    }
  }

  async function generate(mode, profile, page, body) {
    const settings = MODE_SETTINGS[mode];
    if (mode === 'resume') {
      const raw = await claudeJson(resumePrompt(profile, page), settings);
      const res = finalizeResume(raw, profile, page);
      const allowed = profileNumbers(profile);
      const items = [];
      res.experience.forEach((e) => e.bullets.forEach((b, i) => items.push({ text: b, set: (v) => { e.bullets[i] = v; } })));
      items.push({ text: res.summary, set: (v) => { res.summary = v || res.summary.split(/(?<=[.!?])\s+/).filter((s) => !unsupported(s, allowed)).join(' '); } });
      res.highlights.forEach((h, i) => items.push({ text: h, set: (v) => { res.highlights[i] = v; } }));
      await repairNumbers(items, allowed);
      res.experience.forEach((e) => { e.bullets = e.bullets.filter(Boolean); });
      res.highlights = res.highlights.filter(Boolean);
      return { type: 'resume', data: res };
    }
    if (mode === 'coverletter') {
      const style = LETTER_STYLES[body.template] ? body.template : 'direct';
      const raw = await claudeJson(letterPrompt(profile, page, style), settings);
      const allowed = profileNumbers(profile);
      for (const n of numbersIn(page.jobDescription)) allowed.add(n); // quoting the posting is fine in a letter
      const paras = (Array.isArray(raw.paragraphs) ? raw.paragraphs : []).map(clean);
      const items = paras.map((p, i) => ({ text: p, set: (v) => { paras[i] = v || sentences(p).filter((s) => !unsupported(s, allowed)).join(' ').trim(); } }));
      await repairNumbers(items, allowed);
      raw.paragraphs = paras.filter(Boolean);
      return { type: 'coverletter', data: finalizeLetter(raw, profile, page) };
    }
    if (mode === 'optimizer') {
      const raw = await claudeJson(optimizerPrompt(page), settings);
      return { type: 'optimizer', data: {
        headline: clean(raw.headline).slice(0, 220),
        about: String(raw.about || '').trim(),
        experienceBullets: (Array.isArray(raw.experienceBullets) ? raw.experienceBullets : []).map(clean).filter(Boolean).slice(0, 5),
      } };
    }
    const raw = await claudeJson(outreachPrompt(profile, page, body.goal, clean(body.goalContext).slice(0, 200)), settings);
    return {
      summary: clean(raw.summary),
      messages: (Array.isArray(raw.messages) ? raw.messages : []).map((m) => String(m || '').trim()).filter(Boolean).slice(0, 3),
    };
  }

  // Deduct the credits and save the result in ONE write, guarded by the
  // document's updateTime so a concurrent spend elsewhere cannot be lost.
  async function commit(uid, token, jobId, cost, entry) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await getDoc(uid, token);
      if (!raw) return { ok: false };
      const d = decDoc(raw);
      const next = Math.max(0, balanceOf(d) - cost);
      const history = d.history && typeof d.history === 'object' ? d.history : {};
      const jobs = d.jobs && typeof d.jobs === 'object' ? d.jobs : {};
      const byAge = (m) => Object.keys(m).filter((k) => k !== jobId)
        .sort((a, b) => String((m[b] && m[b].at) || '').localeCompare(String((m[a] && m[a].at) || '')));
      const dropHistory = byAge(history).slice(HISTORY_KEEP - 1);
      const dropJobs = byAge(jobs).slice(JOBS_KEEP - 1);
      const masks = ['credits', `history.${seg(jobId)}`, `jobs.${seg(jobId)}`]
        .concat(dropHistory.map((k) => `history.${seg(k)}`), dropJobs.map((k) => `jobs.${seg(k)}`));
      const fields = {
        credits: { integerValue: String(next) },
        history: { mapValue: { fields: { [jobId]: enc(entry) } } },
        jobs: { mapValue: { fields: { [jobId]: enc({ status: 'done', mode: entry.mode, at: entry.at, balance: next }) } } },
      };
      const r = await patch(uid, token, fields, masks, raw.updateTime);
      if (r.ok) return { ok: true, balance: next };
      const t = await r.text().catch(() => '');
      if (!(r.status === 400 || r.status === 409) || !/FAILED_PRECONDITION|ABORTED|version/i.test(t)) {
        log.error('commit failed', r.status, String(t).slice(0, 200));
        return { ok: false };
      }
    }
    return { ok: false };
  }

  return async function handle(body, authHeader) {
    body = body && typeof body === 'object' ? body : {};
    const idToken = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!idToken) return reply(401, { error: 'Please sign in again.' });

    const who = await lookup(idToken).catch(() => null);
    if (!who || !who.localId) return reply(401, { error: 'Your session expired. Close and reopen the extension.' });
    const uid = who.localId;

    const jobId = String(body.jobId || '');
    const mode = String(body.mode || '');
    if (!/^j[a-z0-9]{6,40}$/i.test(jobId)) return reply(400, { error: 'Bad request.' });
    if (!COSTS[mode]) return reply(400, { error: 'Unknown mode.' });

    let raw;
    try { raw = await getDoc(uid, idToken); } catch (e) { return reply(503, { error: e.publicMessage || 'Please try again.' }); }
    if (!raw) return reply(404, { error: 'Your account is not set up yet. Close and reopen the extension.' });
    const d = decDoc(raw);

    // Idempotent: the same job id never runs or charges twice.
    const prior = d.jobs && d.jobs[jobId];
    const priorEntry = d.history && d.history[jobId];
    if (prior && prior.status === 'done' && priorEntry) {
      return reply(200, { status: 'done', jobId, results: priorEntry.results, balance: balanceOf(d), repeat: true });
    }
    if (prior && prior.status === 'running' && now() - Date.parse(prior.at || 0) < 180000) {
      return reply(409, { status: 'running', jobId });
    }

    const profile = normalizeProfile(d.profile && Object.keys(d.profile).length ? d.profile : body.profileFallback);
    const missing = readiness(mode, profile);
    if (missing.length) return reply(422, { error: 'profile_incomplete', missing, message: `Add ${missing.join(' and ')} to your profile first. You were not charged.` });

    const page = sanitizePage(body.pageData);
    if ((mode === 'resume' || mode === 'coverletter') && !page.jobTitle && !page.jobDescription) {
      return reply(422, { error: 'no_job', message: 'Could not read the job posting. Open the job on LinkedIn and try again. You were not charged.' });
    }
    if ((mode === 'outreach' || mode === 'optimizer') && !page.name && !page.headline) {
      return reply(422, { error: 'no_profile', message: 'Could not read this LinkedIn page. Open a profile and try again. You were not charged.' });
    }

    const cost = COSTS[mode];
    const balance = balanceOf(d);
    if (balance < cost) return reply(402, { error: 'insufficient', needed: cost, balance, shortfall: cost - balance });

    await patch(uid, idToken, { jobs: { mapValue: { fields: { [jobId]: enc({ status: 'running', mode, at: iso() }) } } } }, [`jobs.${seg(jobId)}`]).catch(() => null);

    let results;
    try {
      results = await generate(mode, profile, page, body);
    } catch (e) {
      const msg = (e && e.publicMessage) || 'Something went wrong. Please try again. You were not charged.';
      if (!(e && e.publicMessage)) log.error('generate failed', e);
      await patch(uid, idToken, { jobs: { mapValue: { fields: { [jobId]: enc({ status: 'error', mode, at: iso(), error: msg }) } } } }, [`jobs.${seg(jobId)}`]).catch(() => null);
      return reply(502, { status: 'error', error: msg });
    }

    const context = (mode === 'resume' || mode === 'coverletter')
      ? [page.jobTitle, page.jobCompany].filter(Boolean).join(' at ')
      : page.name || page.headline || '';
    const entry = { id: jobId, mode, context: context.slice(0, 120), results, at: iso(), template: body.template || null, pageName: page.name || '' };

    const committed = await commit(uid, idToken, jobId, cost, entry).catch((e) => { log.error('commit threw', e); return { ok: false }; });
    if (!committed.ok) {
      log.error('delivered without charging (commit failed)', uid, jobId);
      return reply(200, { status: 'done', jobId, results, balance, uncharged: true });
    }
    return reply(200, { status: 'done', jobId, results, balance: committed.balance });
  };
}

function registerGenerateV2(app, deps = {}) {
  const express = deps.express || require('express');
  const handle = createHandler(deps);
  app.post('/v2/generate', express.json({ limit: '1mb' }), async (req, res) => {
    // A client that disconnects must not stop this work: the result is saved to
    // Firestore so the extension can collect it later.
    try {
      const out = await handle(req.body || {}, req.headers.authorization || '');
      if (!res.headersSent) res.status(out.status).json(out.json);
    } catch (e) {
      console.error('v2/generate crashed', e);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. You were not charged.' });
    }
  });
  app.get('/v2/health', (req, res) => res.json({ ok: true, generate: 'v2' }));
}

module.exports = registerGenerateV2;
module.exports.registerGenerateV2 = registerGenerateV2;
module.exports.createHandler = createHandler;
module.exports.normalizeProfile = normalizeProfile;
module.exports.finalizeResume = finalizeResume;
module.exports.sanitizePage = sanitizePage;
module.exports._internal = { keepTrueName, numbersIn, profileNumbers, cleanHeadline, enc, dec, resumePrompt, letterPrompt, outreachPrompt, optimizerPrompt };
