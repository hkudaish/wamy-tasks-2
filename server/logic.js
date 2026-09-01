'use strict';
/* ============================================================
   منطق العمل — يُحتسب على الخادم وحده (المصدر الوحيد للحقيقة)
   لا يُسمح للعميل باحتساب التأخير أو التقييم أو تعيين حالة «متأخرة».
   ============================================================ */

const MS = 86400000;
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const toDate = (v) => { const d = new Date(typeof v === 'string' ? v.slice(0, 10) + 'T00:00:00' : v); d.setHours(0, 0, 0, 0); return d; };
/* التاريخ بالتقويم المحلي. toISOString يحوّل إلى UTC فيرتد يومًا في التوقيتات الموجبة. */
const orgScope = (me) => (me.orgIds && me.orgIds.length ? me.orgIds : [me.organization_id].filter(Boolean));
const iso = (d) => { const x = new Date(d), p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / MS);
const daysFromToday = (d) => Math.round((toDate(d) - toDate(today())) / MS);
const addDays = (d, n) => iso(new Date(toDate(d).getTime() + n * MS));

const CLOSED_STATUSES = new Set(['done', 'cancelled']);

/** الحالة الفعلية: «متأخرة» تُحسب ولا تُسند يدويًا */
function effStatus(t, cfg, statusMap) {
  if (!cfg.autoLate) return t.status_id;
  const s = statusMap.get(t.status_id);
  const open = s ? s.is_open : true;
  if (open && t.status_id !== 'cancelled' && daysFromToday(t.due_date) < 0 && t.progress < 100) return 'late';
  return t.status_id;
}
const isDone = (t) => t.status_id === 'done';
const lateDays = (t) =>
  isDone(t) ? Math.max(0, diffDays(t.due_date, t.closed_date || t.due_date)) : Math.max(0, -daysFromToday(t.due_date));

/** معادلة التقييم — نفس معادلة النموذج المعتمد */
function evaluate(t, cfg) {
  const ld = lateDays(t);
  const timeliness = Math.max(0, 100 - ld * 8);
  const quality = t.quality ? t.quality * 20 : t.progress >= 100 ? 80 : 70;
  const endRef = t.closed_date || iso(today());
  const actual = Math.max(1, diffDays(t.start_date, endRef));
  const speed = Math.max(0, Math.min(100, (t.est_days / actual) * 85));
  const w = cfg.weights;
  let score = timeliness * w.timeliness + quality * w.quality + speed * w.speed;
  if (!isDone(t)) score = score * (0.55 + 0.45 * (t.progress / 100));
  score = Math.round(Math.max(0, Math.min(100, score)));
  return { score, timeliness: Math.round(timeliness), quality: Math.round(quality), speed: Math.round(speed), lateDays: ld, grade: grade(score) };
}
function grade(s) {
  if (s >= 90) return 'ممتاز';
  if (s >= 80) return 'جيد جدًا';
  if (s >= 70) return 'جيد';
  if (s >= 60) return 'يحتاج متابعة';
  if (s >= 45) return 'متأخر';
  return 'متعثر';
}

const RECUR_STEP = { daily: 1, weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };
const RECUR_AR = { daily: 'يومية', weekly: 'أسبوعية', monthly: 'شهرية', quarterly: 'ربع سنوية', yearly: 'سنوية' };

/* ---------- الصلاحيات ---------- */
function canSeeTask(me, t) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  if (['secretary_general','assistant_secretary_general'].includes(me.role))
    return !me.organization_id || t.organization_id === me.organization_id;
  if (me.role === 'director') return orgScope(me).includes(t.organization_id) || t.assignee_id === me.id || t.creator_id === me.id;
  if (me.role === 'manager') return t.dept_id === me.dept_id;
  return t.assignee_id === me.id || t.creator_id === me.id;
}
/** صلاحية الإدارة الكاملة: التعديل، إعادة الإسناد، الاعتماد، التقييم */
function canManageTask(me, t) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  if (me.permissions?.manage_tasks === false) return false;
  if (['secretary_general','assistant_secretary_general'].includes(me.role))
    return !me.organization_id || t.organization_id === me.organization_id;
  if (me.role === 'director') return orgScope(me).includes(t.organization_id) || (t.assignee_id === me.id && t.creator_id === me.id);
  return me.role === 'manager' && t.dept_id === me.dept_id;
}
/** صلاحية التحديث المحدود: الحالة، النسبة، الملاحظات، المرفقات، التعليقات */
function canUpdateTask(me, t) {
  return canManageTask(me, t) || t.assignee_id === me.id;
}
/** شرط SQL لتقييد ما يراه المستخدم — يُطبَّق في الاستعلام لا في الواجهة */
function visibilityClause(me, startIndex = 1) {
  if (me.role === 'admin') return { sql: 'TRUE', params: [] };
  if (['secretary_general','assistant_secretary_general'].includes(me.role)) {
    if (!me.organization_id) return { sql: 'TRUE', params: [] };
    return { sql: `EXISTS (SELECT 1 FROM departments vd WHERE vd.id=t.dept_id AND vd.organization_id=$${startIndex})`, params:[me.organization_id] };
  }
  if (me.role === 'director')
    return {
      sql: `(EXISTS (SELECT 1 FROM departments vd WHERE vd.id=t.dept_id AND vd.organization_id = ANY($${startIndex})) OR t.assignee_id=$${startIndex+1} OR t.creator_id=$${startIndex+2})`,
      params: [orgScope(me),me.id,me.id],
    };
  if (me.role === 'manager')
    return {
      sql: `t.dept_id = $${startIndex}`,
      params: [me.dept_id],
    };
  return { sql: `(t.assignee_id = $${startIndex} OR t.creator_id = $${startIndex + 1})`, params: [me.id, me.id] };
}


/* ============================================================
   رقم الجوال — يُسلَّم إلى بوابة SMS/واتساب دولية
   رقم محلي بلا مفتاح دولة يُرسَل إلى العدم بصمت، أو إلى رقم آخر
   في دولة أخرى. لذلك نفرض الصيغة الدولية ونحوّل ما يمكن تحويله.
   ============================================================ */
const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || '966').replace(/\D/g, '');

function normPhone(v) {
  let p = String(v == null ? '' : v)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))   // أرقام عربية
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))   // أرقام فارسية
    .replace(/[\s\-().]/g, '')
    .trim();
  if (!p) return { phone: '' };

  let note = null;
  if (p.startsWith('00')) { p = '+' + p.slice(2); note = 'حُوّل 00 إلى +'; }
  else if (/^0\d{8,13}$/.test(p)) {
    p = '+' + DEFAULT_CC + p.slice(1);
    note = `رقم محلي — أُضيف مفتاح الدولة +${DEFAULT_CC}`;
  } else if (/^[1-9]\d{7,14}$/.test(p)) {
    return { error: 'أضف مفتاح الدولة: اكتب الرقم بالصيغة الدولية مثل +9665XXXXXXXX. الرقم بلا مفتاح دولة لا يصل عبر SMS أو واتساب.' };
  }

  if (!/^\+[1-9]\d{7,14}$/.test(p))
    return { error: 'رقم الجوال غير صالح. استخدم الصيغة الدولية مثل +9665XXXXXXXX.' };
  return { phone: p, note };
}

module.exports = {
  MS, today, toDate, iso, diffDays, daysFromToday, addDays,
  effStatus, isDone, lateDays, evaluate, grade,
  RECUR_STEP, RECUR_AR, CLOSED_STATUSES,
  canSeeTask, canManageTask, canUpdateTask, visibilityClause, orgScope,
  normPhone,
};
