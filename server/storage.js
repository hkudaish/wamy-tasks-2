'use strict';
/**
 * طبقة تخزين المرفقات — سائقان:
 *   • supabase : عند ضبط SUPABASE_URL و SUPABASE_SERVICE_KEY (الإنتاج)
 *   • local    : القرص المحلي عبر UPLOAD_DIR (التطوير، والرجوع الآمن)
 *
 * الواجهة موحّدة، فلا تعرف routes.js أيّ سائق يعمل.
 */
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'task-attachments';
const SIGN_TTL = Number(process.env.SUPABASE_SIGN_TTL || 60); // ثانية

const DRIVER = SUPABASE_URL && SERVICE_KEY ? 'supabase' : 'local';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
if (DRIVER === 'local') fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const api = (p) => `${SUPABASE_URL}/storage/v1${p}`;
const authHeaders = () => ({ Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY });

/** مفتاح كائن عشوائي، مقسّم حسب المهمة ليسهُل التتبّع والحذف الجماعي */
function newKey(taskId, originalName) {
  const ext = path.extname(originalName || '').slice(0, 12).replace(/[^\w.]/g, '');
  const rand = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const safeTask = String(taskId).replace(/[^\w-]/g, '_');
  return DRIVER === 'supabase' ? `tasks/${safeTask}/${rand}${ext}` : `${rand}${ext}`;
}

/** رفع محتوى الملف. يُرجع المفتاح المخزَّن في attachments.stored_name */
async function save(buffer, key, mime) {
  if (DRIVER === 'local') {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, key), buffer);
    return key;
  }
  const r = await fetch(api(`/object/${BUCKET}/${key}`), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'false' },
    body: buffer,
  });
  if (!r.ok) throw new Error(`تعذّر رفع المرفق إلى Supabase (${r.status}): ${await r.text()}`);
  return key;
}

/** رابط موقّت موقّع للتنزيل (سائق supabase فقط) */
async function signedUrl(key, origName) {
  const r = await fetch(api(`/object/sign/${BUCKET}/${key}`), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: SIGN_TTL }),
  });
  if (!r.ok) throw new Error(`تعذّر توقيع رابط المرفق (${r.status}): ${await r.text()}`);
  const { signedURL } = await r.json();
  return api(signedURL) + '&download=' + encodeURIComponent(origName || 'file');
}

/** يسلّم الملف للمستخدم — تحويل موقّع في الإنتاج، وبثّ محلي في التطوير */
async function serve(res, key, origName) {
  if (DRIVER === 'local') return res.download(path.join(UPLOAD_DIR, key), origName);
  return res.redirect(302, await signedUrl(key, origName));
}

/** حذف كائن واحد — لا يرمي استثناءً إن كان مفقودًا */
async function remove(key) {
  if (DRIVER === 'local') {
    return fs.promises.unlink(path.join(UPLOAD_DIR, key)).catch(() => {});
  }
  await fetch(api(`/object/${BUCKET}/${key}`), { method: 'DELETE', headers: authHeaders() }).catch(() => {});
}

/** حذف جماعي — يستعمله إعادة الضبط في admin.js. يُرجع عدد المحذوف */
async function purgeAll() {
  if (DRIVER === 'local') {
    let entries = [];
    try { entries = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
    let n = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const target = path.resolve(UPLOAD_DIR, e.name);
      if (path.dirname(target) !== UPLOAD_DIR) continue;
      await fs.promises.unlink(target); n++;
    }
    return n;
  }
  const keys = await listAll();
  if (!keys.length) return 0;
  const r = await fetch(api(`/object/${BUCKET}`), {
    method: 'DELETE',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: keys }),
  });
  if (!r.ok) throw new Error(`تعذّر حذف المرفقات (${r.status}): ${await r.text()}`);
  return keys.length;
}

/** سرد كل المفاتيح تحت مجلد (تكراري) — للحذف الجماعي وللتدقيق */
async function listAll(prefix = 'tasks') {
  const out = [];
  const walk = async (p) => {
    let offset = 0;
    for (;;) {
      const r = await fetch(api(`/object/list/${BUCKET}`), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: p, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      if (!r.ok) throw new Error(`تعذّر سرد المرفقات (${r.status})`);
      const rows = await r.json();
      if (!rows.length) return;
      for (const row of rows) {
        if (row.id) out.push(`${p}/${row.name}`);        // ملف
        else await walk(`${p}/${row.name}`);             // مجلد
      }
      if (rows.length < 1000) return;
      offset += rows.length;
    }
  };
  await walk(prefix);
  return out;
}

module.exports = { DRIVER, BUCKET, newKey, save, serve, signedUrl, remove, purgeAll, listAll, UPLOAD_DIR };
