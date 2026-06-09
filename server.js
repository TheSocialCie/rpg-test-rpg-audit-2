const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const PIXEL_ID = process.env.META_PIXEL_ID || '';
const CAPI_TOKEN = process.env.META_CAPI_TOKEN || '';
const COMPANY_SLUG = process.env.COMPANY_SLUG || '';
const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL || '';

function pixelScript() {
  if (!PIXEL_ID) return '';
  return `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${PIXEL_ID}');fbq('track','PageView');
</script>`;
}

function injectPixel(html) {
  if (!PIXEL_ID || !html) return html;
  const script = pixelScript();
  if (html.includes('</head>')) return html.replace('</head>', script + '</head>');
  if (html.includes('<body')) return html.replace('<body', script + '<body');
  return script + html;
}

async function sendMetaPurchase({ email, amount, currency, eventId }) {
  if (!PIXEL_ID || !CAPI_TOKEN) return;
  const hashedEmail = email
    ? crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
    : undefined;
  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: String(eventId || Date.now()),
      action_source: 'website',
      user_data: hashedEmail ? { em: [hashedEmail] } : {},
      custom_data: {
        currency: (currency || 'eur').toUpperCase(),
        value: (amount || 0) / 100,
      },
    }],
  };
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v20.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    if (!resp.ok) console.error('[CAPI] Error:', await resp.text());
    else console.log('[CAPI] Purchase event sent');
  } catch (err) {
    console.error('[CAPI] Failed:', err.message);
  }
}

async function forwardStripeEventToBackend(event) {
  if (!BACKEND_WEBHOOK_URL) return;
  try {
    const resp = await fetch(BACKEND_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!resp.ok) console.error('[WEBHOOK] Forward failed:', resp.status);
    else console.log('[WEBHOOK] Forwarded to backend');
  } catch (err) {
    console.error('[WEBHOOK] Forward error:', err.message);
  }
}

// Stripe webhook needs raw body — must be BEFORE express.json()
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured' });

  const stripe = require('stripe')(stripeKey);
  let event;

  try {
    if (endpointSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  res.json({ received: true });

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const obj = event.data.object;
    const email = obj.customer_details?.email || obj.receipt_email || '';
    const amount = obj.amount_total || obj.amount || 0;
    const currency = obj.currency || 'eur';
    const paymentId = obj.payment_intent || obj.id || '';

    console.log(`[PAYMENT] ${email} paid ${amount/100} ${currency} (${paymentId})`);

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO orders (customer_email, amount_cents, currency, stripe_payment_id, stripe_event_type, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [email, amount, currency, paymentId, event.type]
        );
      } catch (err) {
        console.error('[DB] Failed to log order:', err.message);
      }
    }

    await sendMetaPurchase({ email, amount, currency, eventId: paymentId });
    await forwardStripeEventToBackend(event);
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    const html = fs.readFileSync(indexPath, 'utf8');
    res.send(injectPixel(html));
  } catch {
    res.send(`<!DOCTYPE html><html><head><title>Coming Soon</title>${pixelScript()}</head><body><h1>Coming Soon</h1></body></html>`);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', db: !!pool, pixel: !!PIXEL_ID }));

app.post('/api/email-signup', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO waitlist (email, created_at) VALUES ($1, NOW()) ON CONFLICT (email) DO NOTHING',
        [email]
      );
    } catch (err) { console.error('[DB] waitlist insert failed:', err.message); }
  }
  res.json({ status: 'subscribed', email });
});

app.post('/api/checkout', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured' });
  const stripe = require('stripe')(stripeKey);
  const { product, amount, success_url, cancel_url } = req.body;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price_data: { currency: 'eur', product_data: { name: product || 'Product' }, unit_amount: amount || 1000 }, quantity: 1 }],
    mode: 'payment',
    success_url: success_url || '/',
    cancel_url: cancel_url || '/',
    metadata: { company_slug: COMPANY_SLUG },
    payment_intent_data: { metadata: { company_slug: COMPANY_SLUG } },
  });
  res.json({ checkout_url: session.url });
});

app.get('/api/orders', async (req, res) => {
  if (!pool) return res.json({ orders: [], message: 'DB not configured' });
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50');
    res.json({ orders: result.rows, count: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!pool) return res.json({ message: 'DB not configured' });
  try {
    const orders = await pool.query('SELECT COUNT(*) as count, COALESCE(SUM(amount_cents),0) as total FROM orders');
    const waitlist = await pool.query('SELECT COUNT(*) as count FROM waitlist');
    res.json({
      total_orders: parseInt(orders.rows[0].count),
      total_revenue_cents: parseInt(orders.rows[0].total),
      waitlist_count: parseInt(waitlist.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (pool) {
    try {
      await pool.query('SELECT 1');
      console.log('[DB] Connected to Neon PostgreSQL');
    } catch (err) {
      console.error('[DB] Connection failed:', err.message);
    }
  }
});
