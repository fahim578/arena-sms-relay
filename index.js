const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => data += chunk);
  req.on('end', () => {
    try {
      req.body = JSON.parse(data);
    } catch(e) {
      const clean = data.replace(/[\x00-\x1F\x7F]/g, ' ');
      try { req.body = JSON.parse(clean); } catch(e2) { req.body = {}; }
    }
    next();
  });
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS sms_log (
    id SERIAL PRIMARY KEY,
    sender TEXT,
    message TEXT,
    txn_id_extracted TEXT,
    amount_extracted NUMERIC,
    matched_payment_id INT,
    received_at TIMESTAMP DEFAULT NOW()
  )
`).catch(console.error);

app.post('/api/sms_receive.php', async (req, res) => {
  const token = req.headers['x-app-token'] || '';
  if (token !== process.env.APP_TOKEN) {
    return res.status(401).json({success: false, message: 'Invalid token'});
  }

  const sender = String(req.body.sender || '').replace(/[\x00-\x1F\x7F]/g, ' ');
  const message = String(req.body.message || '').replace(/[\x00-\x1F\x7F]/g, ' ');

  if (!sender || !message) {
    return res.status(400).json({success: false, message: 'sender and message required'});
  }

  let trx_id = null;
  let amount = null;

  const trxPatterns = [/TrxID\s+([A-Z0-9]+)/i, /Tran\s*ID[:\s]+([A-Z0-9]+)/i, /Transaction\s*ID[:\s]+([A-Z0-9]+)/i];
  for (const p of trxPatterns) {
    const m = message.match(p);
    if (m) { trx_id = m[1].toUpperCase(); break; }
  }

  const amtPatterns = [/Tk\.?\s*([\d,]+\.?\d*)/i, /BDT\s*([\d,]+\.?\d*)/i, /Amount[:\s]+([\d,]+\.?\d*)/i];
  for (const p of amtPatterns) {
    const m = message.match(p);
    if (m) { amount = parseFloat(m[1].replace(',','')); break; }
  }

  await pool.query('INSERT INTO sms_log (sender, message, txn_id_extracted, amount_extracted) VALUES ($1,$2,$3,$4)', [sender, message, trx_id, amount]);

  console.log('SMS received:', sender, '| TrxID:', trx_id, '| Amount:', amount);

  if (!trx_id) return res.json({success: true, matched: false, reason: 'TrxID নেই'});

  // InfinityFree MySQL তে confirm করো
  const mysql = require('mysql2/promise');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  const [rows] = await db.execute("SELECT * FROM payment_requests WHERE txn_id = ? AND status = 'pending' LIMIT 1", [trx_id]);
  
  if (rows.length === 0) {
    await db.end();
    return res.json({success: true, matched: false, reason: 'Payment নেই'});
  }

  const payment = rows[0];

  if (amount && Math.abs(amount - parseFloat(payment.amount)) > 1) {
    await db.execute("UPDATE payment_requests SET status='failed', sms_matched=? WHERE id=?", [message, payment.id]);
    await db.end();
    return res.json({success: true, matched: true, status: 'failed'});
  }

  await db.execute("UPDATE payment_requests SET status='confirmed', sms_matched=? WHERE id=?", [message, payment.id]);
  await db.end();

  return res.json({success: true, matched: true, status: 'confirmed'});
});

app.get('/', (req, res) => res.send('Arena SMS Relay OK'));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
