const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');const { JWT } = require('google-auth-library');

const app = express();

// ---- CONFIG ----
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID;
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---- CORS ----
// The extension calls this backend from a chrome-extension:// origin, which the
// browser treats as cross-origin, so these headers are required.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- FIREBASE HELPERS ----
// Sign in as admin using Firebase REST API with a service email/password

async function getFirebaseAdminToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.FIREBASE_ADMIN_EMAIL,
        password: process.env.FIREBASE_ADMIN_PASSWORD,
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('Firebase admin auth failed: ' + data.error.message);
  return data.idToken;
}

async function upgradeUserToPro(email, plan) {
  const token = await getFirebaseAdminToken();
  const targetPlan = plan || 'pro';

  // Credits granted per plan. Must match the extension's PLANS object.
  const PLAN_CREDITS = { free: 150, lite: 600, pro: 1600, power: 4000 };
  const credits = PLAN_CREDITS[targetPlan] || PLAN_CREDITS.pro;

  const queryRes = await fetch(`${FIRESTORE_URL}:runQuery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'email' },
            op: 'EQUAL',
            value: { stringValue: email },
          },
        },
        limit: 1,
      },
    }),
  });

  const queryData = await queryRes.json();
  const doc = queryData[0]?.document;

  if (!doc) {
    console.log(`No user found for email: ${email} — storing pending upgrade`);
    await fetch(`${FIRESTORE_URL}/pendingUpgrades/${encodeEmail(email)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fields: {
          email: { stringValue: email },
          plan: { stringValue: targetPlan },
          credits: { integerValue: String(credits) },
          createdAt: { stringValue: new Date().toISOString() },
        },
      }),
    });
    return;
  }

  // Add the new credits on top of whatever the user already had, so buying a
  // plan never wipes out credits they already paid for.
  const existing = parseInt(doc.fields?.credits?.integerValue || '0', 10) || 0;
  const newBalance = existing + credits;

  const docPath = doc.name;
  const updateRes = await fetch(
    `${docPath}?updateMask.fieldPaths=plan&updateMask.fieldPaths=credits&updateMask.fieldPaths=updatedAt`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fields: {
          plan: { stringValue: targetPlan },
          credits: { integerValue: String(newBalance) },
          updatedAt: { stringValue: new Date().toISOString() },
        },
      }),
    }
  );

  if (updateRes.ok) {
    console.log(`Upgraded ${email} to ${targetPlan} (+${credits} credits, now ${newBalance})`);
  } else {
    const err = await updateRes.json();
    console.error('Failed to upgrade user:', err);
  }
}

async function grantCredits(email, amount, label) {
  const token = await getFirebaseAdminToken();
  const queryRes = await fetch(`${FIRESTORE_URL}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
        limit: 1,
      },
    }),
  });
  const queryData = await queryRes.json();
  const doc = queryData[0]?.document;
  if (!doc) {
    console.warn('No user found to credit:', email);
    return;
  }
  const existing = parseInt(doc.fields?.credits?.integerValue || '0', 10) || 0;
  const next = existing + amount;
  await fetch(`${doc.name}?updateMask.fieldPaths=credits&updateMask.fieldPaths=updatedAt`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: {
        credits: { integerValue: String(next) },
        updatedAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  console.log(`${label}: +${amount} credits for ${email}, now ${next}`);
}

async function downgradeUserToFree(email) {
  const token = await getFirebaseAdminToken();
  const queryRes = await fetch(`${FIRESTORE_URL}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'email' },
            op: 'EQUAL',
            value: { stringValue: email },
          },
        },
        limit: 1,
      },
    }),
  });
  const queryData = await queryRes.json();
  const doc = queryData[0]?.document;
  if (!doc) return;

  // Drop them to free but leave existing credits alone — they paid for those.
  await fetch(`${doc.name}?updateMask.fieldPaths=plan`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { plan: { stringValue: 'free' } } }),
  });
  console.log(`Downgraded ${email} to Free`);
}

function encodeEmail(email) {
  return email.replace(/[@.]/g, '_');
}

// ---- STRIPE WEBHOOK ----
// Must come before express.json() because Stripe needs the raw body.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  if (STRIPE_WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      return res.status(400).send('Webhook Error');
    }
  } else {
    event = JSON.parse(req.body);
  }

  console.log('Event:', event.type);

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.payment_succeeded') {
      const obj = event.data.object;
      const email = obj.customer_email || obj.customer_details?.email;
      // The extension appends ?plan=lite|pro|power to the Stripe link.
      const meta = obj.metadata || {};
      const explicitCredits = parseInt(meta.credits || '0', 10);
      if (meta.kind === 'topup' && email && explicitCredits > 0) {
        // A top-up adds credits without changing the plan.
        await grantCredits(email, explicitCredits, 'Credit top-up');
      } else if (email) {
        await upgradeUserToPro(email, meta.plan || 'pro');
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const customer = await stripe.customers.retrieve(event.data.object.customer);
      if (customer.email) await downgradeUserToFree(customer.email);
    }
  } catch (err) {
    console.error('Error handling event:', err);
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));

// ---- AI GENERATION ----
// The Anthropic key lives here and never leaves the server. It used to be
// hardcoded inside the extension, where anyone who installed it could unzip the
// bundle and read it.
app.post('/generate', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set');
      return res.status(500).json({ error: 'Server is not configured for AI yet.' });
    }

    const { prompt, maxTokens } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'Missing or invalid prompt' });
    }

    // Only signed-in users get to spend our API budget.
    const idToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!idToken) {
      return res.status(401).json({ error: 'Please sign in and try again.' });
    }

    // Confirm the token is real rather than trusting any string the client sends.
    const verify = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!verify.ok) {
      return res.status(401).json({ error: 'Your session expired. Please sign out and back in.' });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(Number(maxTokens) || 1500, 4000),
        messages: [{ role: 'user', content: prompt.slice(0, 20000) }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic error:', anthropicRes.status, errText.slice(0, 300));
      if (anthropicRes.status === 429) {
        return res.status(429).json({ error: 'The AI is busy right now. Try again in a moment.' });
      }
      if (anthropicRes.status === 401) {
        return res.status(500).json({ error: 'Server AI credentials are invalid.' });
      }
      return res.status(502).json({ error: 'Could not generate right now. Please try again.' });
    }

    const data = await anthropicRes.json();
    const text = data.content?.[0]?.text || '';
    if (!text) {
      return res.status(502).json({ error: 'The AI returned nothing. Please try again.' });
    }

    res.json({ text });
  } catch (err) {
    console.error('generate error:', err);
    res.status(500).json({ error: 'Could not generate right now. Please try again.' });
  }
});


// ---- CHECKOUT ----
// Creates a Stripe Checkout Session on demand. No payment links, no products to
// maintain: change a price here and it takes effect immediately.
const PLAN_PRICES = {
  lite:  { name: 'LinkedAI Lite',  amount: 499,  credits: 600 },
  pro:   { name: 'LinkedAI Pro',   amount: 999,  credits: 1600 },
  power: { name: 'LinkedAI Power', amount: 1999, credits: 4000 },
};

const TOPUP_PRICES = {
  tp_1: { credits: 200,  bonus: 0,   amount: 199 },
  tp_2: { credits: 600,  bonus: 50,  amount: 499 },
  tp_3: { credits: 1400, bonus: 200, amount: 999 },
  tp_4: { credits: 3000, bonus: 600, amount: 1999 },
};

app.post('/checkout', async (req, res) => {
  try {
    const { kind, id, origin } = req.body || {};
    const site = origin || 'https://linkedai-ff45f.web.app';

    const idToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!idToken) return res.status(401).json({ error: 'Please sign in first.' });

    // Confirm the token is real and find out who is buying.
    const lookup = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!lookup.ok) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });

    const info = await lookup.json();
    const user = info.users?.[0];
    if (!user) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });

    const email = user.email;
    const uid = user.localId;

    // Reuse the Stripe customer so a person does not accumulate duplicates.
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length
      ? existing.data[0]
      : await stripe.customers.create({ email, metadata: { uid } });

    if (kind === 'topup') {
      const pack = TOPUP_PRICES[id];
      if (!pack) return res.status(400).json({ error: 'Unknown credit pack.' });
      const total = pack.credits + pack.bonus;

      const session = await stripe.checkout.sessions.create({
        customer: customer.id,
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${total.toLocaleString()} LinkedAI credits`,
              description: pack.bonus
                ? `${pack.credits.toLocaleString()} credits plus ${pack.bonus.toLocaleString()} bonus. Credits never expire.`
                : 'Credits never expire.',
            },
            unit_amount: pack.amount,
          },
          quantity: 1,
        }],
        success_url: `${site}/pricing.html?purchase=success`,
        cancel_url: `${site}/pricing.html?purchase=cancelled`,
        client_reference_id: uid,
        metadata: { uid, email, kind: 'topup', credits: String(total) },
      });

      return res.json({ url: session.url });
    }

    const plan = PLAN_PRICES[id];
    if (!plan) return res.status(400).json({ error: 'Unknown plan.' });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: plan.name,
            description: `${plan.credits.toLocaleString()} credits every month.`,
          },
          unit_amount: plan.amount,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: `${site}/pricing.html?upgrade=success`,
      cancel_url: `${site}/pricing.html?upgrade=cancelled`,
      client_reference_id: uid,
      metadata: { uid, email, kind: 'subscription', plan: id, credits: String(plan.credits) },
      subscription_data: { metadata: { uid, plan: id, credits: String(plan.credits) } },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ---- CREDITS ----
// Lets the extension pull the authoritative balance rather than trusting the
// copy it holds locally.
app.get('/credits', async (req, res) => {
  try {
    const idToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!idToken) return res.status(401).json({ error: 'Not signed in' });

    const lookup = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!lookup.ok) return res.status(401).json({ error: 'Session expired' });

    const info = await lookup.json();
    const uid = info.users?.[0]?.localId;
    if (!uid) return res.status(401).json({ error: 'Session expired' });

    const token = await getFirebaseAdminToken();
    const docRes = await fetch(`${FIRESTORE_URL}/users/${uid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!docRes.ok) return res.json({ balance: null });

    const doc = await docRes.json();
    res.json({
      balance: parseInt(doc.fields?.credits?.integerValue || '0', 10) || 0,
      plan: doc.fields?.plan?.stringValue || 'free',
    });
  } catch (err) {
    console.error('credits error:', err);
    res.status(500).json({ error: 'Could not read credits' });
  }
});

// ---- CHECK PENDING UPGRADE (called by extension) ----
app.post('/check-upgrade', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const token = await getFirebaseAdminToken();

    const pendingRes = await fetch(`${FIRESTORE_URL}/pendingUpgrades/${encodeEmail(email)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (pendingRes.ok) {
      const pending = await pendingRes.json();
      const plan = pending.fields?.plan?.stringValue;
      if (plan) {
        await upgradeUserToPro(email, plan);
        await fetch(`${FIRESTORE_URL}/pendingUpgrades/${encodeEmail(email)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.json({ upgraded: true, plan });
      }
    }

    res.json({ upgraded: false });
  } catch (err) {
    console.error('Check upgrade error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ---- HEALTH CHECK ----
app.get('/', (req, res) =>
  res.json({
    status: 'LinkedAI backend running',
    ai: ANTHROPIC_API_KEY ? 'configured' : 'MISSING ANTHROPIC_API_KEY',
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LinkedAI backend running on port ${PORT}`));
