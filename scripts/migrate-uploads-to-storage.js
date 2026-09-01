'use strict';
/**
 * نقل المرفقات الموجودة على القرص إلى Supabase Storage — تشغيل لمرة واحدة.
 *
 *   node scripts/migrate-uploads-to-storage.js --dry     # عرض ما سينُقل دون كتابة
 *   node scripts/migrate-uploads-to-storage.js           # التنفيذ الفعلي
 *
 * آمن للتكرار: يتجاهل الصفوف المنقولة أصلًا، ولا يحذف أي ملف محلي.
 * احذف مجلد uploads يدويًا بعد التحقق من عمل النظام على Supabase.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, q, all } = require('../server/db');
const S = require('../server/storage');

const DRY = process.argv.includes('--dry');
const LOCAL_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

(async () => {
  if (S.DRIVER !== 'supabase') {
    console.error('✖ السائق الحالي محلي. اضبط SUPABASE_URL و SUPABASE_SERVICE_KEY في .env أولًا.');
    process.exit(1);
  }

  const rows = await all('SELECT id, task_id, stored_name, orig_name, mime, size FROM attachments ORDER BY id');
  console.log(`المرفقات في القاعدة : ${rows.length}`);
  console.log(`المجلد المحلي        : ${LOCAL_DIR}`);
  console.log(`الوجهة               : ${S.BUCKET} @ ${process.env.SUPABASE_URL}`);
  console.log(DRY ? '\n— وضع المعاينة، لن تُكتب أي بيانات —\n' : '');

  let moved = 0, skipped = 0, missing = 0, failed = 0;

  for (const a of rows) {
    if (a.stored_name.includes('/')) { skipped++; continue; }           // منقول سابقًا

    const src = path.join(LOCAL_DIR, a.stored_name);
    if (!fs.existsSync(src)) {
      missing++;
      console.warn(`  ⚠ مفقود محليًا: #${a.id} ${a.orig_name} (${a.stored_name})`);
      continue;
    }

    const key = S.newKey(a.task_id, a.orig_name);
    if (DRY) { console.log(`  → #${a.id} ${a.orig_name}  ⇒  ${key}`); moved++; continue; }

    try {
      const buf = await fs.promises.readFile(src);
      await S.save(buf, key, a.mime);
      await q('UPDATE attachments SET stored_name=$1 WHERE id=$2', [key, a.id]);
      moved++;
      console.log(`  ✔ #${a.id} ${a.orig_name}`);
    } catch (e) {
      failed++;
      console.error(`  ✖ #${a.id} ${a.orig_name}: ${e.message}`);
    }
  }

  console.log(`\nنُقل: ${moved} · متجاوَز: ${skipped} · مفقود محليًا: ${missing} · فشل: ${failed}`);
  if (failed) process.exitCode = 1;
  await pool.end();
})();
