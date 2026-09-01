'use strict';
/**
 * تهيئة البيانات المرجعية والمستخدمين.
 *   node server/seed.js          → البيانات المرجعية + حساب مدير النظام فقط
 *   node server/seed.js --demo   → يضيف مستخدمين ومهام تجريبية لاختبار القبول
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, q, one, setSetting, SETTING_DEFAULTS } = require('./db');
const { hash } = require('./auth');

const DEMO = process.argv.includes('--demo');
const MS = 86400000;
const D = (n) => new Date(Date.now() + n * MS).toISOString().slice(0, 10);

const DEPTS = [
  ['media', 'الإعلام والاتصال المؤسسي'], ['pr', 'العلاقات العامة والبروتوكول'],
  ['prod', 'الإنتاج الإبداعي'], ['prog', 'البرامج والمشاريع'],
  ['it', 'تقنية المعلومات'], ['hr', 'الموارد البشرية'],
];
const CATS = [
  ['news', 'خبر وتغطية إعلامية'], ['stmt', 'بيان وتصريح رسمي'], ['video', 'إنتاج مرئي وفيديو'],
  ['design', 'تصميم وهوية بصرية'], ['event', 'فعالية واستقبال'], ['report', 'تقرير ومحتوى'],
  ['monitor', 'رصد وتطوير'], ['admin', 'مهمة إدارية'],
];
const STATUSES = [
  ['new', 'جديدة', 'b-purple', 'var(--purple)', true], ['notstarted', 'لم تبدأ', 'b-gray', 'var(--gray)', true],
  ['inprogress', 'قيد التنفيذ', 'b-brand', 'var(--brand)', true], ['waiting', 'بانتظار إجراء', 'b-teal', 'var(--teal)', true],
  ['approval', 'بانتظار اعتماد', 'b-amber', 'var(--amber)', true], ['onhold', 'معلقة', 'b-gray', 'var(--gray)', true],
  ['late', 'متأخرة', 'b-red', 'var(--red)', true], ['done', 'مكتملة', 'b-green', 'var(--green)', false],
  ['cancelled', 'ملغاة', 'b-gray', 'var(--gray)', false],
];
const PRIS = [
  ['urgent', 'عاجلة', 'b-red', 'var(--red)', 4], ['high', 'عالية', 'b-amber', 'var(--amber)', 3],
  ['medium', 'متوسطة', 'b-blue', 'var(--blue)', 2], ['low', 'منخفضة', 'b-gray', 'var(--gray)', 1],
];
const CFS = [
  ['cf1', 'رقم المرجع الإداري', 'text', false, ['admin', 'event']],
  ['cf2', 'الميزانية التقديرية (ريال)', 'number', false, ['event', 'video', 'design']],
  ['cf3', 'يحتاج اعتماد الأمانة العامة؟', 'bool', true, ['stmt', 'report']],
  ['cf4', 'رابط المادة المنشورة', 'url', false, ['news', 'video']],
];

const DEMO_USERS = [
  ['u2', 'عبدالله الشمري', 'a.alshammari', 'media', 'manager', 'رئيس قسم التحرير'],
  ['u3', 'سارة العتيبي', 's.alotaibi', 'prod', 'manager', 'مديرة الإنتاج الإبداعي'],
  ['u4', 'خالد الحربي', 'k.alharbi', 'pr', 'manager', 'مدير العلاقات العامة والبروتوكول'],
  ['u5', 'نورة القحطاني', 'n.alqahtani', 'media', 'employee', 'محررة أخبار'],
  ['u6', 'فيصل الدوسري', 'f.aldosari', 'prod', 'employee', 'مصور ومونتير'],
  ['u7', 'ريم الزهراني', 'r.alzahrani', 'pr', 'employee', 'أخصائية بروتوكول'],
  ['u8', 'ماجد العنزي', 'm.alanazi', 'prod', 'employee', 'مصمم جرافيك'],
  ['u9', 'هند السبيعي', 'h.alsubaie', 'media', 'employee', 'أخصائية تواصل رقمي'],
  ['u10', 'طارق البلوي', 't.albalawi', 'it', 'employee', 'أخصائي أنظمة'],
  ['u11', 'لمى الغامدي', 'l.alghamdi', 'prog', 'employee', 'منسقة برامج'],
  ['u12', 'سلطان المطيري', 's.almutairi', 'pr', 'employee', 'منسق فعاليات'],
];

// [عنوان, وصف, أولوية, تصنيف, إدارة, مسؤول, منشئ, إنشاء, بدء, مدة, استحقاق, نسبة, حالة, ملاحظات, سبب تأخير, إغلاق, جودة, تكرار]
const DEMO_TASKS = [
  ['تغطية إعلامية شاملة لملتقى الشباب المسلم الدولي', 'خطة تغطية متكاملة: خبر افتتاح، تقرير يومي، مقابلات، وبث لحظي بالتنسيق مع الإنتاج والعلاقات العامة.', 'urgent', 'news', 'media', 'u5', 'u1', -24, -20, 18, -2, 78, 'inprogress', 'اكتمل الخبر الافتتاحي والتقرير اليومي؛ متبقٍ مقابلتان وتقرير الختام.', 'تأخر تسليم المقابلات من فريق الإنتاج بسبب تعارض جدول التصوير.', null, null, null],
  ['بيان صحفي بمناسبة اليوم العالمي للشباب', 'صياغة بيان رسمي باسم الأمانة العامة ومراجعته لغويًا ونشره على الموقع والمنصات.', 'high', 'stmt', 'media', 'u2', 'u1', -14, -12, 4, -6, 100, 'done', '', '', -7, 5, null],
  ['فيلم مؤسسي تعريفي عن وامي — النسخة العربية', 'فيلم 3 دقائق: سيناريو، تصوير، مونتاج، تعليق صوتي، موشن جرافيك، ونسخ مقاسات المنصات.', 'high', 'video', 'prod', 'u6', 'u3', -38, -33, 30, 6, 62, 'inprogress', 'انتهى التصوير الميداني، جارٍ المونتاج والمزج الصوتي.', '', null, null, null],
  ['تحديث الهوية البصرية للمنصات الرقمية', 'قوالب موحدة للأخبار والاقتباسات والفعاليات على إنستغرام وإكس ولينكدإن.', 'medium', 'design', 'prod', 'u8', 'u3', -30, -26, 20, -4, 70, 'inprogress', '', 'إعادة توجيه من الإدارة العليا لاعتماد لوحة ألوان جديدة أدت لإعادة تصميم القوالب.', null, null, null],
  ['ترتيبات استقبال وفد منظمة التعاون الإسلامي', 'الاستقبال، الإقامة، النقل، برنامج الزيارة، الضيافة، التوثيق المصور، والهدايا الرسمية.', 'urgent', 'event', 'pr', 'u7', 'u4', -9, -7, 12, 2, 55, 'inprogress', 'تم اعتماد الفندق والنقل؛ بانتظار اعتماد برنامج الزيارة النهائي.', '', null, null, null],
  ['عروض أسعار قاعة وضيافة الحفل السنوي', 'مقارنة ثلاثة عروض وفق القيمة مقابل التكلفة ورفع توصية للإدارة.', 'high', 'event', 'pr', 'u12', 'u4', -11, -9, 7, -1, 90, 'approval', 'أُعدت المصفوفة المقارنة والتوصية؛ بانتظار الاعتماد.', '', null, null, null],
  ['تقرير الرصد الشهري للقطاع غير الربحي', 'رصد المبادرات والمؤتمرات والممارسات الجديدة في الاتصال المؤسسي وربطها بفرص وامي.', 'medium', 'monitor', 'media', 'u9', 'u1', -8, -6, 6, 4, 45, 'inprogress', '', '', null, null, 'monthly'],
  ['تغطية مصورة لتوقيع مذكرة تفاهم مع جامعة الملك سعود', 'تصوير احترافي للتوقيع مع لقطات بروتوكولية قابلة لإعادة الاستخدام إعلاميًا.', 'urgent', 'video', 'prod', 'u6', 'u3', -4, -2, 3, 1, 30, 'inprogress', '', '', null, null, null],
  ['إعداد ملفات الضيوف للمؤتمر الدولي', 'سير ذاتية، صور رسمية، جداول المشاركة، بطاقات التعريف، وملف بروتوكولي لكل ضيف.', 'high', 'event', 'pr', 'u7', 'u4', -16, -13, 10, -5, 100, 'done', '', '', -5, 4, null],
  ['إنفوغرافيك إنجازات وامي للربع الثاني', 'تحويل بيانات التقرير الربعي إلى إنفوغرافيك مؤسسي بلغتين.', 'medium', 'design', 'prod', 'u8', 'u1', -6, -3, 8, 5, 35, 'inprogress', '', '', null, null, null],
  ['أرشفة المكتبة البصرية للفعاليات', 'فهرسة وتصنيف الصور والفيديو حسب الفعالية والتاريخ ووسم الحقوق.', 'low', 'admin', 'prod', 'u6', 'u3', -46, -40, 35, 20, 40, 'inprogress', '', '', null, null, null],
  ['إعادة صياغة الرسائل المؤسسية الرئيسية', 'تحديث رسائل وامي الأساسية لاستخدامها في كل المخرجات.', 'high', 'stmt', 'media', 'u2', 'u1', -21, -18, 14, -3, 85, 'approval', 'المسودة الثالثة جاهزة، بانتظار اعتماد الأمانة العامة.', '', null, null, null],
  ['تحديث دليل البروتوكول والاستقبال', 'تحديث دليل مراسم الاستقبال والزيارات ليشمل الممارسات الدولية.', 'medium', 'admin', 'pr', 'u12', 'u4', -33, -28, 22, -8, 60, 'inprogress', '', 'انشغال الفريق بتنظيم زيارتين رسميتين غير مجدولتين.', null, null, null],
  ['حملة رقمية للتعريف ببرنامج المنح الطلابية', 'خطة محتوى 3 أسابيع: فيديو قصير، بوستات، قصص، وإعلان مدفوع محدود.', 'high', 'design', 'media', 'u9', 'u2', -5, -1, 16, 14, 12, 'inprogress', '', '', null, null, null],
  ['مراجعة النسخة الإنجليزية من التقرير السنوي', 'مراجعة الترجمة والمصطلحات المؤسسية ومطابقتها للنسخة العربية.', 'medium', 'report', 'media', 'u5', 'u2', -3, 1, 9, 11, 0, 'notstarted', '', '', null, null, null],
  ['تجهيز غرفة الاجتماعات الرئيسية بنظام عرض حديث', 'مواصفات فنية، عروض أسعار، وتركيب نظام عرض وصوت مناسب للاجتماعات الرسمية.', 'medium', 'admin', 'it', 'u10', 'u1', -19, -15, 18, 3, 50, 'waiting', 'بانتظار موافقة الشؤون المالية على العرض المعتمد.', '', null, null, null],
  ['تقرير أثر الملتقى الدولي للشباب', 'قياس التغطية الإعلامية والوصول والتفاعل وربطها بأهداف الاتصال المؤسسي.', 'high', 'report', 'media', 'u9', 'u1', -13, -10, 11, -1, 100, 'done', '', '', -1, 5, null],
  ['تصميم الهدايا الرسمية للضيوف', 'اقتراح وتصميم هدايا بروتوكولية تعكس هوية وامي مع عروض أسعار التصنيع.', 'low', 'design', 'pr', 'u8', 'u4', -27, -22, 20, 9, 25, 'onhold', 'معلقة مؤقتًا لحين اعتماد ميزانية الفعاليات.', '', null, null, null],
  ['تحديث بيانات الموقع الإلكتروني — قسم الأخبار', 'نقل الأرشيف الإخباري وتصحيح الوسوم والصور المصغرة.', 'low', 'admin', 'it', 'u10', 'u1', -40, -36, 15, -12, 75, 'inprogress', '', 'أولوية أعلى لصيانة الخوادم خلال فترة الملتقى.', null, null, null],
  ['إعداد خطة الاتصال المؤسسي للعام القادم', 'أهداف، جمهور، رسائل، قنوات، مؤشرات قياس، وميزانية تقديرية.', 'urgent', 'report', 'media', 'u1', 'u1', -7, -5, 25, 18, 22, 'inprogress', '', '', null, null, null],
  ['تصوير بورتريهات القيادات التنفيذية', 'جلسة تصوير رسمية موحدة الإضاءة والخلفية للمواد المؤسسية.', 'medium', 'video', 'prod', 'u6', 'u3', -10, -8, 5, -6, 100, 'done', '', '', -5, 4, null],
  ['ترتيب زيارة سفير جمهورية إندونيسيا', 'برنامج الزيارة، الاستقبال، جلسة التوقيع، التغطية، والضيافة.', 'urgent', 'event', 'pr', 'u7', 'u4', -2, 0, 6, 3, 15, 'new', '', '', null, null, null],
  ['نشرة وامي الداخلية — عدد أغسطس', 'جمع مواد الإدارات، التحرير، التصميم، والإرسال البريدي الداخلي.', 'medium', 'report', 'media', 'u5', 'u2', -6, -4, 8, 2, 58, 'inprogress', '', '', null, null, 'monthly'],
  ['دراسة ممارسات الاتصال في المنظمات الدولية المماثلة', 'تحليل مقارن لخمس منظمات دولية واستخلاص توصيات قابلة للتطبيق.', 'medium', 'monitor', 'media', 'u2', 'u1', -17, -14, 16, 7, 48, 'inprogress', '', '', null, null, null],
  ['موشن جرافيك تعريفي ببرامج وامي', 'فيديو موشن 60 ثانية بلغتين مع تعليق صوتي احترافي.', 'high', 'video', 'prod', 'u8', 'u3', -15, -11, 14, -2, 80, 'inprogress', '', 'تأخر اعتماد النص النهائي من إدارة البرامج.', null, null, null],
  ['تنسيق ورشة تدريبية للمتطوعين', 'الحجز، الدعوات، المواد التدريبية، الضيافة، والتوثيق.', 'medium', 'event', 'prog', 'u11', 'u4', -12, -9, 12, 8, 52, 'inprogress', '', '', null, null, null],
  ['أرشفة البيانات الصحفية الصادرة خلال العام', 'حصر البيانات الصادرة وتصنيفها وربطها بالتغطيات الناتجة عنها.', 'low', 'admin', 'media', 'u9', 'u2', -25, -20, 14, -9, 100, 'done', '', '', -10, 3, null],
  ['إعداد كتيب تعريفي مطبوع عن وامي', 'محتوى، تصميم، تدقيق، ومطابقة الهوية، ثم عرض سعر الطباعة.', 'medium', 'design', 'prod', 'u8', 'u1', -34, -30, 24, 12, 38, 'inprogress', '', '', null, null, null],
  ['مراجعة عقود مزودي خدمات التصوير', 'مراجعة الأسعار والشروط والبدائل وتقديم توصية تعاقدية سنوية.', 'low', 'admin', 'prod', 'u3', 'u1', -20, -16, 10, -11, 30, 'onhold', '', 'بانتظار استكمال بيانات المزودين من الشؤون الإدارية.', null, null, null],
  ['تغطية إفطار الشراكات المجتمعية', 'تغطية مصورة وخبر صحفي ومقاطع للمنصات.', 'medium', 'news', 'media', 'u5', 'u2', -44, -42, 5, -38, 100, 'done', '', '', -38, 4, null],
  ['إعادة تصميم القالب البريدي للمراسلات الرسمية', 'قالب موحد للبريد الرسمي والدعوات يتوافق مع الهوية.', 'low', 'design', 'media', 'u8', 'u1', -52, -48, 9, -40, 100, 'done', '', '', -41, 4, null],
  ['حصر احتياجات معدات التصوير للعام القادم', 'قائمة معدات، أولويات الشراء، وعروض أسعار مقارنة.', 'medium', 'admin', 'prod', 'u3', 'u1', -18, -15, 12, -4, 100, 'done', '', '', -2, 3, null],
  ['خطة إدارة الأزمات الإعلامية', 'سيناريوهات، متحدث رسمي، رسائل جاهزة، وسلسلة اعتماد سريعة.', 'high', 'report', 'media', 'u1', 'u1', -29, -24, 20, -7, 65, 'inprogress', '', 'تعارض مع أولويات تغطية الملتقى الدولي.', null, null, null],
  ['تدريب فريق الإدارات على رفع الأخبار عبر النظام', 'ورشة قصيرة ودليل مختصر لضمان جودة المادة الواردة من الإدارات.', 'low', 'admin', 'media', 'u2', 'u1', -1, 2, 5, 10, 0, 'new', '', '', null, null, null],
  ['إعداد تقرير الأداء الأسبوعي للإدارة العليا', 'ملخص تنفيذي بمؤشرات الإنجاز والتأخير والمهام الحرجة.', 'high', 'report', 'media', 'u1', 'u1', -3, -1, 2, 1, 60, 'inprogress', '', '', null, null, 'weekly'],
];

const SUBTASKS = {
  'T-0001': [['خطة التغطية واعتمادها', 1], ['خبر الافتتاح', 1], ['تقرير يومي × 3', 1], ['مقابلات الضيوف', 0], ['تقرير الختام والأثر', 0]],
  'T-0003': [['السيناريو والمعالجة', 1], ['التصوير الميداني', 1], ['المونتاج الأولي', 1], ['الموشن جرافيك', 0], ['التعليق الصوتي والمزج', 0], ['نسخ المنصات', 0]],
  'T-0005': [['اعتماد الفندق', 1], ['ترتيبات النقل', 1], ['برنامج الزيارة', 0], ['الضيافة والهدايا', 0], ['خطة التوثيق المصور', 0]],
  'T-0006': [['حصر ثلاثة عروض', 1], ['مصفوفة المقارنة', 1], ['زيارة ميدانية للقاعات', 1], ['رفع التوصية', 1], ['اعتماد الإدارة', 0]],
};
const COMMENTS = {
  'T-0001': [['u1', 'رجاءً رفع أولوية المقابلات — القيمة الإعلامية فيها أعلى من التقرير اليومي.', -6],
             ['u5', 'تم التنسيق مع @فيصل الدوسري لتصوير مقابلتين غدًا صباحًا.', -4]],
  'T-0005': [['u4', 'التأكيد على أن يكون الاستقبال في صالة كبار الشخصيات مع مندوب مراسم.', -5],
             ['u7', 'تم حجز الفندق وتأكيد النقل؛ برنامج الزيارة بانتظار الاعتماد.', -2]],
  'T-0006': [['u4', 'قارن القيمة مقابل التكلفة لا السعر فقط، وبيّن التكاليف الخفية في كل عرض.', -4]],
};
const EXTS = {
  'T-0004': [[-14, -4, 'إعادة توجيه من الإدارة العليا لاعتماد لوحة ألوان جديدة', 'u1']],
  'T-0013': [[-20, -14, 'انشغال الفريق بزيارة رسمية طارئة', 'u4'], [-14, -8, 'استكمال مراجعة فصل المراسم الدولية', 'u4']],
  'T-0019': [[-20, -12, 'أولوية صيانة الخوادم خلال الملتقى', 'u1']],
  'T-0025': [[-8, -2, 'تأخر اعتماد النص النهائي من إدارة البرامج', 'u3']],
};

(async () => {
  try {
    const domain = (process.env.ALLOWED_DOMAIN || 'wamy.org').toLowerCase();

    for (const [i, [id, name]] of DEPTS.entries())
      await q('INSERT INTO departments(id,name,sort) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name', [id, name, i]);
    for (const [i, [id, name]] of CATS.entries())
      await q('INSERT INTO categories(id,name,sort) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name', [id, name, i]);
    for (const [i, [id, name, cls, color, open]] of STATUSES.entries())
      await q(`INSERT INTO statuses(id,name,cls,color,is_open,sort) VALUES($1,$2,$3,$4,$5,$6)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, cls=EXCLUDED.cls, color=EXCLUDED.color, is_open=EXCLUDED.is_open, sort=EXCLUDED.sort`,
        [id, name, cls, color, open, i]);
    for (const [id, name, cls, color, rank] of PRIS)
      await q(`INSERT INTO priorities(id,name,cls,color,rank) VALUES($1,$2,$3,$4,$5)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, cls=EXCLUDED.cls, color=EXCLUDED.color, rank=EXCLUDED.rank`,
        [id, name, cls, color, rank]);
    for (const [i, [id, name, type, req, cats]] of CFS.entries())
      await q(`INSERT INTO custom_fields(id,name,type,required,cats,sort) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [id, name, type, req, JSON.stringify(cats), i]);

    /* ---- الإعدادات والهوية ---- */
    const readLogo = (f) => {
      const p = path.join(__dirname, '..', 'assets', f);
      return fs.existsSync(p) ? 'data:image/svg+xml;base64,' + fs.readFileSync(p).toString('base64') : null;
    };
    await setSetting('cfg', { ...SETTING_DEFAULTS.cfg, domains: [domain] });
    await setSetting('brand', { ...SETTING_DEFAULTS.brand, logo: readLogo('logo.svg'), logoDark: readLogo('logo-dark.svg') });

    /* ---- مدير النظام ---- */
    const adminEmail = (process.env.ADMIN_EMAIL || `admin@${domain}`).toLowerCase();
    const adminPass = process.env.ADMIN_PASSWORD || '';
    if (!adminPass || adminPass.length < 10) {
      console.error('✖ اضبط ADMIN_PASSWORD (10 أحرف فأكثر) في ملف .env قبل التهيئة.');
      process.exit(1);
    }
    const exists = await one('SELECT id FROM users WHERE lower(email)=lower($1)', [adminEmail]);
    if (!exists) {
      await q(`INSERT INTO users(id,name,email,password_hash,dept_id,role,title,must_change_pw)
               VALUES('u1',$1,$2,$3,'media','admin',$4,true)`,
        [process.env.ADMIN_NAME || 'مدير النظام', adminEmail, await hash(adminPass), 'مدير الإعلام والاتصال المؤسسي']);
      console.log(`✔ أُنشئ حساب مدير النظام: ${adminEmail}`);
    } else console.log('• حساب مدير النظام موجود مسبقًا — لم يُعدَّل.');

    if (!DEMO) { console.log('✔ اكتملت التهيئة الأساسية. أضف --demo لبيانات الاختبار.'); await pool.end(); return; }

    /* ---- بيانات الاختبار ---- */
    const demoPass = process.env.DEMO_PASSWORD || 'Wamy@2026demo';
    const ph = await hash(demoPass);
    for (const [id, name, local, dept, role, title] of DEMO_USERS)
      await q(`INSERT INTO users(id,name,email,password_hash,dept_id,role,title,must_change_pw)
               VALUES($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT (id) DO NOTHING`,
        [id, name, `${local}@${domain}`, ph, dept, role, title]);

    let n = 0;
    for (const t of DEMO_TASKS) {
      const [title, desc, pri, cat, dept, asg, cre, cD, sD, est, dD, prog, st, notes, delay, clD, qual, recur] = t;
      const id = 'T-' + String(++n).padStart(4, '0');
      await q(
        `INSERT INTO tasks(id,title,description,priority_id,category_id,dept_id,assignee_id,creator_id,status_id,
           created_date,start_date,est_days,due_date,closed_date,progress,notes,delay_reason,quality,recur)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING`,
        [id, title, desc, pri, cat, dept, asg, cre, st, D(cD), D(sD), est, D(dD), clD == null ? null : D(clD), prog, notes, delay, qual, recur]
      );
      await q('INSERT INTO activity(task_id,user_id,type,text,created_at) VALUES($1,$2,$3,$4,$5)',
        [id, cre, 'create', 'أنشأ المهمة وأسندها إلى ' + (DEMO_USERS.find((u) => u[0] === asg)?.[1] || 'مدير النظام'), new Date(Date.now() + cD * MS)]);
      if (prog > 0) await q('INSERT INTO activity(task_id,user_id,type,text,created_at) VALUES($1,$2,$3,$4,$5)',
        [id, asg, 'status', 'بدأ التنفيذ — تغيير الحالة إلى «قيد التنفيذ»', new Date(Date.now() + sD * MS)]);
      if (st === 'done') await q('INSERT INTO activity(task_id,user_id,type,text,created_at) VALUES($1,$2,$3,$4,$5)',
        [id, asg, 'done', 'سجّل اكتمال المهمة', new Date(Date.now() + clD * MS)]);
    }
    for (const [tid, arr] of Object.entries(SUBTASKS))
      for (const [i, [title, done]] of arr.entries())
        await q('INSERT INTO subtasks(task_id,title,done,sort) VALUES($1,$2,$3,$4)', [tid, title, !!done, i]);
    for (const [tid, arr] of Object.entries(COMMENTS))
      for (const [uid, body, off] of arr)
        await q('INSERT INTO comments(task_id,user_id,body,created_at) VALUES($1,$2,$3,$4)', [tid, uid, body, new Date(Date.now() + off * MS)]);
    for (const [tid, arr] of Object.entries(EXTS))
      for (const [f, t2, reason, by] of arr)
        await q('INSERT INTO extensions(task_id,from_date,to_date,reason,by_user) VALUES($1,$2,$3,$4,$5)', [tid, D(f), D(t2), reason, by]);

    console.log(`✔ أُضيفت ${DEMO_TASKS.length} مهمة و${DEMO_USERS.length} مستخدم تجريبي.`);
    console.log(`  كلمة مرور الحسابات التجريبية: ${demoPass}`);
    await pool.end();
  } catch (e) {
    console.error('✖ فشل التهيئة:', e.message);
    await pool.end();
    process.exit(1);
  }
})();
