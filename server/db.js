'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (e) => console.error('[db] خطأ في اتصال قاعدة البيانات:', e.message));

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/* ---------- الإعدادات ---------- */
const SETTING_DEFAULTS = {
  cfg: {
    domains: ['wamy.org'],
    nearDueDays: 3,
    autoLate: true,
    progressFromSubtasks: true,
    idleMinutes: 30,
    weights: { timeliness: 0.4, quality: 0.35, speed: 0.25 },
    notify: {
      assign: { app: true, email: true },
      urgent: { app: true, email: true, sms: false, whatsapp: false },
      near: { app: true, email: false },
      late: { app: true, email: true },
      status: { app: true, email: false },
      comment: { app: true, email: false },
      mention: { app: true, email: true },
      approval: { app: true, email: true },
      done: { app: true, email: false },
      reopen: { app: true, email: true },
      deadline: { app: true, email: true },
      event_new: { app: true, email: true },
      event_update: { app: true, email: false },
      event_cancel: { app: true, email: false },
    },
  },
  brand: {
    org: 'الندوة العالمية للشباب الإسلامي',
    short: 'wamy',
    app: 'نظام إدارة ومتابعة المهام',
    logo: null,
    logoDark: null,
    primary: '#1C1164',
    accent: '#0096FF',
    font: 'Dubai',
    loginBg: '#0E0836',
  },
};

async function getSetting(key) {
  const r = await one('SELECT value FROM settings WHERE key=$1', [key]);
  if (!r) return structuredClone(SETTING_DEFAULTS[key] || {});
  return { ...structuredClone(SETTING_DEFAULTS[key] || {}), ...r.value };
}
async function setSetting(key, value) {
  await q(
    `INSERT INTO settings(key,value) VALUES($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, value]
  );
  return value;
}

module.exports = { pool, q, one, all, tx, getSetting, setSetting, SETTING_DEFAULTS };
