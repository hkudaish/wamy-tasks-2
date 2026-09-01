'use strict';
/**
 * تهيئة Supabase لتخزين المرفقات — خطوة واحدة بدل أربع.
 *
 *   node scripts/setup-supabase.js
 *
 * يقوم بـ:
 *   1. التحقق من متغيّرات البيئة المطلوبة
 *   2. إنشاء الـ bucket خاصًّا (يتجاوزه إن كان موجودًا)
 *   3. اختبار الرفع والتوقيع والحذف فعليًا
 *   4. ضبط توقيت قاعدة البيانات على الرياض
 *   5. عرض معاينة نقل المرفقات القائمة
 *
 * آمن للتكرار: لا يحذف بيانات، ولا ينقل شيئًا (المعاينة فقط).
 */
require('dotenv').config();
const { pool, one, all } = require('../server/db');
const fs = require('fs');
const path = require('path');

const URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'task-attachments';
const LOCAL_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

const H = () => ({ Authorization: `Bearer ${KEY}`, apikey: KEY });
const ok = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);
const warn = (m) => console.log('  \x1b[33m!\x1b[0m ' + m);
const bad = (m) => console.log('  \x1b[31m✖\x1b[0m ' + m);

let failed = false;

(async () => {
  /* ---------- 1) البيئة ---------- */
  console.log('\n[1/5] متغيّرات البيئة');
  if (!URL || !KEY) {
    bad('SUPABASE_URL أو SUPABASE_SERVICE_KEY غير مضبوط في ملف .env');
    console.log('\n      من لوحة Supabase → Settings → API انسخ:');
    console.log('        Project URL      ⇐ SUPABASE_URL');
    console.log('        service_role key ⇐ SUPABASE_SERVICE_KEY   (سرّي — خادمي فقط)\n');
    process.exit(1);
  }
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(URL)) warn(`صيغة SUPABASE_URL غير معتادة: ${URL}`);
  /* القيم تُرسل في ترويسات HTTP فيجب أن تكون ASCII بحتة.
     أشهر سبب للفشل هنا: بقاء النص التوضيحي العربي مكان المفتاح. */
  for (const [name, val] of [['SUPABASE_URL', URL], ['SUPABASE_SERVICE_KEY', KEY]]) {
    if (/[^\x21-\x7E]/.test(val)) {
      bad(`${name} يحوي محارف غير لاتينية أو مسافات — القيمة ليست مفتاحًا حقيقيًا.`);
      console.log(`      القيمة الحالية تبدأ بـ: ${val.slice(0, 24)}…`);
      console.log('      الصق القيمة كما هي من اللوحة، بلا أقواس < > ولا علامات اقتباس.\n');
      process.exit(1);
    }
  }
  if (!KEY.startsWith('eyJ')) {
    bad('المفتاح لا يبدأ بـ eyJ — المتوقع مفتاح service_role القديم (JWT).');
    console.log('      من صفحة API Keys اختر تبويب Legacy API Keys وانسخ حقل service_role.\n');
    process.exit(1);
  }
  // مفتاح service_role يحمل role=service_role في حمولته
  try {
    const payload = JSON.parse(Buffer.from(KEY.split('.')[1], 'base64').toString());
    if (payload.role !== 'service_role') {
      bad(`المفتاح المستخدم دوره "${payload.role}" لا service_role — لن يملك صلاحية الكتابة.`);
      process.exit(1);
    }
    ok('المفتاح من نوع service_role');
  } catch { warn('تعذّر قراءة نوع المفتاح — سنتابع ونعتمد على نتيجة الاتصال.'); }
  ok(`المشروع: ${URL}`);

  /* ---------- 2) الـ bucket ---------- */
  console.log(`\n[2/5] الحاوية «${BUCKET}»`);
  const r = await fetch(`${URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (r.ok) ok('أُنشئت خاصّة (Private)');
  else {
    const t = await r.text();
    if (/already exists|Duplicate/i.test(t)) {
      const b = await (await fetch(`${URL}/storage/v1/bucket/${BUCKET}`, { headers: H() })).json();
      ok('موجودة مسبقًا');
      if (b.public) { bad('الحاوية عامّة — أي شخص يملك الرابط يفتح المرفقات. اجعلها Private من اللوحة.'); failed = true; }
      else ok('خاصّة ✔');
    } else { bad(`تعذّر الإنشاء (${r.status}): ${t}`); process.exit(1); }
  }

  /* ---------- 3) اختبار دورة كاملة ---------- */
  console.log('\n[3/5] اختبار الرفع والتوقيع والحذف');
  const S = require('../server/storage');
  if (S.DRIVER !== 'supabase') { bad('طبقة التخزين ما زالت على القرص المحلي — راجع .env'); process.exit(1); }
  const key = `_selftest/${Date.now()}.txt`;
  try {
    await S.save(Buffer.from('wamy storage check'), key, 'text/plain');
    ok('الرفع');
    const link = await S.signedUrl(key, 'check.txt');
    const got = await fetch(link);
    if (!got.ok) throw new Error(`الرابط الموقّع رجع ${got.status}`);
    if ((await got.text()) !== 'wamy storage check') throw new Error('المحتوى المسترجع مختلف');
    ok('الرابط الموقّع يعمل ويعيد المحتوى الصحيح');
    await S.remove(key);
    ok('الحذف');
  } catch (e) { bad(e.message); await S.remove(key).catch(() => {}); failed = true; }

  /* ---------- 4) التوقيت ---------- */
  console.log('\n[4/5] توقيت قاعدة البيانات');
  const cur = await one('SHOW timezone');
  const tz = cur.TimeZone || cur.timezone;
  if (tz === 'Asia/Riyadh') ok('مضبوط على Asia/Riyadh');
  else {
    console.log(`  الحالي: ${tz} — سنضبطه…`);
    let done = false;
    for (const sql of [
      `ALTER DATABASE postgres SET timezone = 'Asia/Riyadh'`,
      `ALTER ROLE CURRENT_USER SET timezone = 'Asia/Riyadh'`,
    ]) {
      try { await pool.query(sql); ok(`نُفِّذ: ${sql}`); done = true; break; }
      catch (e) { warn(`فشل «${sql.slice(0, 34)}…»: ${e.message}`); }
    }
    if (done) console.log('      يسري على الاتصالات الجديدة — أعد تشغيل الخادم.');
    else {
      bad('تعذّر الضبط بصلاحياتك. نفّذه من SQL Editor في لوحة Supabase يدويًا.');
      failed = true;
    }
  }

  /* ---------- 5) معاينة النقل ---------- */
  console.log('\n[5/5] معاينة نقل المرفقات القائمة');
  const rows = await all('SELECT id, stored_name, orig_name FROM attachments ORDER BY id');
  const moved = rows.filter((a) => a.stored_name.includes('/'));
  const pending = rows.filter((a) => !a.stored_name.includes('/'));
  const missing = pending.filter((a) => !fs.existsSync(path.join(LOCAL_DIR, a.stored_name)));

  console.log(`      إجمالي المرفقات في القاعدة : ${rows.length}`);
  console.log(`      منقولة سابقًا              : ${moved.length}`);
  console.log(`      بانتظار النقل              : ${pending.length - missing.length}`);
  console.log(`      مفقودة على القرص           : ${missing.length}`);
  if (missing.length) {
    warn('صفوف بلا ملف فعلي — ضاعت في مرحلة سابقة:');
    for (const a of missing.slice(0, 15)) console.log(`        #${a.id}  ${a.orig_name}`);
    if (missing.length > 15) console.log(`        … و${missing.length - 15} غيرها`);
    console.log('      قرّر مصيرها قبل المتابعة: تُترك للتوثيق أم تُحذف صفوفها.');
  }

  /* ---------- الخلاصة ---------- */
  console.log('\n' + '─'.repeat(52));
  if (failed) console.log('انتهى مع ملاحظات تحتاج معالجة قبل المتابعة.');
  else if (pending.length - missing.length > 0) {
    console.log('التهيئة سليمة. للنقل الفعلي:');
    console.log('   node scripts/migrate-uploads-to-storage.js');
  } else console.log('التهيئة سليمة ولا مرفقات تحتاج نقلًا. انتقل إلى نشر Render.');
  console.log('');

  await pool.end();
  if (failed) process.exitCode = 1;
})().catch(async (e) => { bad(e.message); await pool.end().catch(() => {}); process.exit(1); });
