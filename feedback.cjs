// feedback.cjs — POST /api/feedback for the LinkedAI "Contact us" page.
//
// Self-contained Express router: it does its own CORS, body parsing and rate
// limiting, so it behaves the same no matter how the rest of the server is set
// up. Mount it right after `const app = express();` in the main server file:
//
//   CommonJS:  app.use(require('./feedback.cjs'));
//   ES module: import feedbackRouter from './feedback.cjs';  ...  app.use(feedbackRouter);
//
// Saves to Firestore the same way server.js does: a service-account token from
// FIREBASE_SERVICE_ACCOUNT (google-auth-library) and the Firestore REST API.
// Emails through Gmail SMTP (nodemailer) with GMAIL_USER, GMAIL_APP_PASSWORD
// and FEEDBACK_TO_EMAIL. No env var value is ever logged.

const express = require('express');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const { JWT } = require('google-auth-library');

const router = express.Router();

const ALLOWED_ORIGINS = [
  'https://linkedai-ff45f.web.app',
  'https://linkedai-ff45f.firebaseapp.com',
];

const TOPICS = [
  "Something's not working",
  'Idea or feature request',
  'Billing or account',
  'Other',
];

// ---------- CORS (only for this route) ----------
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(origin && ALLOWED_ORIGINS.includes(origin) ? 204 : 403);
  }
  // Browsers always send Origin on a cross-site POST. Anything else is refused.
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ ok: false, error: 'This form only accepts messages from the LinkedAI website.' });
  }
  next();
}

// ---------- Rate limit: 5 per IP per hour, in memory ----------
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map(); // ip -> [timestamps]

function clientIp(req) {
  // Render sits behind a proxy; the first X-Forwarded-For entry is the visitor.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// Drop stale entries so the map does not grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    const recent = times.filter((t) => now - t < WINDOW_MS);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- Validation ----------
function clean(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')                                   // strip HTML tags
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // control chars
    .trim();
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;

function validate(body) {
  const name = clean(body.name).replace(/\s+/g, ' ');
  const email = clean(body.email).toLowerCase();
  const topic = clean(body.topic);
  const message = clean(body.message);
  const rawSource = clean(body.source).toLowerCase();
  const source = /^[a-z0-9_-]{1,30}$/.test(rawSource) ? rawSource : 'website';

  if (name.length < 1 || name.length > 100) {
    return { error: 'Please enter your name (up to 100 characters).', field: 'name' };
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return { error: 'Please enter a valid email address so I can reply.', field: 'email' };
  }
  if (!TOPICS.includes(topic)) {
    return { error: 'Please pick a topic from the list.', field: 'topic' };
  }
  if (message.length < 10 || message.length > 3000) {
    return { error: 'Your message needs to be between 10 and 3000 characters.', field: 'message' };
  }
  return { data: { name, email, topic, message, source } };
}

// ---------- Firestore (service account + REST, same as server.js) ----------
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'linkedai-ff45f';
const FEEDBACK_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/feedback`;

let svcClient = null;
let cachedToken = null;
let cachedExpiry = 0;

async function getFirestoreToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60000) return cachedToken;
  if (!svcClient) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    const sa = JSON.parse(raw);
    svcClient = new JWT({
      email: sa.client_email,
      key: String(sa.private_key || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/datastore'],
    });
  }
  const res = await svcClient.getAccessToken();
  const token = typeof res === 'string' ? res : res && res.token;
  if (!token) throw new Error('Failed to mint Firestore access token');
  cachedToken = token;
  cachedExpiry = (svcClient.credentials && svcClient.credentials.expiry_date) || now + 3300000;
  return token;
}

async function saveFeedback(entry) {
  const token = await getFirestoreToken();
  const fields = {
    name: { stringValue: entry.name },
    email: { stringValue: entry.email },
    topic: { stringValue: entry.topic },
    message: { stringValue: entry.message },
    source: { stringValue: entry.source },
    userAgent: { stringValue: entry.userAgent },
    createdAt: { timestampValue: new Date().toISOString() },
  };
  const r = await fetch(FEEDBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw new Error(`Firestore returned ${r.status}: ${detail}`);
  }
  const doc = await r.json();
  return String(doc.name || '').split('/').pop();
}

// ---------- Email ----------
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass || !process.env.FEEDBACK_TO_EMAIL) {
    throw new Error('Email is not configured: GMAIL_USER, GMAIL_APP_PASSWORD or FEEDBACK_TO_EMAIL is missing.');
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    // Fail fast instead of hanging the request if SMTP is unreachable.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendFeedbackEmail(entry) {
  const time = new Date().toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const text = [
    `Name:   ${entry.name}`,
    `Email:  ${entry.email}`,
    `Topic:  ${entry.topic}`,
    `Source: ${entry.source}`,
    `Time:   ${time} (Toronto)`,
    '',
    'Message:',
    entry.message,
    '',
    '— Hit Reply to answer them directly.',
  ].join('\n');

  const row = (label, value) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#666;vertical-align:top">${label}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
      <table style="border-collapse:collapse">
        ${row('Name', entry.name)}
        ${row('Email', entry.email)}
        ${row('Topic', entry.topic)}
        ${row('Source', entry.source)}
        ${row('Time', `${time} (Toronto)`)}
      </table>
      <p style="margin:18px 0 6px;color:#666">Message:</p>
      <div style="white-space:pre-wrap;line-height:1.5;border-left:3px solid #6D5BFF;padding-left:12px">${escapeHtml(entry.message)}</div>
      <p style="margin-top:18px;color:#888;font-size:12px">Hit Reply to answer them directly.</p>
    </div>`;

  await getTransporter().sendMail({
    from: { name: 'LinkedAI Feedback', address: process.env.GMAIL_USER },
    to: process.env.FEEDBACK_TO_EMAIL,
    replyTo: { name: entry.name, address: entry.email },
    subject: `[LinkedAI] ${entry.topic} — from ${entry.name}`,
    text,
    html,
  });
}

// ---------- Route ----------
router.options('/api/feedback', cors);

router.post('/api/feedback', cors, express.json({ limit: '20kb' }), async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const ip = clientIp(req);

  if (rateLimited(ip)) {
    return res.status(429).json({
      ok: false,
      error: "You've sent a few messages already — please wait an hour and try again.",
    });
  }

  // Honeypot: real people never see the "website" field. Pretend it worked.
  if (clean(body.website)) {
    console.log('[feedback] honeypot triggered, ignoring submission');
    return res.status(200).json({ ok: true });
  }

  const result = validate(body);
  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error, field: result.field });
  }

  const entry = {
    ...result.data,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
  };

  let saved = false;
  let emailed = false;

  try {
    const id = await saveFeedback(entry);
    saved = true;
    console.log(`[feedback] saved ${id} (topic: ${entry.topic}, source: ${entry.source})`);
  } catch (err) {
    console.error('[feedback] Firestore save failed:', err && err.message ? err.message : err);
  }

  try {
    await sendFeedbackEmail(entry);
    emailed = true;
    console.log('[feedback] email sent');
  } catch (err) {
    console.error('[feedback] email failed:', err && err.message ? err.message : err);
  }

  // Success as long as the message reached Omar one way or the other, so the
  // visitor never has to resend something that was already received.
  if (saved || emailed) {
    return res.status(200).json({ ok: true });
  }
  return res.status(500).json({
    ok: false,
    error: "Sorry — your message couldn't be sent right now. Please try again in a minute.",
  });
});

module.exports = router;
