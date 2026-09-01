'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q, one, all, getSetting } = require('./db');

const COOKIE = 'wamy_session';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 24) {
  console.error('\n[أمان] متغيّر SESSION_SECRET مفقود أو قصير. أنشئه بـ: openssl rand -hex 32\n');
  process.exit(1);
}

const LOCK_WINDOW_MIN = Number(process.env.LOCK_WINDOW_MIN || 15);
const LOCK_MAX_FAILS = Number(process.env.LOCK_MAX_FAILS || 5);

const hash = (pw) => bcrypt.hash(pw, 12);
const verify = (pw, h) => bcrypt.compare(pw, h);

async function logAttempt(email, ok, reason, req) {
  await q(
    `INSERT INTO login_attempts(email, ok, reason, ip, user_agent) VALUES($1,$2,$3,$4,$5)`,
    [String(email || '').slice(0, 200), ok, reason || '', clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300)]
  );
}
const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';

async function isLocked(email) {
  const r = await one(
    `SELECT count(*)::int AS n FROM login_attempts
     WHERE lower(email)=lower($1) AND ok=false AND created_at > now() - ($2 || ' minutes')::interval`,
    [email, String(LOCK_WINDOW_MIN)]
  );
  return (r?.n || 0) >= LOCK_MAX_FAILS;
}

/** تسجيل الدخول: تقييد النطاق ← وجود المستخدم ← كلمة المرور ← إصدار جلسة */
async function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const cfg = await getSetting('cfg');

  if (!email || !password) {
    await logAttempt(email, false, 'بيانات ناقصة', req);
    return res.status(400).json({ error: 'الرجاء إدخال البريد وكلمة المرور.' });
  }
  if (await isLocked(email)) {
    await logAttempt(email, false, 'الحساب موقوف مؤقتًا', req);
    return res.status(429).json({ error: `تم إيقاف المحاولات مؤقتًا بعد ${LOCK_MAX_FAILS} محاولات فاشلة. أعد المحاولة بعد ${LOCK_WINDOW_MIN} دقيقة.` });
  }

  const domain = email.split('@')[1] || '';
  if (!cfg.domains.map((d) => d.toLowerCase()).includes(domain)) {
    await logAttempt(email, false, 'نطاق بريد غير معتمد', req);
    return res.status(403).json({ error: `الدخول مسموح فقط ببريد ${cfg.domains.map((d) => '@' + d).join(' أو ')} — لا تُقبل البُرد الشخصية.` });
  }

  const u = await one('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  // مقارنة وهمية عند عدم وجود المستخدم لتوحيد زمن الاستجابة ومنع تعداد الحسابات
  const ok = u && u.active ? await verify(password, u.password_hash) : await verify(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!u || !u.active || !ok) {
    await logAttempt(email, false, !u ? 'بريد غير مسجّل' : !u.active ? 'حساب معطّل' : 'كلمة مرور غير صحيحة', req);
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
  }

  await logAttempt(email, true, '', req);
  await q('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
  issue(res, u, cfg.idleMinutes);
  return res.json({ user: publicUser(u), mustChangePassword: u.must_change_pw });
}

function issue(res, u, idleMinutes) {
  const maxAge = Math.max(5, Number(idleMinutes) || 30) * 60;
  const token = jwt.sign({ sub: u.id, role: u.role, dept: u.dept_id, organization: u.organization_id }, SECRET, { expiresIn: maxAge });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: maxAge * 1000,
    path: '/',
  });
}

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, dept: u.dept_id, organization: u.organization_id,
  role: u.role, title: u.title, active: u.active, permissions: u.permissions || {},
});

/** حماية المسارات + تجديد الجلسة مع كل طلب (انتهاء بالخمول لا بالزمن المطلق) */
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return res.status(401).json({ error: 'انتهت الجلسة. يُرجى تسجيل الدخول.' });
    const payload = jwt.verify(token, SECRET);
    const u = await one('SELECT * FROM users WHERE id=$1 AND active=true', [payload.sub]);
    if (!u) return res.status(401).json({ error: 'الحساب غير متاح.' });
    req.me = publicUser(u);
    req.me.dept_id = u.dept_id;
    req.me.organization_id = u.organization_id;
    /* قد يتولى المدير أكثر من إدارة، فنطاقه = إدارته + كل إدارة هو مديرها */
    const led = await all('SELECT id FROM organizations WHERE director_id=$1', [u.id]);
    req.me.orgIds = [...new Set([u.organization_id, ...led.map((x) => x.id)].filter(Boolean))];
    const cfg = await getSetting('cfg');
    issue(res, u, cfg.idleMinutes); // تجديد متدحرج
    next();
  } catch (e) {
    res.clearCookie(COOKIE, { path: '/' });
    return res.status(401).json({ error: 'انتهت الجلسة بسبب الخمول. يُرجى تسجيل الدخول مجددًا.' });
  }
}

const requireAdmin = (req, res, next) =>
  req.me?.role === 'admin' ? next() : res.status(403).json({ error: 'هذا الإجراء مقصور على مدير النظام.' });
const requireManager = (req, res, next) =>
  ['admin','secretary_general','assistant_secretary_general','director','manager'].includes(req.me?.role) ? next() : res.status(403).json({ error: 'هذا الإجراء مقصور على المديرين.' });

function logout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

/** سياسة كلمة المرور */
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'كلمة المرور يجب ألا تقل عن 10 أحرف.';
  if (!/[A-Za-z؀-ۿ]/.test(pw) || !/[0-9]/.test(pw)) return 'كلمة المرور يجب أن تجمع بين حروف وأرقام.';
  return null;
}

module.exports = { COOKIE, hash, verify, login, logout, requireAuth, requireAdmin, requireManager, publicUser, validatePassword, clientIp };
