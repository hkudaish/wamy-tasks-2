'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { q, one, all, tx, getSetting } = require('./db');
const L = require('./logic');
const { notify } = require('./mailer');
const { requireAuth } = require('./auth');
const S = require('./storage');

const router = express.Router();
/* المرفقات تُخزَّن على القرص عبر server/storage.js.
   multer يكتب مؤقتًا إلى tmp ثم نقرأ ملفًا واحدًا في كل مرة، فلا يتجاوز
   استهلاك الذاكرة حجم ملف واحد مهما بلغ عدد الملفات المرفوعة. */
const TMP_DIR = path.join(os.tmpdir(), 'wamy-uploads');
fs.mkdirSync(TMP_DIR, { recursive: true });

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/(pdf|zip|msword|vnd\.|octet-stream)|text\/(plain|csv))/;
const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, TMP_DIR),
    filename: (_r, f, cb) =>
      cb(null, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + path.extname(f.originalname).slice(0, 12)),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  fileFilter: (_r, f, cb) => cb(null, ALLOWED_MIME.test(f.mimetype)),
});

/* ============================================================
   أدوات
   ============================================================ */
const audit = (taskId, userId, type, text) =>
  q('INSERT INTO activity(task_id,user_id,type,text) VALUES($1,$2,$3,$4)', [taskId, userId, type, text]);

const fmtDate = (d) => {
  if (!d) return '—';
  const M = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const x = L.toDate(d);
  return `${x.getUTCDate()} ${M[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};

const STEP_UNIT_MS = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
const STEP_UNITS = new Set(Object.keys(STEP_UNIT_MS));
function parseStepAt(v, endOfDay = false) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += endOfDay ? 'T23:59:00+03:00' : 'T00:00:00+03:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00+03:00';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function stepLocal(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 16);
}
const stepDate = (v) => (stepLocal(v) || '').slice(0, 10) || null;
const EVENT_UNIT_MS = STEP_UNIT_MS;
const EVENT_UNITS = STEP_UNITS;
const TASK_DURATION_UNITS = new Set(['hour', 'day', 'month']);
const TASK_DURATION_DAYS = { hour: 1 / 24, day: 1, month: 30 };

function taskDuration(body, current = null) {
  const rawValue = body.duration !== undefined ? body.duration
    : body.est !== undefined ? body.est
    : current?.duration_value ?? current?.est_days ?? 1;
  const value = Number(rawValue);
  const unit = body.durationUnit !== undefined ? String(body.durationUnit) : current?.duration_unit || 'day';
  if (!Number.isFinite(value) || value <= 0)
    return { error: 'مدة المهمة يجب أن تكون رقمًا أكبر من صفر.' };
  if (!TASK_DURATION_UNITS.has(unit))
    return { error: 'وحدة مدة المهمة غير مدعومة.' };
  const rounded = Math.round(value * 100) / 100;
  return { value: rounded, unit, days: Math.max(1, Math.ceil(rounded * TASK_DURATION_DAYS[unit])) };
}

function eventStatus(e, at = new Date()) {
  if (e.cancelled_at) return 'cancelled';
  const start = e.start_at ? new Date(e.start_at) : null;
  const end = e.end_at ? new Date(e.end_at) : null;
  if (start && end && at >= start && at <= end) return 'live';
  if (end && at > end) return 'ended';
  return 'upcoming';
}

function deriveEventTiming(b) {
  const unit = EVENT_UNITS.has(b.durationUnit || b.unit) ? (b.durationUnit || b.unit) : 'day';
  let duration = b.duration !== undefined && b.duration !== null && b.duration !== ''
    ? Number(b.duration) : null;
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) duration = null;
  let startAt = parseStepAt(b.startAt || b.start);
  let endAt = parseStepAt(b.endAt || b.end, true);
  const span = duration ? duration * EVENT_UNIT_MS[unit] : null;
  if (startAt && span && !endAt) endAt = new Date(startAt.getTime() + span);
  else if (startAt && endAt && !duration) duration = Math.max(0.01, Math.round(((endAt - startAt) / EVENT_UNIT_MS[unit]) * 100) / 100);
  else if (!startAt && endAt && span) startAt = new Date(endAt.getTime() - span);
  return { startAt, duration, unit, endAt };
}

function serializeEvent(e) {
  const start = e.start_at ? new Date(e.start_at) : null;
  const end = e.end_at ? new Date(e.end_at) : null;
  const status = eventStatus(e);
  return {
    id: e.id,
    title: e.title,
    typeId: e.type_id,
    typeName: e.type_name,
    typeDesc: e.type_description,
    desc: e.summary,
    organizerDept: e.organizer_dept_id,
    organizerDeptName: e.organizer_dept_name,
    country: e.country || '',
    city: e.city || '',
    location: e.location || '',
    participants: Array.isArray(e.participants) ? e.participants : [],
    startAt: start ? start.toISOString() : null,
    endAt: end ? end.toISOString() : null,
    duration: e.duration_value == null ? null : Number(e.duration_value),
    durationUnit: e.duration_unit || 'day',
    notes: e.notes || '',
    status,
    cancelledAt: e.cancelled_at ? new Date(e.cancelled_at).toISOString() : null,
    createdBy: e.created_by,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

async function loadEvents() {
  const rows = await all(
    `SELECT e.*, t.name type_name, t.description type_description, d.name organizer_dept_name
     FROM events e
     LEFT JOIN event_types t ON t.id = e.type_id
     LEFT JOIN departments d ON d.id = e.organizer_dept_id
     ORDER BY COALESCE(e.start_at, e.created_at) DESC`
  );
  return rows.map(serializeEvent);
}

async function eventRecipients() {
  const rows = await all(
    `SELECT id FROM users WHERE active=true AND role IN ('admin','secretary_general','assistant_secretary_general','director','manager')`
  );
  return rows.map((r) => r.id);
}

function eventScopeAllowed(me, organizerDeptId, organizationId) {
  if (!me) return false;
  if (me.role === 'admin' || me.permissions?.manage_events === true) return true;
  if (['secretary_general', 'assistant_secretary_general'].includes(me.role)) return !me.organization_id || !organizationId || organizationId === me.organization_id;
  if (me.role === 'director') return !organizationId || L.orgScope(me).includes(organizationId);
  if (me.role === 'manager') return organizerDeptId === me.dept_id;
  return false;
}

async function statusMap() {
  const rows = await all('SELECT * FROM statuses');
  return new Map(rows.map((r) => [r.id, r]));
}

async function deptManagers(deptId) {
  const rows = await all(
    `SELECT u.id FROM users u LEFT JOIN departments d ON d.id=$1
     WHERE u.active=true AND (u.role IN ('admin','secretary_general','assistant_secretary_general') OR (u.role='director' AND u.organization_id=d.organization_id) OR (u.role='manager' AND u.dept_id=$1))`, [deptId]
  );
  return rows.map((r) => r.id);
}

/** نطاق الإسناد: مدير النظام لرؤساء الأقسام والموظفين، ورئيس القسم لموظفي قسمه فقط. */
function canAssignTo(me, user) {
  if (!me || !user || !user.active) return false;
  if (user.id === me.id) return true;
  if (me.permissions?.assign_others === false) return false;
  if (me.role === 'admin') return ['manager', 'employee'].includes(user.role);
  if (['secretary_general','assistant_secretary_general'].includes(me.role))
    return user.role === 'director' && (!me.organization_id || user.organization_id === me.organization_id);
  if (me.role === 'director') return L.orgScope(me).includes(user.organization_id) && ['manager', 'employee', 'consultant'].includes(user.role);
  if (me.role === 'manager') return user.role === 'employee' && user.dept_id === me.dept_id;
  return false;
}

async function validateAssignee(me, userId) {
  const user = await one('SELECT * FROM users WHERE id=$1 AND active=true', [userId]);
  if (!user) return { error: 'الموظف المُسنَد إليه غير موجود أو غير مفعّل.' };
  if (user.dept_id) {
    const dep = await one('SELECT hidden FROM departments WHERE id=$1', [user.dept_id]);
    if (dep && dep.hidden) return { error: 'هذا الموظف ضمن جهة مخفية من القوائم. أظهرها من لوحة التحكم أولًا.' };
  }
  if (!canAssignTo(me, user)) {
    if (['employee', 'consultant'].includes(me.role)) return { error: 'لا تملك صلاحية إسناد المهام أو نقلها إلى غيره.' };
    if (me.role === 'director') return { error: 'لا يمكنك الإسناد خارج إدارتك.' };
    if (me.role === 'manager') {
      const d = user.dept_id ? (await one('SELECT name FROM departments WHERE id=$1', [user.dept_id]))?.name : null;
      return { error: user.role !== 'employee'
        ? `لا يمكنك الإسناد إلى ${user.name} — الإسناد مقصور على موظفي قسمك.`
        : `لا يمكنك الإسناد خارج إدارتك. ${user.name} يتبع «${d || 'إدارة أخرى'}».` };
    }
    return { error: 'الإسناد مقصور على رئيس قسم أو موظف.' };
  }
  return { user };
}

/** تحويل صف قاعدة البيانات إلى الشكل الذي تتوقعه الواجهة */
function serialize(t, extras = {}) {
  return {
    id: t.id, title: t.title, desc: t.description,
    pri: t.priority_id, cat: t.category_id, dept: t.dept_id,
    assignee: t.assignee_id, creator: t.creator_id, status: t.status_id,
    created: L.iso(t.created_date), start: L.iso(t.start_date), due: L.iso(t.due_date),
    closed: t.closed_date ? L.iso(t.closed_date) : null,
    est: t.est_days,
    durationValue: t.duration_value == null ? t.est_days : Number(t.duration_value),
    durationUnit: t.duration_unit || 'day',
    progress: t.progress, notes: t.notes, delayReason: t.delay_reason,
    quality: t.quality, recur: t.recur, recurDone: t.recur_done, parentRecur: t.parent_recur,
    cf: t.cf || {}, updated: t.updated_at,
    planRef: t.plan_ref, planYear: t.plan_year,
    steps: extras.steps || [],
    subtasks: extras.subtasks || [], comments: extras.comments || [],
    ext: extras.ext || [], attachments: extras.attachments || [], log: extras.log || [],
  };
}

async function loadTasks(me, ids) {
  const vis = L.visibilityClause(me, 1);
  const params = [...vis.params];
  let where = vis.sql;
  if (ids && ids.length) { params.push(ids); where += ` AND t.id = ANY($${params.length})`; }
  const tasks = await all(`SELECT t.*, d.organization_id FROM tasks t LEFT JOIN departments d ON d.id=t.dept_id WHERE (d.id IS NULL OR d.hidden=false) AND (${where}) ORDER BY t.due_date`, params);
  if (!tasks.length) return [];
  const tids = tasks.map((t) => t.id);

  const [subs, cmts, exts, atts, logs, stps] = await Promise.all([
    all('SELECT * FROM subtasks WHERE task_id = ANY($1) ORDER BY sort, id', [tids]),
    all('SELECT * FROM comments WHERE task_id = ANY($1) ORDER BY created_at', [tids]),
    all('SELECT * FROM extensions WHERE task_id = ANY($1) ORDER BY created_at', [tids]),
    all('SELECT * FROM attachments WHERE task_id = ANY($1) ORDER BY created_at', [tids]),
    all(`SELECT * FROM (
           SELECT *, row_number() OVER (PARTITION BY task_id ORDER BY created_at DESC) rn
           FROM activity WHERE task_id = ANY($1)) x WHERE rn <= 60 ORDER BY created_at DESC`, [tids]),
    all('SELECT * FROM steps WHERE task_id = ANY($1) ORDER BY sort, id', [tids]),
  ]);
  const g = (arr, k) => arr.reduce((m, r) => ((m[r[k]] = m[r[k]] || []).push(r), m), {});
  const S = g(subs, 'task_id'), C = g(cmts, 'task_id'), E = g(exts, 'task_id'), A = g(atts, 'task_id'),
        G = g(logs, 'task_id'), P = g(stps, 'task_id');

  return tasks.map((t) =>
    serialize(t, {
      subtasks: (S[t.id] || []).map((s) => ({ id: Number(s.id), title: s.title, done: s.done })),
      comments: (C[t.id] || []).map((c) => ({ id: Number(c.id), user: c.user_id, at: c.created_at, text: c.body, mentions: c.mentions, parent: c.parent_id ? Number(c.parent_id) : null })),
      ext: (E[t.id] || []).map((e) => ({ from: L.iso(e.from_date), to: L.iso(e.to_date), reason: e.reason, by: e.by_user, at: L.iso(e.created_at) })),
      attachments: (A[t.id] || []).map((a) => ({ id: Number(a.id), name: a.orig_name, size: Number(a.size), type: a.mime, by: a.uploaded_by, at: a.created_at, url: `/api/attachments/${a.id}` })),
      log: (G[t.id] || []).map((l) => ({ at: l.created_at, by: l.user_id, type: l.type, txt: l.text })),
      steps: (P[t.id] || []).map((x) => ({
        id: Number(x.id), title: x.title,
        start: x.start_date ? L.iso(x.start_date) : null,
        days: x.duration_days, due: x.due_date ? L.iso(x.due_date) : null,
        startAt: stepLocal(x.start_at) || (x.start_date ? `${L.iso(x.start_date)}T00:00` : null),
        duration: x.duration_value == null ? x.duration_days : Number(x.duration_value),
        durationUnit: x.duration_unit || 'day',
        dueAt: stepLocal(x.due_at) || (x.due_date ? `${L.iso(x.due_date)}T23:59` : null),
        doneAt: x.done_date ? L.iso(x.done_date) : null,
        status: x.status, owner: x.owner_id, note: x.note, delayNote: x.delay_note || '',
      })),
    })
  );
}

async function getTask(id) {
  return one('SELECT t.*, d.organization_id FROM tasks t LEFT JOIN departments d ON d.id=t.dept_id WHERE t.id=$1', [id]);
}

async function nextTaskId(client) {
  await client.query('SELECT pg_advisory_xact_lock(4242)');
  const r = await client.query(
    `SELECT 'T-' || lpad((COALESCE(MAX(NULLIF(regexp_replace(id,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS id FROM tasks`
  );
  return r.rows[0].id;
}

/** إعادة احتساب نسبة الإنجاز من المهام الفرعية عند تفعيل الخيار */
async function syncSubtaskProgress(taskId, cfg, userId) {
  if (!cfg.progressFromSubtasks) return null;
  // تُحتسب النسبة من الإجراءات التنفيذية إن وُجدت، وإلا من المهام الفرعية
  const st = await all('SELECT status FROM steps WHERE task_id=$1', [taskId]);
  if (st.length) {
    const done = st.filter((r) => r.status === 'done').length;
    const doing = st.filter((r) => r.status === 'doing').length;
    const p2 = Math.round(((done + doing * 0.5) / st.length) * 100);
    await q('UPDATE tasks SET progress=$1 WHERE id=$2', [p2, taskId]);
    await audit(taskId, userId, 'progress', `تحديث تلقائي لنسبة الإنجاز من الإجراءات التنفيذية: ${p2}%`);
    return p2;
  }
  const rows = await all('SELECT done FROM subtasks WHERE task_id=$1', [taskId]);
  if (!rows.length) return null;
  const p = Math.round((rows.filter((r) => r.done).length / rows.length) * 100);
  await q('UPDATE tasks SET progress=$1 WHERE id=$2', [p, taskId]);
  await audit(taskId, userId, 'progress', `تحديث تلقائي لنسبة الإنجاز من المهام الفرعية: ${p}%`);
  return p;
}

/** توليد التكرار التالي بعد الإغلاق */
async function spawnRecurrence(t, userId) {
  if (!t.recur || t.recur_done) return null;
  const step = L.RECUR_STEP[t.recur] || 30;
  await q('UPDATE tasks SET recur_done=true WHERE id=$1', [t.id]);
  const nt = await tx(async (c) => {
    const id = await nextTaskId(c);
    await c.query(
      `INSERT INTO tasks(id,title,description,priority_id,category_id,dept_id,assignee_id,creator_id,status_id,
        created_date,start_date,est_days,duration_value,duration_unit,due_date,progress,notes,recur,parent_recur)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'new',CURRENT_DATE,$9,$10,$11,$12,$13,0,'',$14,$15)`,
      [id, t.title, t.description, t.priority_id, t.category_id, t.dept_id, t.assignee_id, t.creator_id,
       L.addDays(t.start_date, step), t.est_days, t.duration_value, t.duration_unit || 'day',
       L.addDays(t.due_date, step), t.recur, t.id]
    );
    const subs = await c.query('SELECT title, sort FROM subtasks WHERE task_id=$1 ORDER BY sort,id', [t.id]);
    for (const s of subs.rows) await c.query('INSERT INTO subtasks(task_id,title,done,sort) VALUES($1,$2,false,$3)', [id, s.title, s.sort]);
    return id;
  });
  await audit(nt, userId, 'create', `أُنشئت تلقائيًا كتكرار ${L.RECUR_AR[t.recur]} للمهمة ${t.id}`);
  await audit(t.id, userId, 'edit', `تم توليد التكرار التالي تلقائيًا: ${nt} (${L.RECUR_AR[t.recur]})`);
  return nt;
}

/* ============================================================
   بيانات الإقلاع
   ============================================================ */
router.get('/bootstrap', requireAuth, async (req, res) => {
  if (req.me.role === 'admin') await q(`INSERT INTO structure_people(id,employee_no,name,email,phone,title,suggested_role,organization_id,dept_id,active,linked_user_id)
    SELECT 'sp-'||u.id,u.employee_no,u.name,u.email,u.phone,u.title,u.role,u.organization_id,u.dept_id,u.active,u.id
    FROM users u WHERE u.employee_no IS NOT NULL AND u.role<>'admin' ON CONFLICT (lower(employee_no)) DO UPDATE SET
      name=EXCLUDED.name,email=EXCLUDED.email,phone=EXCLUDED.phone,title=EXCLUDED.title,
      suggested_role=EXCLUDED.suggested_role,organization_id=EXCLUDED.organization_id,
      dept_id=EXCLUDED.dept_id,active=EXCLUDED.active,linked_user_id=EXCLUDED.linked_user_id`);
  const globalScope = req.me.role==='admin' || (['secretary_general','assistant_secretary_general'].includes(req.me.role) && !req.me.organization_id);
  const myOrgs = L.orgScope(req.me);
  const orgFilter = globalScope ? { sql: 'TRUE', p: [] } : { sql: 'id = ANY($1)', p: [myOrgs] };
  const deptFilter = globalScope ? { sql: 'TRUE', p: [] } : { sql: 'organization_id = ANY($1)', p: [myOrgs] };
  const userFilter = globalScope ? { sql: 'TRUE', p: [] }
    : ['secretary_general','assistant_secretary_general'].includes(req.me.role) ? { sql: 'organization_id=$1', p:[req.me.organization_id] }
    : req.me.role === 'director' ? { sql: 'organization_id = ANY($1)', p: [myOrgs] }
    : req.me.role === 'manager' ? { sql: '(dept_id=$1 OR id=$2)', p: [req.me.dept_id, req.me.id] }
    : { sql: 'id=$1', p: [req.me.id] };
  const [orgs, depts, cats, sts, pris, cfs, users, cfg, brand, filters, structurePeople, eventTypes, events] = await Promise.all([
    all(`SELECT id,code,name,director_id FROM organizations WHERE ${orgFilter.sql} ORDER BY sort,name`, orgFilter.p),
    all(`SELECT id,code,name,organization_id,head_id FROM departments WHERE hidden=false AND (${deptFilter.sql}) ORDER BY sort,name`, deptFilter.p),
    all('SELECT id,name FROM categories ORDER BY sort,name'),
    all('SELECT id,name,cls,color,is_open FROM statuses ORDER BY sort'),
    all('SELECT id,name,cls,color,rank FROM priorities ORDER BY rank DESC'),
    all('SELECT id,name,type,required,cats FROM custom_fields ORDER BY sort,id'),
    all(`SELECT id,employee_no,manager_id,name,email,phone,dept_id,organization_id,role,title,active,permissions FROM users WHERE active=true AND (dept_id IS NULL OR dept_id NOT IN (SELECT id FROM departments WHERE hidden)) AND ${userFilter.sql} ORDER BY name`, userFilter.p),
    getSetting('cfg'),
    getSetting('brand'),
    all('SELECT id,name,payload FROM saved_filters WHERE user_id=$1 ORDER BY id', [req.me.id]),
    req.me.role === 'admin' ? all('SELECT id,employee_no,name,email,phone,title,suggested_role,organization_id,dept_id,manager_employee_no,active,linked_user_id FROM structure_people ORDER BY name') : [],
    all('SELECT id,name,description,sort,active FROM event_types ORDER BY sort,name'),
    loadEvents(),
  ]);
  /* المخفيون: يُعادون لمدير النظام وحده وفي مصفوفة منفصلة، حتى يظهروا في
     صفحة «المستخدمون والصلاحيات» فقط دون التسرب إلى أي قائمة أخرى. */
  const isAdmin = req.me.role === 'admin';
  const [hiddenUsers, hiddenDepts] = isAdmin ? await Promise.all([
    all(`SELECT u.id,u.employee_no,u.name,u.email,u.phone,u.dept_id,u.organization_id,u.role,u.title
           FROM users u JOIN departments d ON d.id=u.dept_id
          WHERE u.active=true AND d.hidden ORDER BY u.name`),
    all('SELECT id,code,name,organization_id FROM departments WHERE hidden ORDER BY sort,name'),
  ]) : [[], []];
  res.json({
    me: req.me,
    hiddenUsers: hiddenUsers.map((u) => ({ id:u.id, employeeNo:u.employee_no, name:u.name, email:u.email,
      phone:u.phone, dept:u.dept_id, organization:u.organization_id, role:u.role, title:u.title, hidden:true })),
    hiddenDepts: hiddenDepts.map((d) => ({ id:d.id, code:d.code, name:d.name, organization:d.organization_id })),
    organizations: orgs.map(o=>({id:o.id,code:o.code,name:o.name,director:o.director_id})),
    depts: depts.map((d) => ({ id:d.id, code:d.code, name:d.name, organization:d.organization_id, head:d.head_id })), categories: cats,
    statuses: sts.map((s) => ({ id: s.id, name: s.name, cls: s.cls, color: s.color, open: s.is_open })),
    priorities: pris,
    customFields: cfs.map((c) => ({ id: c.id, name: c.name, type: c.type, req: c.required, cats: c.cats })),
    users: users.map((u) => ({ id:u.id, employeeNo:u.employee_no, manager:u.manager_id, name:u.name, email:u.email, phone:u.phone, dept:u.dept_id, organization:u.organization_id, role:u.role, title:u.title, permissions:u.permissions||{} })),
    structurePeople: structurePeople.map(p=>({id:p.id,employeeNo:p.employee_no,name:p.name,email:p.email,phone:p.phone,title:p.title,role:p.suggested_role,organization:p.organization_id,dept:p.dept_id,managerEmployeeNo:p.manager_employee_no,active:p.active,linkedUserId:p.linked_user_id})),
    cfg, brand,
    savedFilters: filters.map((f) => ({ id: Number(f.id), name: f.name, f: f.payload })),
    eventTypes: eventTypes.map((t) => ({ id: t.id, name: t.name, description: t.description, sort: t.sort, active: t.active })),
    events,
    serverTime: new Date().toISOString(),
  });
});

/* ============================================================
   المهام
   ============================================================ */
router.get('/tasks', requireAuth, async (req, res) => {
  res.json({ tasks: await loadTasks(req.me) });
});

router.get('/tasks/:id', requireAuth, async (req, res) => {
  const list = await loadTasks(req.me, [req.params.id]);
  if (!list.length) return res.status(404).json({ error: 'المهمة غير موجودة أو لا تملك صلاحية عليها.' });
  res.json({ task: list[0] });
});

router.post('/tasks', requireAuth, async (req, res) => {
  const b = req.body || {};
  if(req.me.role!=='admin'&&req.me.permissions?.create_self===false&&b.assignee===req.me.id)return res.status(403).json({error:'صلاحية إنشاء مهمة شخصية معطّلة لهذا المستخدم.'});
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'اسم المهمة مطلوب.' });
  if (!b.assignee || !b.due || !b.start) return res.status(400).json({ error: 'المسؤول وتاريخ البدء والموعد النهائي حقول إلزامية.' });
  if (L.diffDays(b.start, b.due) < 0) return res.status(400).json({ error: 'الموعد النهائي يسبق تاريخ البدء.' });
  const duration = taskDuration(b);
  if (duration.error) return res.status(400).json({ error: duration.error });

  const checked = await validateAssignee(req.me, b.assignee);
  if (checked.error) return res.status(req.me.role === 'employee' ? 403 : 400).json({ error: checked.error });
  const assignee = checked.user;

  const id = await tx(async (c) => {
    const nid = await nextTaskId(c);
    await c.query(
      `INSERT INTO tasks(id,title,description,priority_id,category_id,dept_id,assignee_id,creator_id,status_id,
        start_date,est_days,duration_value,duration_unit,due_date,progress,notes,recur)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [nid, String(b.title).trim(), b.desc || '', b.pri || 'medium', b.cat || 'admin',
       assignee.dept_id, b.assignee, req.me.id, b.status || 'new',
       b.start, duration.days, duration.value, duration.unit, b.due,
       Math.min(100, Math.max(0, Number(b.progress) || 0)), b.notes || '', b.recur || null]
    );
    return nid;
  });
  await audit(id, req.me.id, 'create', `أنشأ المهمة وأسندها إلى ${assignee.name}`);
  await notify({ kind: 'assign', taskId: id, actorId: req.me.id, to: [b.assignee],
    body: `أُسندت إليك مهمة جديدة «${b.title}» — الاستحقاق ${fmtDate(b.due)}` });
  if ((b.pri || 'medium') === 'urgent')
    await notify({ kind: 'urgent', taskId: id, actorId: req.me.id, to: [b.assignee],
      body: `مهمة عاجلة جديدة «${b.title}» — الاستحقاق ${fmtDate(b.due)}` });
  const list = await loadTasks(req.me, [id]);
  res.status(201).json({ task: list[0] });
});

/** تعديل شامل — للمديرين فقط */
router.patch('/tasks/:id', requireAuth, async (req, res) => {
  const t = await getTask(req.params.id);
  if (!t || !L.canSeeTask(req.me, t)) return res.status(404).json({ error: 'المهمة غير موجودة.' });
  if (!L.canManageTask(req.me, t)) return res.status(403).json({ error: 'تعديل بيانات المهمة مقصور على المدير.' });

  const b = req.body || {};
  if (b.assignee !== undefined && b.assignee !== t.assignee_id) {
    const checked = await validateAssignee(req.me, b.assignee);
    if (checked.error) return res.status(403).json({ error: checked.error });
    // الإدارة تتبع الموظف الجديد — لا نثق بما ترسله الواجهة عند تغيير المسؤول
    b.dept = checked.user.dept_id;
  }
  const changes = [];
  const set = [], vals = [];
  const put = (col, val, label, fmt) => {
    if (val === undefined) return;
    const cur = t[col];
    const same = String(cur instanceof Date ? L.iso(cur) : cur) === String(val);
    if (same) return;
    set.push(`${col}=$${vals.length + 1}`); vals.push(val);
    if (label) changes.push(`${label}: ${fmt ? fmt(cur) : cur} ← ${fmt ? fmt(val) : val}`);
  };
  put('title', b.title); put('description', b.desc);
  put('priority_id', b.pri); put('category_id', b.cat);
  put('dept_id', b.dept); put('assignee_id', b.assignee, 'المسؤول');
  put('start_date', b.start);
  if (b.duration !== undefined || b.durationUnit !== undefined || b.est !== undefined) {
    const duration = taskDuration(b, t);
    if (duration.error) return res.status(400).json({ error: duration.error });
    put('est_days', duration.days);
    put('duration_value', duration.value);
    put('duration_unit', duration.unit);
  }
  put('due_date', b.due, 'الموعد', fmtDate);
  put('notes', b.notes); put('recur', b.recur === '' ? null : b.recur);
  if (b.status !== undefined && b.status !== t.status_id && b.status !== 'late') {
    put('status_id', b.status, 'الحالة');
    if (b.status === 'done') { set.push(`closed_date=CURRENT_DATE`); set.push(`progress=100`); }
    else set.push(`closed_date=NULL`);
  }
  if (b.progress !== undefined && Number(b.progress) !== t.progress)
    put('progress', Math.min(100, Math.max(0, Number(b.progress))), 'الإنجاز');

  if (!set.length) return res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
  vals.push(t.id);
  await q(`UPDATE tasks SET ${set.join(',')} WHERE id=$${vals.length}`, vals);
  await audit(t.id, req.me.id, 'edit', 'عدّل المهمة' + (changes.length ? ' — ' + changes.join('، ') : ''));

  if (b.due !== undefined && L.iso(t.due_date) !== b.due)
    await notify({ kind: 'deadline', taskId: t.id, actorId: req.me.id, to: [b.assignee || t.assignee_id],
      body: `تغيّر الموعد النهائي لـ«${t.title}» إلى ${fmtDate(b.due)}` });
  if (b.assignee && b.assignee !== t.assignee_id)
    await notify({ kind: 'assign', taskId: t.id, actorId: req.me.id, to: [b.assignee],
      body: `أُسندت إليك المهمة «${t.title}»` });
  if (b.pri === 'urgent' && t.priority_id !== 'urgent')
    await notify({ kind: 'urgent', taskId: t.id, actorId: req.me.id, to: [b.assignee || t.assignee_id],
      body: `صُنّفت المهمة «${t.title}» كمهمة عاجلة وتتطلب اهتمامك` });
  if (b.status === 'done') { const fresh = await getTask(t.id); await spawnRecurrence(fresh, req.me.id); }

  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

router.delete('/tasks/:id', requireAuth, async (req, res) => {
  if (req.me.role !== 'admin' && req.me.permissions?.delete_tasks !== true) return res.status(403).json({ error: 'لا تملك صلاحية حذف المهام.' });
  const t = await getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'المهمة غير موجودة.' });
  await q('DELETE FROM tasks WHERE id=$1', [t.id]);
  await q('INSERT INTO activity(task_id,user_id,type,text) VALUES(NULL,$1,$2,$3)', [req.me.id, 'delete', `حذف المهمة ${t.id} — «${t.title}»`]);
  res.json({ ok: true });
});

/* ============================================================
   الفعاليات والمناسبات
   ============================================================ */
router.get('/events', requireAuth, async (_req, res) => {
  const [types, events] = await Promise.all([
    all('SELECT id,name,description,sort,active FROM event_types ORDER BY sort,name'),
    loadEvents(),
  ]);
  res.json({
    eventTypes: types.map((t) => ({ id: t.id, name: t.name, description: t.description, sort: t.sort, active: t.active })),
    events,
  });
});

router.get('/events/:id', requireAuth, async (req, res) => {
  const row = await one(
    `SELECT e.*, t.name type_name, t.description type_description, d.name organizer_dept_name
     FROM events e
     LEFT JOIN event_types t ON t.id = e.type_id
     LEFT JOIN departments d ON d.id = e.organizer_dept_id
     WHERE e.id=$1`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'الفعالية غير موجودة.' });
  res.json({ event: serializeEvent(row) });
});

router.post('/events', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!eventScopeAllowed(req.me, b.organizerDept || null, null)) return res.status(403).json({ error: 'لا تملك صلاحية إضافة الفعاليات.' });
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'اسم الفعالية مطلوب.' });
  const type = await one('SELECT id,active FROM event_types WHERE id=$1', [b.typeId]);
  if (!type || !type.active) return res.status(400).json({ error: 'نوع الفعالية غير متاح.' });
  const start = deriveEventTiming(b);
  if (!start.startAt) return res.status(400).json({ error: 'تاريخ البداية مطلوب.' });
  if (!start.endAt) return res.status(400).json({ error: 'تاريخ النهاية أو المدة مطلوبان.' });
  if (start.endAt <= start.startAt) return res.status(400).json({ error: 'تاريخ النهاية يجب أن يلي تاريخ البداية.' });
  const organizerDept = b.organizerDept || null;
  if (!organizerDept) return res.status(400).json({ error: 'الإدارة المنظمة الرئيسية مطلوبة.' });
  const d = await one('SELECT id,organization_id FROM departments WHERE id=$1', [organizerDept]);
  if (!d) return res.status(400).json({ error: 'الإدارة المنظمة غير موجودة.' });
  if (!eventScopeAllowed(req.me, organizerDept, d.organization_id)) return res.status(403).json({ error: 'لا يمكنك إنشاء فعالية خارج نطاقك.' });
  const participants = Array.isArray(b.participants) ? [...new Set(b.participants.filter((x) => typeof x === 'string' && x.trim()))] : [];
  const ids = participants.filter((id) => id !== organizerDept);
  const eventId = 'ev-' + Date.now().toString(36);
  await q(
    `INSERT INTO events(id,title,type_id,summary,organizer_dept_id,created_by,start_at,end_at,duration_value,duration_unit,country,city,location,participants,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [eventId, title, type.id, String(b.summary || ''), organizerDept, req.me.id, start.startAt, start.endAt, start.duration, start.unit,
      String(b.country || ''), String(b.city || ''), String(b.location || ''), JSON.stringify(ids), String(b.notes || '')]
  );
  await q('INSERT INTO activity(task_id,user_id,type,text) VALUES(NULL,$1,$2,$3)', [
    req.me.id, 'event', `أضاف فعالية «${title}»`,
  ]);
  const recipients = await eventRecipients();
  await notify({
    kind: 'event_new',
    actorId: req.me.id,
    to: recipients,
    body: `تمت إضافة فعالية جديدة: ${title} – ${L.iso(start.startAt)} – ${(b.country || '').trim() || '—'}${b.city ? '، ' + b.city : ''}`,
  });
  const row = await one(
    `SELECT e.*, t.name type_name, t.description type_description, d.name organizer_dept_name
     FROM events e
     LEFT JOIN event_types t ON t.id = e.type_id
     LEFT JOIN departments d ON d.id = e.organizer_dept_id
     WHERE e.id=$1`,
    [eventId]
  );
  res.status(201).json({ event: serializeEvent(row) });
});

router.patch('/events/:id', requireAuth, async (req, res) => {
  const current = await one('SELECT * FROM events WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'الفعالية غير موجودة.' });
  const currentDept = current.organizer_dept_id ? await one('SELECT id,organization_id FROM departments WHERE id=$1', [current.organizer_dept_id]) : null;
  if (!eventScopeAllowed(req.me, current.organizer_dept_id, currentDept?.organization_id)) return res.status(403).json({ error: 'لا تملك صلاحية تعديل هذه الفعالية.' });

  const b = req.body || {};
  const set = [], vals = [], notes = [];
  const put = (col, val, label) => { if (val === undefined) return; set.push(`${col}=$${vals.length + 1}`); vals.push(val); if (label) notes.push(label); };
  if (b.title !== undefined) put('title', String(b.title).trim(), 'العنوان');
  if (b.summary !== undefined) put('summary', String(b.summary), 'الوصف');
  if (b.typeId !== undefined) {
    const type = await one('SELECT id,active FROM event_types WHERE id=$1', [b.typeId]);
    if (!type || !type.active) return res.status(400).json({ error: 'نوع الفعالية غير متاح.' });
    put('type_id', type.id, 'النوع');
  }
  if (b.organizerDept !== undefined) {
    const d = b.organizerDept ? await one('SELECT id,organization_id FROM departments WHERE id=$1', [b.organizerDept]) : null;
    if (b.organizerDept && !d) return res.status(400).json({ error: 'الإدارة المنظمة غير موجودة.' });
    put('organizer_dept_id', b.organizerDept || null, 'الإدارة المنظمة');
  }
  if (b.country !== undefined) put('country', String(b.country), 'الدولة');
  if (b.city !== undefined) put('city', String(b.city), 'المدينة');
  if (b.location !== undefined) put('location', String(b.location), 'الموقع');
  if (b.notes !== undefined) put('notes', String(b.notes), 'ملاحظات');
  if (b.participants !== undefined) {
    const participants = Array.isArray(b.participants) ? [...new Set(b.participants.filter((x) => typeof x === 'string' && x.trim()))] : [];
    put('participants', JSON.stringify(participants), 'الإدارات المشاركة');
  }
  if (b.cancel === true || b.status === 'cancelled') {
    put('cancelled_at', new Date(), 'الإلغاء');
    notes.push('أُلغيَت');
  } else if (b.cancel === false && current.cancelled_at) {
    put('cancelled_at', null, 'إلغاء الإلغاء');
  }
  if (b.startAt !== undefined || b.start !== undefined || b.endAt !== undefined || b.end !== undefined || b.duration !== undefined || b.durationUnit !== undefined || b.unit !== undefined) {
    const timing = deriveEventTiming({
      startAt: b.startAt !== undefined ? b.startAt : b.start,
      endAt: b.endAt !== undefined ? b.endAt : b.end,
      duration: b.duration,
      durationUnit: b.durationUnit,
      unit: b.unit,
    });
    if (timing.startAt && timing.endAt && timing.endAt <= timing.startAt)
      return res.status(400).json({ error: 'تاريخ النهاية يجب أن يلي تاريخ البداية.' });
    put('start_at', timing.startAt, 'تاريخ البداية');
    put('end_at', timing.endAt, 'تاريخ النهاية');
    put('duration_value', timing.duration, 'المدة');
    put('duration_unit', timing.unit, 'وحدة المدة');
  }
  if (!set.length) {
    const row = await one(
      `SELECT e.*, t.name type_name, t.description type_description, d.name organizer_dept_name
       FROM events e
       LEFT JOIN event_types t ON t.id = e.type_id
       LEFT JOIN departments d ON d.id = e.organizer_dept_id
       WHERE e.id=$1`,
      [req.params.id]
    );
    return res.json({ event: serializeEvent(row) });
  }
  vals.push(req.params.id);
  await q(`UPDATE events SET ${set.join(',')} WHERE id=$${vals.length}`, vals);
  await q('INSERT INTO activity(task_id,user_id,type,text) VALUES(NULL,$1,$2,$3)', [
    req.me.id, 'event', `عدّل فعالية «${current.title}»${notes.length ? ' — ' + notes.join('، ') : ''}`,
  ]);
  const recipients = await eventRecipients();
  await notify({
    kind: b.cancel === true || b.status === 'cancelled' ? 'event_cancel' : 'event_update',
    actorId: req.me.id,
    to: recipients,
    body: b.cancel === true || b.status === 'cancelled'
      ? `تم إلغاء فعالية: ${b.title || current.title}`
      : `تم تحديث فعالية: ${b.title || current.title} – ${(b.startAt || b.start || L.iso(current.start_at)) || '—'} – ${(b.location || current.location || '—')}`,
  });
  const row = await one(
    `SELECT e.*, t.name type_name, t.description type_description, d.name organizer_dept_name
     FROM events e
     LEFT JOIN event_types t ON t.id = e.type_id
     LEFT JOIN departments d ON d.id = e.organizer_dept_id
     WHERE e.id=$1`,
    [req.params.id]
  );
  res.json({ event: serializeEvent(row) });
});

/* ============================================================
   إجراءات المهمة — كل قاعدة عمل تُفرض هنا
   ============================================================ */
router.post('/tasks/:id/action', requireAuth, async (req, res) => {
  const t = await getTask(req.params.id);
  if (!t || !L.canSeeTask(req.me, t)) return res.status(404).json({ error: 'المهمة غير موجودة.' });
  if (!L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية تحديث هذه المهمة.' });

  const cfg = await getSetting('cfg');
  const SM = await statusMap();
  const { action, value, reason } = req.body || {};
  const manager = L.canManageTask(req.me, t);
  const canApprove = manager && req.me.permissions?.approve_close !== false;
  const nameOf = (id) => (SM.get(id) || { name: id }).name;

  switch (action) {
    /* ---- نسبة الإنجاز ---- */
    case 'progress': {
      const p = Math.min(100, Math.max(0, Number(value) || 0));
      const old = t.progress;
      let status = t.status_id;
      if (p === 100 && t.status_id !== 'done') status = 'approval';
      else if (p > 0 && ['new', 'notstarted'].includes(t.status_id)) status = 'inprogress';
      await q('UPDATE tasks SET progress=$1, status_id=$2 WHERE id=$3', [p, status, t.id]);
      await audit(t.id, req.me.id, 'progress', `حدّث نسبة الإنجاز من ${old}% إلى ${p}%`);
      if (status === 'approval' && t.status_id !== 'approval')
        await notify({ kind: 'approval', taskId: t.id, actorId: req.me.id, to: [...(await deptManagers(t.dept_id)), t.creator_id],
          body: `«${t.title}» بلغت 100% وبانتظار اعتماد الإغلاق` });
      break;
    }

    /* ---- تغيير الحالة (لا يُقبل تعيين «متأخرة» يدويًا) ---- */
    case 'status': {
      if (value === 'late') return res.status(400).json({ error: '«متأخرة» حالة تُحتسب تلقائيًا ولا تُسند يدويًا.' });
      if (!SM.has(value)) return res.status(400).json({ error: 'حالة غير معروفة.' });
      if (value === 'done' && !canApprove) return res.status(403).json({ error: 'لا تملك صلاحية اعتماد الإغلاق. استخدم «تسجيل الاكتمال» لإرساله للاعتماد.' });
      const old = nameOf(t.status_id);
      if (value === 'done') await q('UPDATE tasks SET status_id=$1, progress=100, closed_date=CURRENT_DATE WHERE id=$2', [value, t.id]);
      else await q('UPDATE tasks SET status_id=$1, closed_date=NULL WHERE id=$2', [value, t.id]);
      await audit(t.id, req.me.id, 'status', `غيّر الحالة من «${old}» إلى «${nameOf(value)}»`);
      if (value === 'done') { await spawnRecurrence(await getTask(t.id), req.me.id);
        await notify({ kind: 'approved', taskId: t.id, actorId: req.me.id, to: [t.assignee_id], body: `اعتُمد إغلاق مهمتك «${t.title}»` }); }
      break;
    }

    /* ---- تسجيل الاكتمال ---- */
    case 'complete': {
      if (canApprove) {
        await q(`UPDATE tasks SET status_id='done', progress=100, closed_date=CURRENT_DATE WHERE id=$1`, [t.id]);
        await audit(t.id, req.me.id, 'done', 'اعتمد اكتمال المهمة وأغلقها');
        await spawnRecurrence(await getTask(t.id), req.me.id);
        await notify({ kind: 'approved', taskId: t.id, actorId: req.me.id, to: [t.assignee_id], body: `اعتُمد إغلاق مهمتك «${t.title}»` });
      } else {
        await q(`UPDATE tasks SET status_id='approval', progress=100 WHERE id=$1`, [t.id]);
        await audit(t.id, req.me.id, 'status', 'سجّل اكتمال المهمة — بانتظار اعتماد المدير');
        await notify({ kind: 'approval', taskId: t.id, actorId: req.me.id, to: [...(await deptManagers(t.dept_id)), t.creator_id],
          body: `«${t.title}» بانتظار اعتماد الإغلاق — أنهاها ${req.me.name}` });
      }
      break;
    }

    /* ---- اعتماد الإغلاق ---- */
    case 'approve': {
      if (!canApprove) return res.status(403).json({ error: 'لا تملك صلاحية اعتماد الإغلاق.' });
      const qv = value ? Math.min(5, Math.max(1, Number(value))) : t.quality;
      await q(`UPDATE tasks SET status_id='done', progress=100, closed_date=CURRENT_DATE, quality=$1 WHERE id=$2`, [qv, t.id]);
      await audit(t.id, req.me.id, 'done', 'اعتمد إغلاق المهمة' + (qv ? ` — تقييم الجودة: ${['','ضعيف','يحتاج متابعة','جيد','جيد جدًا','ممتاز'][qv]}` : ''));
      await spawnRecurrence(await getTask(t.id), req.me.id);
      await notify({ kind: 'approved', taskId: t.id, actorId: req.me.id, to: [t.assignee_id], body: `اعتُمد إغلاق مهمتك «${t.title}»` });
      break;
    }

    /* ---- إرجاع للتنفيذ ---- */
    case 'reject': {
      if (!manager) return res.status(403).json({ error: 'الإرجاع مقصور على المدير.' });
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'الإرجاع يتطلب سببًا موثقًا.' });
      await q(`UPDATE tasks SET status_id='inprogress', progress=LEAST(progress,90), closed_date=NULL WHERE id=$1`, [t.id]);
      await audit(t.id, req.me.id, 'status', 'أرجع المهمة للتنفيذ — السبب: ' + reason.trim());
      await notify({ kind: 'rejected', taskId: t.id, actorId: req.me.id, to: [t.assignee_id],
        body: `أُرجعت مهمتك «${t.title}» للتنفيذ — السبب: ${reason.trim()}` });
      break;
    }

    /* ---- إعادة الفتح ---- */
    case 'reopen': {
      if (!manager) return res.status(403).json({ error: 'إعادة الفتح مقصورة على المدير.' });
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'إعادة الفتح تتطلب سببًا موثقًا.' });
      await q(`UPDATE tasks SET status_id='inprogress', progress=LEAST(progress,85), closed_date=NULL WHERE id=$1`, [t.id]);
      await audit(t.id, req.me.id, 'status', 'أعاد فتح المهمة بعد اكتمالها — السبب: ' + reason.trim());
      await notify({ kind: 'reopen', taskId: t.id, actorId: req.me.id, to: [t.assignee_id, t.creator_id],
        body: `أُعيد فتح المهمة «${t.title}» — السبب: ${reason.trim()}` });
      break;
    }

    /* ---- تمديد الموعد ---- */
    case 'extend': {
      if (!value) return res.status(400).json({ error: 'الموعد الجديد مطلوب.' });
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'التمديد يتطلب سببًا موثقًا.' });
      if (L.diffDays(L.iso(t.due_date), value) <= 0) return res.status(400).json({ error: 'الموعد الجديد يجب أن يكون بعد الموعد الحالي.' });
      await q('INSERT INTO extensions(task_id,from_date,to_date,reason,by_user) VALUES($1,$2,$3,$4,$5)',
        [t.id, L.iso(t.due_date), value, reason.trim(), req.me.id]);
      await q('UPDATE tasks SET due_date=$1 WHERE id=$2', [value, t.id]);
      await audit(t.id, req.me.id, 'extend', `مدّد الموعد من ${fmtDate(t.due_date)} إلى ${fmtDate(value)} — السبب: ${reason.trim()}`);
      await notify({ kind: 'extend', taskId: t.id, actorId: req.me.id, to: [t.assignee_id, t.creator_id, ...(await deptManagers(t.dept_id))],
        body: `مُدِّد موعد «${t.title}» إلى ${fmtDate(value)} — السبب: ${reason.trim()}` });
      break;
    }

    /* ---- إعادة الإسناد ---- */
    case 'reassign': {
      if (!manager || req.me.permissions?.reassign_tasks === false) return res.status(403).json({ error: 'لا تملك صلاحية إعادة الإسناد.' });
      if (value === t.assignee_id) return res.status(400).json({ error: 'المهمة مسندة إليه أصلًا.' });
      const chk = await validateAssignee(req.me, value);
      if (chk.error) return res.status(403).json({ error: chk.error });
      const u = chk.user;
      const prev = t.assignee_id;
      await q('UPDATE tasks SET assignee_id=$1, dept_id=$2 WHERE id=$3', [u.id, u.dept_id, t.id]);
      const prevName = (await one('SELECT name FROM users WHERE id=$1', [prev]))?.name || '—';
      await audit(t.id, req.me.id, 'assign',
        `أعاد إسناد المهمة من ${prevName} إلى ${u.name}${reason && reason.trim() ? ' — السبب: ' + reason.trim() : ''}`);
      await notify({ kind: 'assign', taskId: t.id, actorId: req.me.id, to: [u.id], body: `أُسندت إليك المهمة «${t.title}» — الاستحقاق ${fmtDate(t.due_date)}` });
      await notify({ kind: 'assign', taskId: t.id, actorId: req.me.id, to: [prev], body: `نُقلت المهمة «${t.title}» منك إلى ${u.name}` });
      break;
    }

    /* ---- حقول نصية ---- */
    case 'notes':
      await q('UPDATE tasks SET notes=$1 WHERE id=$2', [String(value || ''), t.id]);
      await audit(t.id, req.me.id, 'edit', 'حدّث ملاحظات التنفيذ'); break;

    case 'delayReason':
      await q('UPDATE tasks SET delay_reason=$1 WHERE id=$2', [String(value || ''), t.id]);
      await audit(t.id, req.me.id, 'edit', 'وثّق سبب التأخير'); break;

    case 'quality': {
      if (!manager) return res.status(403).json({ error: 'تقييم الجودة مقصور على المدير.' });
      const v = value ? Math.min(5, Math.max(1, Number(value))) : null;
      await q('UPDATE tasks SET quality=$1 WHERE id=$2', [v, t.id]);
      await audit(t.id, req.me.id, 'edit', `قيّم جودة التنفيذ: ${v ? ['','ضعيف','يحتاج متابعة','جيد','جيد جدًا','ممتاز'][v] : 'أُلغي التقييم'}`);
      break;
    }

    case 'cf': {
      const cf = { ...(t.cf || {}), ...(value || {}) };
      await q('UPDATE tasks SET cf=$1 WHERE id=$2', [cf, t.id]);
      await audit(t.id, req.me.id, 'edit', 'حدّث الحقول المخصصة'); break;
    }

    default:
      return res.status(400).json({ error: 'إجراء غير معروف.' });
  }

  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

/* ============================================================
   المهام الفرعية
   ============================================================ */
router.post('/tasks/:id/subtasks', requireAuth, async (req, res) => {
  const t = await getTask(req.params.id);
  if (!t || !L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'عنوان الخطوة مطلوب.' });
  await q('INSERT INTO subtasks(task_id,title,sort) VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM subtasks WHERE task_id=$1))', [t.id, title]);
  await audit(t.id, req.me.id, 'edit', 'أضاف خطوة تنفيذ: ' + title);
  await syncSubtaskProgress(t.id, await getSetting('cfg'), req.me.id);
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

router.patch('/subtasks/:sid', requireAuth, async (req, res) => {
  const s = await one('SELECT * FROM subtasks WHERE id=$1', [req.params.sid]);
  if (!s) return res.status(404).json({ error: 'غير موجود.' });
  const t = await getTask(s.task_id);
  if (!L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  await q('UPDATE subtasks SET done=$1 WHERE id=$2', [!!req.body?.done, s.id]);
  await audit(t.id, req.me.id, 'edit', `${req.body?.done ? 'أنجز' : 'أعاد فتح'} الخطوة: ${s.title}`);
  await syncSubtaskProgress(t.id, await getSetting('cfg'), req.me.id);
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

router.delete('/subtasks/:sid', requireAuth, async (req, res) => {
  const s = await one('SELECT * FROM subtasks WHERE id=$1', [req.params.sid]);
  if (!s) return res.status(404).json({ error: 'غير موجود.' });
  const t = await getTask(s.task_id);
  if (!L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  await q('DELETE FROM subtasks WHERE id=$1', [s.id]);
  await audit(t.id, req.me.id, 'edit', 'حذف الخطوة: ' + s.title);
  await syncSubtaskProgress(t.id, await getSetting('cfg'), req.me.id);
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

/* ============================================================
   الإجراءات التنفيذية — لكل إجراء إطار زمني مستقل
   ============================================================ */
/** يشتق التوقيت الناقص بدقة: بدء + مدة، أو بدء + موعد مستهدف. */
function deriveStepTiming(b, task) {
  const unit = STEP_UNITS.has(b.durationUnit || b.unit) ? (b.durationUnit || b.unit) : 'day';
  let duration = b.duration !== undefined && b.duration !== null && b.duration !== ''
    ? Number(b.duration) : (b.days ? Number(b.days) : null);
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) duration = null;
  let startAt = parseStepAt(b.startAt || b.start);
  let dueAt = parseStepAt(b.dueAt || b.due, true);
  if (!startAt && task) startAt = parseStepAt(`${L.iso(task.start_date)}T09:00`);
  const span = duration ? duration * STEP_UNIT_MS[unit] : null;
  if (startAt && span && !dueAt) dueAt = new Date(startAt.getTime() + span);
  else if (startAt && dueAt && !duration) duration = Math.max(0.01, Math.round(((dueAt - startAt) / STEP_UNIT_MS[unit]) * 100) / 100);
  else if (!startAt && dueAt && span) startAt = new Date(dueAt.getTime() - span);
  const days = duration ? Math.max(1, Math.ceil((duration * STEP_UNIT_MS[unit]) / 86400000)) : null;
  return { startAt, duration, unit, dueAt, start: stepDate(startAt), days, due: stepDate(dueAt) };
}

router.post('/tasks/:id/steps', requireAuth, async (req, res) => {
  const t = await getTask(req.params.id);
  if (!t || !L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'وصف الإجراء مطلوب.' });
  const timing = deriveStepTiming(b, t);
  if (timing.startAt && timing.dueAt && timing.dueAt <= timing.startAt) return res.status(400).json({ error: 'موعد الإنجاز المستهدف يجب أن يلي موعد البدء.' });
  const taskDueAt = parseStepAt(L.iso(t.due_date), true);
  if (timing.dueAt && taskDueAt && timing.dueAt > taskDueAt)
    return res.status(400).json({ error: `موعد الإجراء يتجاوز الموعد النهائي للمهمة (${L.iso(t.due_date)}). مدّد المهمة أولًا أو قصّر الإجراء.` });
  const owner = b.owner && (await one('SELECT id FROM users WHERE id=$1 AND active=true', [b.owner])) ? b.owner : null;
  await q(
    `INSERT INTO steps(task_id,title,start_date,duration_days,due_date,start_at,duration_value,duration_unit,due_at,status,owner_id,note,delay_note,sort)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,(SELECT COALESCE(MAX(sort),0)+1 FROM steps WHERE task_id=$1))`,
    [t.id, title, timing.start, timing.days, timing.due, timing.startAt, timing.duration, timing.unit, timing.dueAt, owner, String(b.note || ''), String(b.delayNote || '')]
  );
  await audit(t.id, req.me.id, 'step', `أضاف إجراءً: ${title}${timing.due ? ` — الإنجاز المستهدف ${fmtDate(timing.due)}` : ''}`);
  await syncSubtaskProgress(t.id, await getSetting('cfg'), req.me.id);
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

router.patch('/steps/:sid', requireAuth, async (req, res) => {
  const st = await one('SELECT * FROM steps WHERE id=$1', [req.params.sid]);
  if (!st) return res.status(404).json({ error: 'الإجراء غير موجود.' });
  const t = await getTask(st.task_id);
  if (!L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  const b = req.body || {};
  const set = [], vals = [], notes = [];

  if (b.title !== undefined && b.title !== st.title) {
    set.push(`title=$${vals.length + 1}`); vals.push(String(b.title).trim()); notes.push('الوصف');
  }
  if (b.start !== undefined || b.startAt !== undefined || b.days !== undefined || b.duration !== undefined || b.durationUnit !== undefined || b.unit !== undefined || b.due !== undefined || b.dueAt !== undefined) {
    const cur = {
      startAt: stepLocal(st.start_at) || (st.start_date ? `${L.iso(st.start_date)}T00:00` : null),
      duration: st.duration_value == null ? st.duration_days : Number(st.duration_value),
      durationUnit: st.duration_unit || 'day',
      dueAt: stepLocal(st.due_at) || (st.due_date ? `${L.iso(st.due_date)}T23:59` : null),
    };
    const durationProvided = b.days !== undefined || b.duration !== undefined;
    const durationChanged = durationProvided || b.durationUnit !== undefined || b.unit !== undefined;
    const dueChanged = b.due !== undefined || b.dueAt !== undefined;
    const nb = {
      startAt: b.startAt !== undefined ? b.startAt : (b.start !== undefined ? b.start : cur.startAt),
      duration: durationProvided ? (b.duration !== undefined ? b.duration : b.days) : (dueChanged ? null : cur.duration),
      durationUnit: b.durationUnit || b.unit || cur.durationUnit,
      dueAt: dueChanged ? (b.dueAt !== undefined ? b.dueAt : b.due) : (durationChanged || b.startAt !== undefined || b.start !== undefined ? null : cur.dueAt),
    };
    const der = deriveStepTiming(nb, t);
    if (der.startAt && der.dueAt && der.dueAt <= der.startAt) return res.status(400).json({ error: 'موعد الإنجاز المستهدف يجب أن يلي موعد البدء.' });
    const taskDueAt = parseStepAt(L.iso(t.due_date), true);
    if (der.dueAt && taskDueAt && der.dueAt > taskDueAt)
      return res.status(400).json({ error: `موعد الإجراء يتجاوز الموعد النهائي للمهمة (${L.iso(t.due_date)}).` });
    set.push(`start_date=$${vals.length + 1}`); vals.push(der.start);
    set.push(`duration_days=$${vals.length + 1}`); vals.push(der.days);
    set.push(`due_date=$${vals.length + 1}`); vals.push(der.due);
    set.push(`start_at=$${vals.length + 1}`); vals.push(der.startAt);
    set.push(`duration_value=$${vals.length + 1}`); vals.push(der.duration);
    set.push(`duration_unit=$${vals.length + 1}`); vals.push(der.unit);
    set.push(`due_at=$${vals.length + 1}`); vals.push(der.dueAt);
    notes.push('الإطار الزمني');
  }
  if (b.status !== undefined && ['pending', 'doing', 'done', 'blocked'].includes(b.status) && b.status !== st.status) {
    set.push(`status=$${vals.length + 1}`); vals.push(b.status);
    set.push(`done_date=${b.status === 'done' ? 'CURRENT_DATE' : 'NULL'}`);
    notes.push(`الحالة إلى «${{ pending: 'لم يبدأ', doing: 'جارٍ', done: 'منجز', blocked: 'متعثر' }[b.status]}»`);
  }
  if (b.owner !== undefined) { set.push(`owner_id=$${vals.length + 1}`); vals.push(b.owner || null); notes.push('المنفّذ'); }
  if (b.note !== undefined) { set.push(`note=$${vals.length + 1}`); vals.push(String(b.note)); }
  if (b.delayNote !== undefined) { set.push(`delay_note=$${vals.length + 1}`); vals.push(String(b.delayNote)); notes.push('ملاحظة التأخير'); }
  if (!set.length) return res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
  vals.push(st.id);
  await q(`UPDATE steps SET ${set.join(',')} WHERE id=$${vals.length}`, vals);
  await audit(t.id, req.me.id, 'step', `حدّث الإجراء «${st.title}»${notes.length ? ' — ' + notes.join('، ') : ''}`);
  await syncSubtaskProgress(t.id, await getSetting('cfg'), req.me.id);
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

router.delete('/steps/:sid', requireAuth, async (req, res) => {
  const st = await one('SELECT * FROM steps WHERE id=$1', [req.params.sid]);
  if (!st) return res.status(404).json({ error: 'الإجراء غير موجود.' });
  const t = await getTask(st.task_id);
  if (!L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  await q('DELETE FROM steps WHERE id=$1', [st.id]);
  await audit(t.id, req.me.id, 'step', 'حذف الإجراء: ' + st.title);
  await syncSubtaskProgress(t.id, await getSetting('cfg'), req.me.id);
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

/* ============================================================
   التعليقات
   ============================================================ */
router.post('/tasks/:id/comments', requireAuth, async (req, res) => {
  const t = await getTask(req.params.id);
  if (!t || !L.canSeeTask(req.me, t)) return res.status(404).json({ error: 'المهمة غير موجودة.' });
  const body = String(req.body?.text || '').trim();
  if (!body) return res.status(400).json({ error: 'التعليق فارغ.' });
  const users = await all('SELECT id,name FROM users WHERE active=true');
  const mentions = users.filter((u) => body.includes('@' + u.name)).map((u) => u.id);
  const parent = req.body?.parent ? Number(req.body.parent) : null;
  await q('INSERT INTO comments(task_id,user_id,body,parent_id,mentions) VALUES($1,$2,$3,$4,$5)',
    [t.id, req.me.id, body, parent, JSON.stringify(mentions)]);
  await audit(t.id, req.me.id, 'comment', (parent ? 'ردّ على تعليق' : 'أضاف تعليقًا') + (mentions.length ? ` وأشار إلى ${users.filter(u=>mentions.includes(u.id)).map(u=>u.name).join('، ')}` : ''));
  const snippet = body.slice(0, 70) + (body.length > 70 ? '…' : '');
  await notify({ kind: 'comment', taskId: t.id, actorId: req.me.id, to: [t.assignee_id, t.creator_id],
    body: `${req.me.name} ${parent ? 'ردّ' : 'علّق'} على «${t.title}»: ${snippet}` });
  if (mentions.length) await notify({ kind: 'mention', taskId: t.id, actorId: req.me.id, to: mentions, body: `أشار إليك ${req.me.name} في «${t.title}»` });
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

/* ============================================================
   المرفقات
   ============================================================ */
router.post('/tasks/:id/attachments', requireAuth, upload.array('files', 10), async (req, res) => {
  const t = await getTask(req.params.id);
  if (!t || !L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'لم يُرفع أي ملف مقبول. الأنواع المسموحة: صور، PDF، مستندات، نصوص.' });
  const stored = [];
  try {
    for (const f of files) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const key = S.newKey(t.id, name);
      const buf = await fs.promises.readFile(f.path);
      await S.save(buf, key, f.mimetype);
      stored.push(key);
      await q('INSERT INTO attachments(task_id,stored_name,orig_name,size,mime,uploaded_by) VALUES($1,$2,$3,$4,$5,$6)',
        [t.id, key, name, f.size, f.mimetype, req.me.id]);
      await audit(t.id, req.me.id, 'edit', `أرفق ملف: ${name}`);
    }
  } catch (e) {
    /* تنظيف ما رُفع قبل العطل حتى لا تبقى كائنات يتيمة في التخزين */
    for (const k of stored) await S.remove(k);
    console.error('[attachments]', e);
    return res.status(502).json({ error: 'تعذّر حفظ المرفق في التخزين. أعد المحاولة.' });
  } finally {
    for (const f of files) fs.promises.unlink(f.path).catch(() => {});
  }
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

router.get('/attachments/:aid', requireAuth, async (req, res) => {
  const a = await one('SELECT * FROM attachments WHERE id=$1', [req.params.aid]);
  if (!a) return res.status(404).json({ error: 'المرفق غير موجود.' });
  const t = await getTask(a.task_id);
  if (!L.canSeeTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  try { await S.serve(res, a.stored_name, a.orig_name); }
  catch (e) { console.error('[attachments]', e); res.status(502).json({ error: 'تعذّر جلب المرفق من التخزين.' }); }
});

router.delete('/attachments/:aid', requireAuth, async (req, res) => {
  const a = await one('SELECT * FROM attachments WHERE id=$1', [req.params.aid]);
  if (!a) return res.status(404).json({ error: 'المرفق غير موجود.' });
  const t = await getTask(a.task_id);
  if (!L.canUpdateTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية.' });
  await q('DELETE FROM attachments WHERE id=$1', [a.id]);
  await S.remove(a.stored_name);
  await audit(t.id, req.me.id, 'edit', 'حذف المرفق: ' + a.orig_name);
  res.json({ task: (await loadTasks(req.me, [t.id]))[0] });
});

/* ============================================================
   التنبيهات وسجل النشاط
   ============================================================ */
router.get('/notifications', requireAuth, async (req, res) => {
  const rows = await all(
    'SELECT id,kind,task_id,body,read_at,created_at FROM notifications WHERE to_user=$1 ORDER BY created_at DESC LIMIT 60',
    [req.me.id]
  );
  res.json({ notifications: rows.map((n) => ({ id: String(n.id), kind: n.kind, taskId: n.task_id, txt: n.body, at: n.created_at, read: !!n.read_at })) });
});

router.post('/notifications/read', requireAuth, async (req, res) => {
  const ids = req.body?.ids;
  if (Array.isArray(ids) && ids.length) await q('UPDATE notifications SET read_at=now() WHERE to_user=$1 AND id = ANY($2::bigint[])', [req.me.id, ids]);
  else await q('UPDATE notifications SET read_at=now() WHERE to_user=$1 AND read_at IS NULL', [req.me.id]);
  res.json({ ok: true });
});

/* ============================================================
   تفضيلات التنبيهات لكل مستخدم — القنوات ورقم الجوال
   ============================================================ */
router.get('/notification-preferences', requireAuth, async (req, res) => {
  const u = await one('SELECT phone,notification_prefs FROM users WHERE id=$1', [req.me.id]);
  res.json({
    phone: u?.phone || '', prefs: u?.notification_prefs || {},
    available: {
      app: true,
      email: !!process.env.SMTP_HOST,
      sms: !!process.env.SMS_WEBHOOK_URL,
      whatsapp: !!process.env.WHATSAPP_WEBHOOK_URL,
    },
  });
});

router.put('/notification-preferences', requireAuth, async (req, res) => {
  const ph = L.normPhone(req.body?.phone);
  if (ph.error) return res.status(400).json({ error: ph.error });
  const phone = ph.phone;
  const raw = req.body?.prefs || {};
  const CH = ['app', 'email', 'sms', 'whatsapp'];
  const channels = {};
  for (const c of CH) if (typeof raw.channels?.[c] === 'boolean') channels[c] = raw.channels[c];
  const kinds = {};
  for (const [kind, values] of Object.entries(raw.kinds || {}).slice(0, 30)) {
    kinds[kind] = {};
    for (const c of CH) if (typeof values?.[c] === 'boolean') kinds[kind][c] = values[c];
  }
  const prefs = { channels, kinds };
  await q('UPDATE users SET phone=$1, notification_prefs=$2 WHERE id=$3', [phone, prefs, req.me.id]);
  res.json({ phone, prefs, note: ph.note || undefined });
});

router.get('/activity', requireAuth, async (req, res) => {
  const vis = L.visibilityClause(req.me, 1);
  const globalActivity = req.me.role === 'admin' ? 'a.task_id IS NULL' : 'FALSE';
  const rows = await all(
    `SELECT a.*, t.title FROM activity a LEFT JOIN tasks t ON t.id=a.task_id
     WHERE ${globalActivity} OR ${vis.sql} ORDER BY a.created_at DESC LIMIT 150`, vis.params
  );
  res.json({ activity: rows.map((r) => ({ at: r.created_at, by: r.user_id, type: r.type, txt: r.text, taskId: r.task_id, taskTitle: r.title })) });
});

/* ---------- الفلاتر المحفوظة ---------- */
router.post('/filters', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم الفلتر مطلوب.' });
  const r = await one('INSERT INTO saved_filters(user_id,name,payload) VALUES($1,$2,$3) RETURNING id', [req.me.id, name, req.body?.f || {}]);
  res.json({ id: Number(r.id) });
});
router.delete('/filters/:fid', requireAuth, async (req, res) => {
  await q('DELETE FROM saved_filters WHERE id=$1 AND user_id=$2', [req.params.fid, req.me.id]);
  res.json({ ok: true });
});

/* ============================================================
   نظام المراسلات والمحادثات — وامي (إضافة 2026-09)
   محادثات مقيدة بالصلاحيات والهيكل الإداري وسياق المهام
   ============================================================ */

/** عدد الرسائل غير المقروءة للطرف الحالي (لشارة القائمة الجانبية) */
router.get('/chat/unread-count', requireAuth, async (req, res) => {
  if (!L.canViewChat(req.me)) return res.json({ unreadCount: 0 });
  const row = await one(
    `SELECT COUNT(m.id)::int as n
     FROM chat_messages m
     JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1 AND cp.is_active = true
     WHERE m.sender_id <> $1
       AND m.deleted_at IS NULL
       AND m.created_at > cp.last_read_at`,
    [req.me.id]
  );
  res.json({ unreadCount: row ? Number(row.n) : 0 });
});

/** جهات الاتصال المؤهلة للمراسلة فقط (حسب الهيكل والصلاحيات والمهام المشتركة) */
router.get('/chat/contacts', requireAuth, async (req, res) => {
  if (!L.canStartChat(req.me)) return res.json({ contacts: [] });

  // جلب المتعاونين في مهام مشتركة مع المستخدم الحالي
  const collabRows = await all(
    `SELECT DISTINCT assignee_id as uid FROM tasks WHERE creator_id = $1 AND assignee_id IS NOT NULL
     UNION
     SELECT DISTINCT creator_id as uid FROM tasks WHERE assignee_id = $1 AND creator_id IS NOT NULL`,
    [req.me.id]
  );
  const collaboratorIds = collabRows.map((r) => r.uid).filter(Boolean);

  const hiddenClause = req.me.role === 'admin' ? '' : 'AND (dept_id IS NULL OR dept_id NOT IN (SELECT id FROM departments WHERE hidden))';
  const allUsers = await all(
    `SELECT id, name, email, phone, employee_no, dept_id, organization_id, role, title, active, permissions
     FROM users
     WHERE active = true AND id <> $1 ${hiddenClause}
     ORDER BY name ASC`,
    [req.me.id]
  );

  const eligible = allUsers.filter((u) => L.canMessageUser(req.me, u, { collaboratorIds }));
  res.json({
    contacts: eligible.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone || '',
      employeeNo: u.employee_no || '',
      dept: u.dept_id,
      organization: u.organization_id,
      role: u.role,
      title: u.title || '',
    })),
  });
});

/** استعراض قائمة المحادثات المصرح بها للمستخدم */
router.get('/chat/conversations', requireAuth, async (req, res) => {
  if (!L.canViewChat(req.me)) return res.json({ conversations: [] });

  const convRows = await all(
    `SELECT c.*, cp.last_read_at, cp.is_pinned
     FROM conversations c
     JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1 AND cp.is_active = true
     ORDER BY cp.is_pinned DESC, c.last_message_at DESC`,
    [req.me.id]
  );

  if (!convRows.length) return res.json({ conversations: [] });

  const convIds = convRows.map((c) => c.id);

  // جلب جميع أطراف هذه المحادثات
  const participants = await all(
    `SELECT cp.conversation_id, cp.user_id, cp.last_read_at, cp.is_active,
            u.name, u.role, u.title, u.dept_id, u.organization_id, u.active, u.last_login_at
     FROM conversation_participants cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.conversation_id = ANY($1)`,
    [convIds]
  );

  // حساب غير المقروء لكل محادثة
  const unreadRows = await all(
    `SELECT m.conversation_id, COUNT(m.id)::int as n
     FROM chat_messages m
     JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1
     WHERE m.conversation_id = ANY($2)
       AND m.sender_id <> $1
       AND m.deleted_at IS NULL
       AND m.created_at > cp.last_read_at
     GROUP BY m.conversation_id`,
    [req.me.id, convIds]
  );
  const unreadMap = Object.fromEntries(unreadRows.map((r) => [r.conversation_id, Number(r.n)]));

  // جلب معلومات المهام المرتبطة إن وجدت
  const taskIds = [...new Set(convRows.map((c) => c.task_id).filter(Boolean))];
  let tasksMap = {};
  if (taskIds.length) {
    const tRows = await all(
      `SELECT t.id, t.title, t.status_id, t.due_date, t.progress, t.assignee_id, t.dept_id, t.organization_id,
              u.name as assignee_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.id = ANY($1)`,
      [taskIds]
    );
    for (const tr of tRows) {
      if (L.canSeeTask(req.me, tr)) {
        tasksMap[tr.id] = {
          id: tr.id,
          title: tr.title,
          status: tr.status_id,
          dueDate: tr.due_date,
          progress: tr.progress,
          assigneeName: tr.assignee_name,
        };
      }
    }
  }

  const partMap = {};
  for (const p of participants) {
    if (!partMap[p.conversation_id]) partMap[p.conversation_id] = [];
    partMap[p.conversation_id].push({
      id: p.user_id,
      name: p.name,
      role: p.role,
      title: p.title || '',
      dept: p.dept_id,
      organization: p.organization_id,
      active: p.active,
      lastLoginAt: p.last_login_at,
      lastReadAt: p.last_read_at,
    });
  }

  const result = convRows.map((c) => {
    const parts = partMap[c.id] || [];
    const other = parts.find((p) => p.id !== req.me.id) || parts[0] || { name: 'محادثة' };
    return {
      id: c.id,
      type: c.type,
      title: c.type === 'TASK' && tasksMap[c.task_id] ? `نقاش مهمة: ${tasksMap[c.task_id].title}` : c.title || other.name,
      taskId: c.task_id,
      task: tasksMap[c.task_id] || null,
      lastMessageAt: c.last_message_at,
      lastMessagePreview: c.last_message_preview || '',
      lastMessageSenderId: c.last_message_sender_id,
      isPinned: !!c.is_pinned,
      unreadCount: unreadMap[c.id] || 0,
      participants: parts,
      otherParticipant: other,
      createdAt: c.created_at,
    };
  });

  res.json({ conversations: result });
});

/** بدء محادثة جديدة أو فتح محادثة قائمة (فردية أو متعلقة بمهمة) */
router.post('/chat/conversations', requireAuth, async (req, res) => {
  if (!L.canStartChat(req.me)) return res.status(403).json({ error: 'لا تملك صلاحية بدء محادثة.' });

  const type = String(req.body?.type || 'DIRECT').toUpperCase();
  const taskId = req.body?.taskId ? String(req.body.taskId).trim() : null;
  const recipientId = req.body?.recipientId ? String(req.body.recipientId).trim() : null;

  if (type === 'TASK') {
    if (!taskId) return res.status(400).json({ error: 'معرّف المهمة مطلوب لمحادثات المهام.' });
    const t = await getTask(taskId);
    if (!t || !L.canSeeTask(req.me, t)) return res.status(403).json({ error: 'لا تملك صلاحية الوصول إلى هذه المهمة.' });

    // البحث عن محادثة سابقة لهذه المهمة يكون المستخدم طرفاً فيها
    const existing = await one(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
       WHERE c.type = 'TASK' AND c.task_id = $2
       LIMIT 1`,
      [req.me.id, t.id]
    );

    if (existing) return res.json({ conversationId: existing.id });

    // إنشاء محادثة جديدة للمهمة
    const convId = 'conv-t-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    await q(
      `INSERT INTO conversations(id, type, title, task_id, created_by, last_message_at, last_message_preview, last_message_sender_id)
       VALUES($1, 'TASK', $2, $3, $4, now(), 'بدء نقاش المهمة', $4)`,
      [convId, t.title, t.id, req.me.id]
    );

    // إضافة أطراف المهمة: المستخدم الحالي + المنفذ + المنشئ + المدير إذا وجد
    const candidateIds = [...new Set([req.me.id, t.assignee_id, t.creator_id].filter(Boolean))];
    for (const uid of candidateIds) {
      await q(
        `INSERT INTO conversation_participants(conversation_id, user_id, joined_at, last_read_at, is_active)
         VALUES($1, $2, now(), now(), true)
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [convId, uid]
      );
    }

    return res.json({ conversationId: convId });
  }

  // محادثة مباشرة DIRECT
  if (!recipientId) return res.status(400).json({ error: 'يرجى تحديد جهة الاتصال.' });
  if (recipientId === req.me.id) return res.status(400).json({ error: 'لا يمكن إنشاء محادثة مع نفسك.' });

  const targetUser = await one('SELECT * FROM users WHERE id=$1 AND active=true', [recipientId]);
  if (!targetUser) return res.status(404).json({ error: 'المستخدم غير موجود أو معطّل.' });

  // فحص الصلاحية والهيكل الإداري والأهلية
  const collabRows = await all(
    `SELECT DISTINCT assignee_id as uid FROM tasks WHERE creator_id = $1 AND assignee_id IS NOT NULL
     UNION
     SELECT DISTINCT creator_id as uid FROM tasks WHERE assignee_id = $1 AND creator_id IS NOT NULL`,
    [req.me.id]
  );
  const collaboratorIds = collabRows.map((r) => r.uid).filter(Boolean);

  if (!L.canMessageUser(req.me, targetUser, { collaboratorIds })) {
    return res.status(403).json({ error: 'لا تملك صلاحية مراسلة هذا المستخدم وفق الهيكل الإداري والصلاحيات المعتمدة.' });
  }

  // البحث عما إذا كانت هناك محادثة مباشرة سابقة بين هذين الطرفين
  const existingDirect = await one(
    `SELECT c.id FROM conversations c
     JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = $1
     JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = $2
     WHERE c.type = 'DIRECT' AND (SELECT count(*) FROM conversation_participants WHERE conversation_id = c.id) = 2
     LIMIT 1`,
    [req.me.id, targetUser.id]
  );

  if (existingDirect) return res.json({ conversationId: existingDirect.id });

  const convId = 'conv-d-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  await q(
    `INSERT INTO conversations(id, type, title, created_by, last_message_at, last_message_preview, last_message_sender_id)
     VALUES($1, 'DIRECT', $2, $3, now(), '', $3)`,
    [convId, targetUser.name, req.me.id]
  );

  await q(
    `INSERT INTO conversation_participants(conversation_id, user_id, joined_at, last_read_at, is_active)
     VALUES($1, $2, now(), now(), true), ($1, $3, now(), now(), true)`,
    [convId, req.me.id, targetUser.id]
  );

  res.json({ conversationId: convId });
});

/** جلب رسائل محادثة معينة وتحديث حالة القراءة */
router.get('/chat/conversations/:id/messages', requireAuth, async (req, res) => {
  const convId = req.params.id;
  const part = await one(
    'SELECT * FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2 AND is_active=true',
    [convId, req.me.id]
  );
  if (!part && req.me.role !== 'admin') {
    return res.status(403).json({ error: 'لا تملك صلاحية الوصول إلى هذه المحادثة.' });
  }

  // تحديث وقت آخر قراءة للمستخدم
  await q('UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2', [convId, req.me.id]);

  const messages = await all(
    `SELECT m.id, m.conversation_id, m.sender_id, m.message, m.reply_to_message_id, m.is_pinned,
            m.created_at, m.edited_at, m.deleted_at,
            u.name as sender_name, u.role as sender_role, u.title as sender_title
     FROM chat_messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = $1
     ORDER BY m.created_at ASC`,
    [convId]
  );

  const msgIds = messages.map((m) => m.id);
  let attachmentsMap = {}, referencesMap = {};

  if (msgIds.length) {
    const attRows = await all(
      `SELECT * FROM message_attachments WHERE message_id = ANY($1) ORDER BY id ASC`,
      [msgIds]
    );
    for (const a of attRows) {
      if (!attachmentsMap[a.message_id]) attachmentsMap[a.message_id] = [];
      attachmentsMap[a.message_id].push({
        id: a.id,
        name: a.original_name,
        size: Number(a.file_size),
        mime: a.mime_type,
        url: `/api/chat/attachments/${a.id}`,
      });
    }

    const refRows = await all(
      `SELECT * FROM message_references WHERE message_id = ANY($1) ORDER BY id ASC`,
      [msgIds]
    );
    for (const r of refRows) {
      if (!referencesMap[r.message_id]) referencesMap[r.message_id] = [];
      referencesMap[r.message_id].push({
        id: r.id,
        type: r.reference_type,
        refId: r.reference_id,
        title: r.reference_title,
        meta: r.reference_meta || {},
      });
    }
  }

  // مراجعة أوقات قراءة الأطراف الآخرين لمعرفة حالة "تمت القراءة"
  const otherParts = await all(
    'SELECT user_id, last_read_at FROM conversation_participants WHERE conversation_id=$1 AND user_id <> $2',
    [convId, req.me.id]
  );
  const maxOtherReadAt = otherParts.length
    ? new Date(Math.max(...otherParts.map((p) => new Date(p.last_read_at).getTime())))
    : null;

  const formatted = messages.map((m) => ({
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    senderName: m.sender_name,
    senderRole: m.sender_role,
    senderTitle: m.sender_title,
    message: m.deleted_at ? 'تم حذف هذه الرسالة' : m.message,
    replyToId: m.reply_to_message_id,
    isPinned: !!m.is_pinned,
    isDeleted: !!m.deleted_at,
    isRead: maxOtherReadAt ? new Date(m.created_at) <= maxOtherReadAt : false,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    attachments: attachmentsMap[m.id] || [],
    references: referencesMap[m.id] || [],
  }));

  res.json({ messages: formatted });
});

/** إرسال رسالة في محادثة */
router.post('/chat/conversations/:id/messages', requireAuth, async (req, res) => {
  if (!L.canSendChatMessage(req.me)) return res.status(403).json({ error: 'لا تملك صلاحية إرسال الرسائل.' });

  const convId = req.params.id;
  const part = await one(
    'SELECT * FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2 AND is_active=true',
    [convId, req.me.id]
  );
  if (!part && req.me.role !== 'admin') {
    return res.status(403).json({ error: 'لا تملك صلاحية إرسال رسائل في هذه المحادثة.' });
  }

  const messageText = String(req.body?.message || '').trim();
  const replyToId = req.body?.replyToId ? Number(req.body.replyToId) : null;
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const references = Array.isArray(req.body?.references) ? req.body.references : [];

  if (!messageText && !attachments.length && !references.length) {
    return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة.' });
  }

  const inserted = await one(
    `INSERT INTO chat_messages(conversation_id, sender_id, message, reply_to_message_id, created_at)
     VALUES($1, $2, $3, $4, now())
     RETURNING id, created_at`,
    [convId, req.me.id, messageText, replyToId]
  );
  const msgId = inserted.id;

  // حفظ المرفقات
  const savedAttachments = [];
  for (const a of attachments) {
    if (a.storageKey && a.originalName) {
      const attRow = await one(
        `INSERT INTO message_attachments(message_id, storage_key, original_name, file_size, mime_type)
         VALUES($1, $2, $3, $4, $5) RETURNING id`,
        [msgId, a.storageKey, a.originalName, a.fileSize || 0, a.mimeType || 'application/octet-stream']
      );
      savedAttachments.push({
        id: attRow.id,
        name: a.originalName,
        size: a.fileSize || 0,
        mime: a.mimeType,
        url: `/api/chat/attachments/${attRow.id}`,
      });
    }
  }

  // حفظ المراجع (مهام، إجراءات)
  const savedReferences = [];
  for (const r of references) {
    if (r.type && r.id) {
      const refRow = await one(
        `INSERT INTO message_references(message_id, reference_type, reference_id, reference_title, reference_meta)
         VALUES($1, $2, $3, $4, $5) RETURNING id`,
        [msgId, r.type.toUpperCase(), String(r.id), String(r.title || ''), r.meta || {}]
      );
      savedReferences.push({
        id: refRow.id,
        type: r.type.toUpperCase(),
        refId: String(r.id),
        title: String(r.title || ''),
        meta: r.meta || {},
      });
    }
  }

  // تحديث المحادثة
  const snippet = messageText || (attachments.length ? '📎 مرفق' : references.length ? '📌 مرجع مهمة' : '');
  const preview = snippet.slice(0, 80) + (snippet.length > 80 ? '…' : '');
  await q(
    `UPDATE conversations
     SET last_message_at = now(), last_message_preview = $1, last_message_sender_id = $2, updated_at = now()
     WHERE id = $3`,
    [preview, req.me.id, convId]
  );

  // تحديث قراءة المرسل
  await q('UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2', [convId, req.me.id]);

  // إرسال تنبيهات للأطراف الأخرى
  const otherParts = await all(
    'SELECT user_id FROM conversation_participants WHERE conversation_id=$1 AND user_id <> $2 AND is_active=true',
    [convId, req.me.id]
  );
  const otherUserIds = otherParts.map((p) => p.user_id);
  if (otherUserIds.length) {
    const conv = await one('SELECT * FROM conversations WHERE id=$1', [convId]);
    await notify({
      kind: 'comment',
      taskId: conv?.task_id || null,
      actorId: req.me.id,
      to: otherUserIds,
      body: `رسالة جديدة من ${req.me.name}: ${preview}`,
    });
  }

  res.json({
    message: {
      id: msgId,
      conversationId: convId,
      senderId: req.me.id,
      senderName: req.me.name,
      senderRole: req.me.role,
      senderTitle: req.me.title,
      message: messageText,
      replyToId,
      isPinned: false,
      isDeleted: false,
      isRead: false,
      createdAt: inserted.created_at,
      attachments: savedAttachments,
      references: savedReferences,
    },
  });
});

/** رفع ملف مرفق للمحادثة */
router.post('/chat/upload', requireAuth, upload.array('files', 5), async (req, res) => {
  if (!L.canAttachChatFile(req.me)) return res.status(403).json({ error: 'لا تملك صلاحية إرفاق ملفات.' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'لم يُرفع أي ملف.' });

  const stored = [];
  try {
    for (const f of files) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const key = S.newKey('chat', name);
      const buf = await fs.promises.readFile(f.path);
      await S.save(buf, key, f.mimetype);
      stored.push({
        storageKey: key,
        originalName: name,
        fileSize: f.size,
        mimeType: f.mimetype,
      });
    }
    res.json({ files: stored });
  } catch (e) {
    for (const s of stored) await S.remove(s.storageKey).catch(() => {});
    console.error('[chat-upload]', e);
    res.status(502).json({ error: 'تعذّر حفظ المرفقات في التخزين.' });
  } finally {
    for (const f of files) fs.promises.unlink(f.path).catch(() => {});
  }
});

/** تحميل مرفق رسالة بأمان */
router.get('/chat/attachments/:aid', requireAuth, async (req, res) => {
  const a = await one('SELECT * FROM message_attachments WHERE id=$1', [req.params.aid]);
  if (!a) return res.status(404).json({ error: 'المرفق غير موجود.' });

  const msg = await one('SELECT conversation_id FROM chat_messages WHERE id=$1', [a.message_id]);
  if (!msg) return res.status(404).json({ error: 'الرسالة غير موجودة.' });

  const part = await one(
    'SELECT 1 FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2',
    [msg.conversation_id, req.me.id]
  );
  if (!part && req.me.role !== 'admin') {
    return res.status(403).json({ error: 'لا تملك صلاحية تنزيل هذا المرفق.' });
  }

  try {
    await S.serve(res, a.storage_key, a.original_name);
  } catch (e) {
    console.error('[chat-serve-attachment]', e);
    res.status(502).json({ error: 'تعذّر جلب المرفق من التخزين.' });
  }
});

/** تحديث حالة القراءة للمحادثة */
router.post('/chat/conversations/:id/read', requireAuth, async (req, res) => {
  await q('UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2', [req.params.id, req.me.id]);
  res.json({ ok: true });
});

/** تثبيت أو إلغاء تثبيت محادثة */
router.post('/chat/conversations/:id/pin', requireAuth, async (req, res) => {
  const part = await one('SELECT is_pinned FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2', [req.params.id, req.me.id]);
  if (!part) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
  const nextVal = !part.is_pinned;
  await q('UPDATE conversation_participants SET is_pinned=$1 WHERE conversation_id=$2 AND user_id=$3', [nextVal, req.params.id, req.me.id]);
  res.json({ isPinned: nextVal });
});

/** حذف رسالة (من صاحب الرسالة أو مدير النظام) */
router.delete('/chat/messages/:mid', requireAuth, async (req, res) => {
  const msg = await one('SELECT * FROM chat_messages WHERE id=$1', [req.params.mid]);
  if (!msg) return res.status(404).json({ error: 'الرسالة غير موجودة.' });
  if (msg.sender_id !== req.me.id && req.me.role !== 'admin') {
    return res.status(403).json({ error: 'لا يمكنك حذف رسالة مرسلة من شخص آخر.' });
  }
  await q('UPDATE chat_messages SET deleted_at = now(), message = $1 WHERE id=$2', ['تم حذف هذه الرسالة', msg.id]);
  res.json({ ok: true });
});

module.exports = router;

