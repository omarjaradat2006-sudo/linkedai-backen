const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

const app = express();

// ---- CONFIG ----
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID;
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// ---- FIREBASE HELPERS ----
// Sign in as admin using Firebase REST API with a service email/password
// We'll use a special Firebase Admin token approach via API key

async function getFirebaseAdminToken() {
  // Use Firebase's signInWithEmailAndPassword with a dedicated admin account
  // We'll create this account once and hardcode the credentials
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

async function upgradeUserToPro(email) {
  const token = await getFirebaseAdminToken();

  // Query Firestore for user with this email
  const queryRes = await fetch(
    `${FIRESTORE_URL}:runQuery`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
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
    }
  );

  const queryData = await queryRes.json();
  const doc = queryData[0]?.document;

  if (!doc) {
    console.log(`No user found for email: ${email} — storing pending upgrade`);
    // Store pending upgrade so extension can pick it up
    await fetch(
      `${FIRESTORE_URL}/pendingUpgrades/${encodeEmail(email)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          fields: {
            email: { stringValue: email },
            plan: { stringValue: 'pro' },
            createdAt: { stringValue: new Date().toISOString() },
          },
        }),
      }
    );
    return;
  }

  // Update user plan to pro
  const docPath = doc.name; // full resource path
  const updateRes = await fetch(
    `${docPath}?updateMask.fieldPaths=plan&updateMask.fieldPaths=updatedAt`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        fields: {
          plan: { stringValue: 'pro' },
          updatedAt: { stringValue: new Date().toISOString() },
        },
      }),
    }
  );

  if (updateRes.ok) {
    console.log(`✅ Upgraded ${email} to Pro`);
  } else {
    const err = await updateRes.json();
    console.error('Failed to upgrade user:', err);
  }
}

async function downgradeUserToFree(email) {
  const token = await getFirebaseAdminToken();
  const queryRes = await fetch(`${FIRESTORE_URL}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
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
  if (!doc) return;

  await fetch(`${doc.name}?updateMask.fieldPaths=plan`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ fields: { plan: { stringValue: 'free' } } }),
  });
  console.log(`⬇️ Downgraded ${email} to Free`);
}

function encodeEmail(email) {
  return email.replace(/[@.]/g, '_');
}

// ---- STRIPE WEBHOOK ----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  if (STRIPE_WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
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
      if (email) await upgradeUserToPro(email);

    } else if (event.type === 'customer.subscription.deleted') {
      const customer = await stripe.customers.retrieve(event.data.object.customer);
      if (customer.email) await downgradeUserToFree(customer.email);
    }
  } catch (err) {
    console.error('Error handling event:', err);
  }

  res.json({ received: true });
});

// ---- CHECK PENDING UPGRADE (called by extension) ----
app.use(express.json());

app.post('/check-upgrade', async (req, res) => {
  const { email, uid } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const token = await getFirebaseAdminToken();

    // Check pendingUpgrades collection
    const pendingRes = await fetch(
      `${FIRESTORE_URL}/pendingUpgrades/${encodeEmail(email)}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (pendingRes.ok) {
      const pending = await pendingRes.json();
      if (pending.fields?.plan?.stringValue === 'pro') {
        // Apply upgrade to user account
        await upgradeUserToPro(email);
        // Delete pending record
        await fetch(`${FIRESTORE_URL}/pendingUpgrades/${encodeEmail(email)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        return res.json({ upgraded: true });
      }
    }

    res.json({ upgraded: false });
  } catch (err) {
    console.error('Check upgrade error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ---- HEALTH CHECK ----
app.get('/', (req, res) => res.json({ status: '✅ LinkedAI backend running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LinkedAI backend running on port ${PORT}`));
