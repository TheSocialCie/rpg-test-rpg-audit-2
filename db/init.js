const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_email VARCHAR(255),
      amount_cents INTEGER NOT NULL,
      currency VARCHAR(10) DEFAULT 'eur',
      stripe_payment_id VARCHAR(255),
      stripe_event_type VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Tables created successfully');
  await pool.end();
}

init().catch(err => { console.error(err); process.exit(1); });
