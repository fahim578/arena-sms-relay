const express = require('express');
const mysql = require('mysql2/promise');
const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: 3306
});

app.post('/api/sms_receive.php', async (req, res) => {
  const token = req.headers['x-app-token'] || '';
  if (token !== process.env.APP_TOKEN) {
    return res.status(401).json({success: false, message: 'Invalid token'});
  }

  const { sender, message } = req.body;
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
    await pool.execute(
      'INSERT INTO sms_log (sender, message, txn_id_extracted, amount_extracted) VALUES (?,?,?,?)',
      [sender, message, trx_id, amount]
    );

    if (!trx_id) {
      return res.json({success: true, matched: false, reason: 'TrxID parse করা যায়নি'});
    }

    const [rows] = await pool.execute(
      "SELECT * FROM payment_requests WHERE txn_id = ? AND status = 'pending' LIMIT 1",
      [trx_id]
    );

    if (rows.length === 0) {
      return res.json({success: true, matched: false, reason: 'No matching payment'});
    }

    const payment = rows[0];

    if (amount && Math.abs(amount - parseFloat(payment.amount)) > 1) {
      await pool.execute(
        "UPDATE payment_requests SET status='failed', sms_matched=? WHERE id=?",
        [message, payment.id]
      );
      return res.json({success: true, matched: true, status: 'failed', reason: 'Amount mismatch'});
    }

    await pool.execute(
      "UPDATE payment_requests SET status='confirmed', sms_matched=? WHERE id=?",
      [message, payment.id]
    );

    return res.json({success: true, matched: true, status: 'confirmed'});

  } catch(e) {
    return res.status(500).json({success: false, message: e.message});
  }
});

app.get('/', (req, res) => res.send('Arena SMS Relay OK'));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
