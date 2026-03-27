const express = require('express');
const { Pool } = require('pg');
const https = require('https');
const querystring = require('querystring');
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

  const trxPatterns = [
    /TrxID\s+([A-Z0-9]+)/i,
    /Tran\s*ID[:\s]+([A-Z0-9]+)/i,
    /Transaction\s*ID[:\s]+([A-Z0-9]+)/i,
  ];
  for (const p of trxPatterns) {
    const m = message.match(p);
    if (m) { trx_id = m[1].toUpperCase(); break; }
  }

  const amtPatterns = [
    /Tk\.?\s*([\d,]+\.?\d*)/i,
    /BDT\s*([\d,]+\.?\d*)/i,
    /Amount[:\s]+([\d,]+\.?\d*)/i,
  ];
  for (const p of amtPatterns) {
    const m = message.match(p);
    if (m) { amount = parseFloat(m[1].replace(',','')); break; }
  }

  try {
    await pool.query(
      'INSERT INTO sms_log (sender, message, txn_id_extracted, amount_extracted) VALUES ($1,$2,$3,$4)',
      [sender, message, trx_id, amount]
    );
  } catch(e) {
    console.error('DB error:', e.message);
  }

  console.log('SMS received:', sender, '| TrxID:', trx_id, '| Amount:', amount);

  if (!trx_id) {
    return res.json({success: true, matched: false, reason: 'TrxID নেই'});
  }

  // InfinityFree এ confirm করো
  const postData = querystring.stringify({
    secret: 'ARENA_CONFIRM_2024',
    trx_id: trx_id,
    message: message
  });

  const options = {
    hostname: 'arenagateway.gt.tc',
    path: '/api/confirm.php',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const confirmReq = https.request(options, (confirmRes) => {
    let body = '';
    confirmRes.on('data', chunk => body += chunk);
    confirmRes.on('end', () => {
      console.log('Confirm response:', body);
      res.json({success: true, matched: true, status: 'confirmed'});
    });
  });

  confirmReq.on('error', (e) => {
    console.error('Confirm error:', e.message);
    res.json({success: false, message: e.message});
  });

  confirmReq.write(postData);
  confirmReq.end();
});

app.get('/', (req, res) => res.send('Arena SMS Relay OK'));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
