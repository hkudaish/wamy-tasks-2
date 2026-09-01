'use strict';
const nodemailer = require('nodemailer');
const { q, all, getSetting } = require('./db');

let transport = null;
const ENABLED = !!process.env.SMTP_HOST;
if (ENABLED) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

const KIND_SUBJECT = {
  assign: 'إسناد مهمة جديدة',
  comment: 'تعليق جديد على مهمة',
  mention: 'أشار إليك زميل في مهمة',
  approval: 'طلب اعتماد إغلاق مهمة',
  approved: 'اعتُمد إغلاق مهمتك',
  rejected: 'أُرجعت مهمتك للتنفيذ',
  extend: 'تمديد موعد مهمة',
  reopen: 'إعادة فتح مهمة',
  deadline: 'تغيير الموعد النهائي',
  late: 'تنبيه تأخير',
  near: 'اقتراب موعد الاستحقاق',
  urgent: 'مهمة عاجلة تتطلب الاهتمام',
};

const CHANNEL_ENV = {
  sms: { url: 'SMS_WEBHOOK_URL', token: 'SMS_WEBHOOK_TOKEN' },
  whatsapp: { url: 'WHATSAPP_WEBHOOK_URL', token: 'WHATSAPP_WEBHOOK_TOKEN' },
};

async function sendWebhook(channel, payload) {
  const spec = CHANNEL_ENV[channel];
  const url = process.env[spec.url];
  if (!url) return false;
  const headers = { 'content-type': 'application/json' };
  const token = process.env[spec.token];
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${channel} webhook HTTP ${response.status}`);
  return true;
}

function enabledFor(globalChannels, prefs, kind, channel) {
  const allowed = globalChannels[channel] === true || (channel === 'app' && globalChannels.app !== false);
  if (!allowed) return false;
  const general = prefs && prefs.channels && prefs.channels[channel];
  if (general === false) return false;
  const personal = prefs && prefs.kinds && prefs.kinds[kind] && prefs.kinds[kind][channel];
  if (typeof personal === 'boolean') return personal;
  return true;
}

/**
 * إنشاء تنبيهات داخل النظام + إرسال بريد عند تفعيل القناة.
 * لا يُرسل للمستخدم عن إجراء قام به بنفسه.
 */
async function notify({ kind, taskId, body, to, actorId }) {
  const ids = [...new Set((to || []).filter((x) => x && x !== actorId))];
  if (!ids.length) return;

  const cfg = await getSetting('cfg');
  const ch = (cfg.notify && cfg.notify[kind]) || { app: true, email: false, sms: false, whatsapp: false };
  const users = await all('SELECT id,email,name,phone,notification_prefs FROM users WHERE id = ANY($1) AND active=true', [ids]);
  const brand = await getSetting('brand');
  for (const u of users) {
    const prefs = u.notification_prefs || {};
    let notificationId = null;
    if (enabledFor(ch, prefs, kind, 'app')) {
      const inserted = await q('INSERT INTO notifications(kind,task_id,body,to_user) VALUES($1,$2,$3,$4) RETURNING id', [kind, taskId, body, u.id]);
      notificationId = inserted.rows[0].id;
    }
    if (enabledFor(ch, prefs, kind, 'email') && ENABLED) {
      try {
        await transport.sendMail({
          from: process.env.SMTP_FROM || `"${brand.org}" <no-reply@${(cfg.domains && cfg.domains[0]) || 'localhost'}>`,
          to: u.email,
          subject: `[${brand.app}] ${KIND_SUBJECT[kind] || 'تنبيه'}`,
          html: template({ brand, name: u.name, body, taskId }),
        });
        if (notificationId) await q('UPDATE notifications SET emailed=true WHERE id=$1', [notificationId]);
      } catch (e) {
        console.error('[mail] تعذّر الإرسال إلى', u.email, e.message);
      }
    }
    for (const channel of ['sms', 'whatsapp']) {
      if (!u.phone || !enabledFor(ch, prefs, kind, channel)) continue;
      try {
        const sent = await sendWebhook(channel, { to: u.phone, message: body, kind, taskId, recipient: { id: u.id, name: u.name } });
        if (sent && notificationId) await q(`UPDATE notifications SET ${channel === 'sms' ? 'sms_sent' : 'whatsapp_sent'}=true WHERE id=$1`, [notificationId]);
      } catch (e) { console.error(`[${channel}] تعذّر الإرسال إلى`, u.phone, e.message); }
    }
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function template({ brand, name, body, taskId }) {
  const url = (process.env.APP_URL || '').replace(/\/$/, '');
  return `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#f4f6f9;font-family:Tahoma,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:26px 12px">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3e8ef">
      <tr><td style="background:${brand.primary};padding:16px 20px;color:#fff">
        <div style="font-size:15px;font-weight:bold">${esc(brand.org)}</div>
        <div style="font-size:12px;opacity:.85">${esc(brand.app)}</div></td></tr>
      <tr><td style="padding:22px 20px;color:#111826;font-size:14px;line-height:1.9">
        <p style="margin:0 0 10px">مرحبًا ${esc(name)}،</p>
        <p style="margin:0 0 16px">${esc(body)}</p>
        ${url ? `<a href="${url}" style="display:inline-block;background:${brand.accent};color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px">فتح النظام</a>` : ''}
        ${taskId ? `<p style="margin:14px 0 0;color:#647084;font-size:12px">رقم المهمة: ${esc(taskId)}</p>` : ''}
      </td></tr>
      <tr><td style="padding:12px 20px;background:#fafbfc;color:#8b97a8;font-size:11px;border-top:1px solid #e3e8ef">
        رسالة آلية من ${esc(brand.app)} — لا يلزم الرد عليها.</td></tr>
    </table></td></tr></table></body></html>`;
}

async function verifyTransport() {
  if (!ENABLED) return { enabled: false };
  try { await transport.verify(); return { enabled: true, ok: true }; }
  catch (e) { return { enabled: true, ok: false, error: e.message }; }
}

module.exports = { notify, verifyTransport, ENABLED };
