'use strict';

const { pool } = require('../../server/db');
const { dailyDigest } = require('../../server/scheduler');

exports.handler = async () => {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date()));
  if (hour !== Number(process.env.DIGEST_HOUR || 7)) {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'outside configured hour' }) };
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [734129805]);
    if (!rows[0].acquired) {
      return { statusCode: 200, body: JSON.stringify({ skipped: 'another digest is running' }) };
    }
    await dailyDigest();
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [734129805]); }
    finally { client.release(); }
  }
};
