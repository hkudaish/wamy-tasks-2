'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { pool, getSetting } = require('./db');
const auth = require('./auth');
const routes = require('./routes');
const admin = require('./admin');
const { startScheduler } = require('./scheduler');

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

/* ---------- الأمان ---------- */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],   // الواجهة صفحة واحدة بسكربت مضمّن
        // معالِجات الأحداث المضمّنة (onclick) مستخدَمة في الواجهة.
        // التخفيف: كل نص يأتي من المستخدم يمر عبر esc() قبل الإدراج،
        // ولا تُحمَّل أي سكربتات خارجية (script-src 'self' فقط).
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'عدد كبير من المحاولات. أعد المحاولة بعد قليل.' },
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false });

/* ---------- المصادقة ---------- */
app.post('/api/auth/login', loginLimiter, auth.login);
app.post('/api/auth/logout', auth.logout);
app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json({ user: req.me }));

/* ---------- الصحة ---------- */
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: true, time: new Date().toISOString() }); }
  catch (e) { res.status(503).json({ ok: false, db: false, error: e.message }); }
});

/* ---------- المسارات ---------- */
app.use('/api', apiLimiter, routes);
app.use('/api/admin', apiLimiter, admin);

/* ---------- الواجهة ---------- */
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* ---------- الأخطاء ---------- */
app.use((req, res) => res.status(404).json({ error: 'المسار غير موجود.' }));
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'حجم الملف يتجاوز الحد المسموح.' });
  console.error('[error]', err);
  res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم.' });
});

const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, async () => {
  const cfg = await getSetting('cfg');
  console.log(`\n  نظام إدارة ومتابعة المهام — وامي`);
  console.log(`  يعمل على المنفذ ${PORT}`);
  console.log(`  نطاق البريد المعتمد: ${cfg.domains.map((d) => '@' + d).join('، ')}`);
  console.log(`  البريد الإلكتروني: ${process.env.SMTP_HOST ? 'مفعّل (' + process.env.SMTP_HOST + ')' : 'غير مفعّل'}\n`);
  startScheduler();
});

const shutdown = (sig) => {
  console.log(`\n[${sig}] إيقاف الخادم…`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
