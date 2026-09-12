'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { q, one, all, tx, getSetting, setSetting, SETTING_DEFAULTS } = require('./db');
const { requireAuth, requireAdmin, hash, validatePassword, verify } = require('./auth');
const { verifyTransport, notify } = require('./mailer');
const { parseXlsx } = require('./xlsx');
const { buildXlsx } = require('./xlsx-export');

const router = express.Router();
router.use(requireAuth);

const adminLog = (userId, type, text) =>
  q('INSERT INTO activity(task_id,user_id,type,text) VALUES(NULL,$1,$2,$3)', [userId, type, text]);
const S = require('./storage');
/* يمسح كل المرفقات من التخزين المحلي — يُستدعى من إعادة الضبط */
const purgeUploadedFiles = () => S.purgeAll();
const requirePlanAccess = (req, res, next) =>
  ['admin','director'].includes(req.me?.role) ? next() : res.status(403).json({ error: 'استيراد الخطة متاح لمدير النظام ومدير الإدارة.' });

/* ============================================================
   الحساب الشخصي
   ============================================================ */
router.post('/account/password', async (req, res) => {
  const { current, next } = req.body || {};
  const u = await one('SELECT * FROM users WHERE id=$1', [req.me.id]);
  if (!(await verify(String(current || ''), u.password_hash)))
    return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة.' });
  const bad = validatePassword(next);
  if (bad) return res.status(400).json({ error: bad });
  await q('UPDATE users SET password_hash=$1, must_change_pw=false WHERE id=$2', [await hash(next), u.id]);
  await adminLog(u.id, 'security', 'غيّر كلمة المرور الخاصة به');
  res.json({ ok: true });
});

/* ============================================================
   المستخدمون — مدير النظام فقط
   ============================================================ */
router.get('/users', requireAdmin, async (_req, res) => {
  const rows = await all(
    `SELECT id,name,email,phone,employee_no,manager_id,dept_id,organization_id,role,title,active,permissions,must_change_pw,last_login_at,created_at
     FROM users ORDER BY name`
  );
  res.json({ users: rows.map((u) => ({ ...u, dept: u.dept_id, organization: u.organization_id })) });
});

router.post('/users/:id/temporary-password', requireAdmin, async (req,res)=>{
  const u=await one('SELECT id,name FROM users WHERE id=$1',[req.params.id]);
  if(!u)return res.status(404).json({error:'المستخدم غير موجود.'});
  if(u.id===req.me.id)return res.status(400).json({error:'غيّر كلمة مرور حسابك من إعدادات الحساب.'});
  const password=genPassword();
  await q('UPDATE users SET password_hash=$1,must_change_pw=true WHERE id=$2',[await hash(password),u.id]);
  await adminLog(req.me.id,'security',`أنشأ كلمة مرور مؤقتة للمستخدم ${u.name}`);
  res.json({password,mustChangePassword:true});
});

async function structureBackupData(){
  const [orgs,depts,people,cfg]=await Promise.all([
    all(`SELECT o.code,o.name,COALESCE(u.employee_no,sp.employee_no) director_employee_no FROM organizations o LEFT JOIN users u ON u.id=o.director_id
         LEFT JOIN LATERAL (SELECT employee_no FROM structure_people WHERE organization_id=o.id AND suggested_role='director' ORDER BY linked_user_id NULLS LAST,id LIMIT 1) sp ON true ORDER BY o.sort,o.name`),
    all(`SELECT o.code organization_code,d.code,d.name,COALESCE(u.employee_no,sp.employee_no) head_employee_no FROM departments d JOIN organizations o ON o.id=d.organization_id LEFT JOIN users u ON u.id=d.head_id
         LEFT JOIN LATERAL (SELECT employee_no FROM structure_people WHERE dept_id=d.id AND suggested_role='manager' ORDER BY linked_user_id NULLS LAST,id LIMIT 1) sp ON true ORDER BY o.sort,d.sort,d.name`),
    all(`SELECT COALESCE(u.employee_no,p.employee_no) employee_no,COALESCE(u.name,p.name) name,
                COALESCE(u.role,p.suggested_role) role,COALESCE(u.title,p.title) title,
                o.code organization_code,d.code department_code,
                COALESCE(m.employee_no,p.manager_employee_no) manager_employee_no,
                COALESCE(u.phone,p.phone) phone,COALESCE(u.email,p.email) email,
                COALESCE(u.active,p.active) active
         FROM structure_people p LEFT JOIN users u ON u.id=p.linked_user_id LEFT JOIN users m ON m.id=u.manager_id
         LEFT JOIN organizations o ON o.id=COALESCE(u.organization_id,p.organization_id)
         LEFT JOIN departments d ON d.id=COALESCE(u.dept_id,p.dept_id)
         WHERE COALESCE(u.role,p.suggested_role)<>'admin' ORDER BY p.name`),getSetting('cfg')]);
  return {orgs,depts,people,cfg};
}

router.get('/structure/export.xlsx', requireAdmin, async (_req,res)=>{
  const {orgs,depts,people,cfg}=await structureBackupData();
  const domain=cfg.domains?.[0]||'wamy.org',used=new Set();
  const emailFor=p=>{let e=String(p.email||'').trim().toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)||used.has(e)){const local=String(p.employee_no||Date.now()).replace(/[^a-z0-9._-]/gi,'');e=`structure.${local}@${domain}`;}used.add(e);return e;};
  const roleAr={secretary_general:'الأمين العام',assistant_secretary_general:'مساعد الأمين العام',director:'مدير إدارة',consultant:'مستشار',manager:'رئيس قسم',employee:'موظف'};
  const sheets=[
    {name:'دليل الاستخدام',rows:[['نسخة مستخدمي الهيكل الإداري',''],['تاريخ التصدير',new Date().toISOString()],['تنبيه كلمات المرور','كلمات المرور الحالية مشفرة ولا تُصدّر. عند إعادة الاستيراد يولد النظام كلمات مرور مؤقتة ويعرضها في المعاينة.']]},
    {name:'الإدارات',rows:[['رمز الإدارة*','اسم الإدارة*','الرقم الوظيفي للمدير*','الحالة*'],...orgs.map(o=>[o.code||'',o.name,o.director_employee_no||'','نشط'])]},
    {name:'الأقسام',rows:[['رمز الإدارة*','رمز القسم*','اسم القسم*','الرقم الوظيفي لرئيس القسم*','الحالة*'],...depts.map(d=>[d.organization_code||'',d.code||'',d.name,d.head_employee_no||'','نشط'])]},
    {name:'المستخدمون',rows:[['الرقم الوظيفي*','الاسم الكامل*','الدور في النظام*','المسمى الوظيفي*','رمز الإدارة*','رمز القسم','الرقم الوظيفي للمدير المباشر','رقم الجوال*','البريد الإلكتروني*','الحالة*','كلمة المرور'],...people.map(p=>[p.employee_no,p.name,roleAr[p.role]||'موظف',p.title||'',p.organization_code||'',p.department_code||'',p.manager_employee_no||'',p.phone||'',emailFor(p),p.active?'نشط':'غير نشط',''])]}
  ];
  const file=buildXlsx(sheets);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent('نسخة-مستخدمي-الهيكل.xlsx')}`);res.send(file);
});

router.get('/structure/export.json', requireAdmin, async (req,res)=>{
  const {orgs,depts,people,cfg}=await structureBackupData(),domain=cfg.domains?.[0]||'wamy.org',used=new Set();
  const emailFor=p=>{let e=String(p.email||'').trim().toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)||used.has(e)){const local=String(p.employee_no||Date.now()).replace(/[^a-z0-9._-]/gi,'');e=`structure.${local}@${domain}`;}used.add(e);return e;};
  const backup={
    format:'wamy-structure-backup',version:1,exportedAt:new Date().toISOString(),
    organizations:orgs.map(o=>({code:o.code||'',name:o.name,directorEmployeeNo:o.director_employee_no||'',active:true})),
    departments:depts.map(d=>({organizationCode:d.organization_code||'',code:d.code||'',name:d.name,headEmployeeNo:d.head_employee_no||'',active:true})),
    users:people.map(p=>({employeeNo:p.employee_no,name:p.name,role:p.role,title:p.title||'',organizationCode:p.organization_code||'',departmentCode:p.department_code||'',managerEmployeeNo:p.manager_employee_no||'',phone:p.phone||'',email:emailFor(p),active:p.active!==false}))
  };
  const name=`نسخة-الهيكل-الإداري-${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  await adminLog(req.me.id,'admin','صدّر نسخة احتياطية من الهيكل الإداري بصيغة JSON');
  res.send(JSON.stringify(backup,null,2));
});

const { normPhone } = require('./logic');

router.post('/users', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const cfg = await getSetting('cfg');
  const email = String(b.email || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  if (!b.name || !email) return res.status(400).json({ error: 'الاسم والبريد مطلوبان.' });
  if (!cfg.domains.map((d) => d.toLowerCase()).includes(domain))
    return res.status(400).json({ error: `البريد خارج النطاق المعتمد (${cfg.domains.map((d) => '@' + d).join('، ')}).` });
  if (await one('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email]))
    return res.status(409).json({ error: 'هذا البريد مسجّل مسبقًا.' });
  const bad = validatePassword(b.password || '');
  if (bad) return res.status(400).json({ error: bad });
  const ph = normPhone(b.phone);
  if (ph.error) return res.status(400).json({ error: ph.error });
  const role = b.role || 'employee';
  if (!['admin','secretary_general','assistant_secretary_general','director','manager','employee'].includes(role)) return res.status(400).json({ error: 'الدور غير صالح.' });
  const dept = b.dept ? await one('SELECT organization_id FROM departments WHERE id=$1', [b.dept]) : null;
  const organization = dept?.organization_id || b.organization || null;
  if (!['admin','secretary_general','assistant_secretary_general'].includes(role) && !organization) return res.status(400).json({ error: 'يجب تحديد الإدارة.' });
  if (['manager','employee'].includes(role) && !dept) return res.status(400).json({ error: 'يجب تحديد القسم لرئيس القسم والموظف.' });
  const employeeNo=String(b.employeeNo||'').trim();
  if(!employeeNo)return res.status(400).json({error:'الرقم الوظيفي مطلوب.'});
  if(await one('SELECT 1 FROM users WHERE lower(employee_no)=lower($1)',[employeeNo]))return res.status(409).json({error:'الرقم الوظيفي موجود مسبقًا.'});
  const manager=b.managerEmployeeNo?await one('SELECT id,role,dept_id,organization_id FROM users WHERE lower(employee_no)=lower($1) AND active=true',[String(b.managerEmployeeNo).trim()]):null;
  if(b.managerEmployeeNo&&!manager)return res.status(400).json({error:'المدير المباشر غير موجود.'});
  if(!['director','admin','secretary_general','assistant_secretary_general'].includes(role)&&!manager)return res.status(400).json({error:'المدير المباشر مطلوب.'});
  if(role==='employee'&&(manager.role!=='manager'||manager.dept_id!==(b.dept||null)))return res.status(400).json({error:'المدير المباشر للموظف يجب أن يكون رئيس قسمه.'});
  if(role==='manager'&&(manager.role!=='director'||manager.organization_id!==organization))return res.status(400).json({error:'المدير المباشر لرئيس القسم يجب أن يكون مدير الإدارة.'});

  const id = 'u' + Date.now().toString(36);
  await q(
    `INSERT INTO users(id,employee_no,name,email,phone,password_hash,dept_id,organization_id,manager_id,role,title,active,must_change_pw)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,
    [id,employeeNo,b.name,email,ph.phone,await hash(b.password),b.dept||null,organization,manager?.id||null,role,b.title||'',b.active!==false]
  );
  await adminLog(req.me.id, 'admin', `أضاف المستخدم ${b.name} (${email}) بدور ${b.role || 'employee'}`);
  res.status(201).json({ id });
});

/* ---------- استيراد المستخدمين دفعة واحدة ---------- */
const crypto = require('crypto');
const ROLE_ALIASES = {
  'admin': 'admin', 'مدير النظام': 'admin', 'مدير نظام': 'admin', 'ادمن': 'admin',
  'manager': 'manager', 'مدير': 'manager', 'مشرف': 'manager', 'مدير / مشرف': 'manager', 'رئيس قسم': 'manager',
  'employee': 'employee', 'موظف': 'employee', 'موظفة': 'employee', 'عضو': 'employee', '': 'employee',
};
const PW_WORDS = ['Wamy', 'Media', 'Tasks', 'Riyadh', 'Team'];
function genPassword() {
  const w = PW_WORDS[crypto.randomInt(PW_WORDS.length)];
  const n = String(crypto.randomInt(1000, 9999));
  const s = '!@#$%&*'[crypto.randomInt(7)];
  return `${w}${s}${n}${crypto.randomInt(10)}`;   // 10 أحرف فأكثر، حروف وأرقام ورمز
}

/**
 * يستقبل صفوفًا مُحلَّلة من الواجهة ويُنشئ الحسابات.
 * dryRun=true للفحص فقط دون كتابة — يُنصح بتشغيله أولًا.
 */
router.post('/users/import', requireAdmin, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : null;
  const dryRun = req.body?.dryRun !== false;
  if (!rows || !rows.length) return res.status(400).json({ error: 'لا توجد صفوف للاستيراد.' });

  const cfg = await getSetting('cfg');
  const domains = cfg.domains.map((d) => d.toLowerCase());
  const depts = await all('SELECT id,name,organization_id FROM departments');
  const existing = new Set((await all('SELECT lower(email) e FROM users')).map((r) => r.e));
  const seen = new Set();
  const results = [];

  for (const [i, raw] of rows.entries()) {
    const r = { row: i + 1, name: String(raw.name || '').trim(), email: String(raw.email || '').trim().toLowerCase() };
    const push = (status, message, extra) => results.push({ ...r, status, message, ...(extra || {}) });

    if (!r.name && !r.email) { push('skipped', 'صف فارغ'); continue; }
    if (!r.name) { push('error', 'الاسم مفقود'); continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) { push('error', 'صيغة البريد غير صحيحة'); continue; }

    const domain = r.email.split('@')[1];
    if (!domains.includes(domain)) { push('error', `البريد خارج النطاق المعتمد (${domains.map((d) => '@' + d).join('، ')})`); continue; }
    if (existing.has(r.email)) { push('skipped', 'الحساب موجود مسبقًا — لم يُعدَّل'); continue; }
    if (seen.has(r.email)) { push('error', 'بريد مكرر داخل الملف'); continue; }

    const deptRaw = String(raw.dept || '').trim();
    const dept = depts.find((d) => d.id === deptRaw || d.name === deptRaw || d.name.replace(/\s+/g, '') === deptRaw.replace(/\s+/g, ''));
    if (deptRaw && !dept) { push('error', `الإدارة غير معروفة: «${deptRaw}» — أضفها من لوحة التحكم أو صحّح الاسم`); continue; }

    const roleRaw = String(raw.role || '').trim().toLowerCase();
    const role = ROLE_ALIASES[roleRaw] || ROLE_ALIASES[String(raw.role || '').trim()] || null;
    if (raw.role && !role) { push('error', `الدور غير معروف: «${raw.role}» — استخدم: مدير النظام / مدير / موظف`); continue; }

    const password = String(raw.password || '').trim() || genPassword();
    const bad = validatePassword(password);
    if (bad) { push('error', 'كلمة المرور المزوّدة غير مقبولة: ' + bad); continue; }

    const ph = normPhone(raw.phone);
    if (ph.error) { push('error', `${ph.error} (القيمة: «${String(raw.phone).trim()}»)`); continue; }

    seen.add(r.email);
    if (dryRun) { push('ready', 'جاهز للإنشاء', { dept: dept ? dept.name : '—', role: role || 'employee', phone: ph.phone || '—' }); continue; }

    const id = 'u' + Date.now().toString(36) + crypto.randomInt(1e4).toString(36);
    await q(
      `INSERT INTO users(id,name,email,phone,password_hash,dept_id,organization_id,role,title,must_change_pw)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [id, r.name, r.email, ph.phone, await hash(password), dept ? dept.id : null, dept ? dept.organization_id : null, role || 'employee', String(raw.title || '').trim()]
    );
    existing.add(r.email);
    push('created', 'أُنشئ الحساب', { dept: dept ? dept.name : '—', role: role || 'employee', phone: ph.phone || '—', password });
  }

  const summary = results.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
  if (!dryRun) await adminLog(req.me.id, 'admin', `استورد المستخدمين: ${summary.created || 0} حساب جديد، ${summary.skipped || 0} متجاوَز، ${summary.error || 0} خطأ`);
  res.json({ dryRun, summary, results });
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  const b = req.body || {};
  if (b.role !== undefined && !['admin','secretary_general','assistant_secretary_general','director','consultant','manager','employee'].includes(b.role))
    return res.status(400).json({ error: 'الدور غير صالح.' });
  if (b.dept !== undefined && b.dept) {
    const d = await one('SELECT organization_id FROM departments WHERE id=$1', [b.dept]);
    if (!d) return res.status(400).json({ error: 'القسم غير موجود.' });
    b.organization = d.organization_id;
  }
  if(b.employeeNo!==undefined){b.employeeNo=String(b.employeeNo||'').trim();if(!b.employeeNo)return res.status(400).json({error:'الرقم الوظيفي مطلوب.'});const dup=await one('SELECT 1 FROM users WHERE lower(employee_no)=lower($1) AND id<>$2',[b.employeeNo,u.id]);if(dup)return res.status(409).json({error:'الرقم الوظيفي موجود مسبقًا.'});}
  if(b.managerEmployeeNo!==undefined){const m=b.managerEmployeeNo?await one('SELECT id FROM users WHERE lower(employee_no)=lower($1) AND active=true',[String(b.managerEmployeeNo).trim()]):null;if(b.managerEmployeeNo&&!m)return res.status(400).json({error:'المدير المباشر غير موجود.'});b.managerId=m?.id||null;}
  const set = [], vals = [], notes = [];
  const put = (col, v, label) => { if (v === undefined || v === u[col]) return; set.push(`${col}=$${vals.length + 1}`); vals.push(v); if (label) notes.push(label); };
  put('name', b.name, 'الاسم'); put('title', b.title, 'المسمى');
  put('employee_no', b.employeeNo, 'الرقم الوظيفي');
  put('dept_id', b.dept, 'القسم'); put('organization_id', b.organization, 'الإدارة'); put('role', b.role, 'الدور');
  if(b.permissions!==undefined){
    if(!b.permissions||typeof b.permissions!=='object'||Array.isArray(b.permissions))return res.status(400).json({error:'صيغة الصلاحيات غير صالحة.'});
    const allowed=['create_self','assign_others','manage_tasks','approve_close','reassign_tasks','delete_tasks','view_reports','chat_view','chat_start','chat_send_message','chat_attach_file','chat_mention_task'];
    const permissions=Object.fromEntries(Object.entries(b.permissions).filter(([k,v])=>allowed.includes(k)&&typeof v==='boolean'));
    put('permissions',permissions,'الصلاحيات');
  }
  put('manager_id',b.managerId,'المدير المباشر');
  if (b.phone !== undefined) {
    const ph = normPhone(b.phone);
    if (ph.error) return res.status(400).json({ error: ph.error });
    put('phone', ph.phone, 'رقم الجوال');
  }
  if (b.active !== undefined && b.active !== u.active) {
    if (!b.active && u.id === req.me.id) return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك.' });
    if (!b.active) {
      const open = await one(`SELECT count(*)::int n FROM tasks WHERE assignee_id=$1 AND status_id NOT IN ('done','cancelled')`, [u.id]);
      if (open.n > 0) return res.status(409).json({ error: `لا يمكن التعطيل — لديه ${open.n} مهمة مفتوحة، أعد إسنادها أولًا.` });
    }
    put('active', b.active, b.active ? 'تفعيل' : 'تعطيل');
  }
  if (b.password) {
    const bad = validatePassword(b.password);
    if (bad) return res.status(400).json({ error: bad });
    set.push(`password_hash=$${vals.length + 1}`); vals.push(await hash(b.password));
    set.push('must_change_pw=true'); notes.push('إعادة تعيين كلمة المرور');
  }
  if (!set.length) return res.json({ ok: true });
  vals.push(u.id);
  await q(`UPDATE users SET ${set.join(',')} WHERE id=$${vals.length}`, vals);
  await adminLog(req.me.id, 'admin', `عدّل المستخدم ${u.name}${notes.length ? ' — ' + notes.join('، ') : ''}`);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  if (u.id === req.me.id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك.' });
  const open = await one(`SELECT count(*)::int n FROM tasks WHERE assignee_id=$1 AND status_id NOT IN ('done','cancelled')`, [u.id]);
  if (open.n > 0) return res.status(409).json({ error: `لا يمكن الحذف — لديه ${open.n} مهمة مفتوحة، أعد إسنادها أولًا.` });
  // لا نحذف السجل التاريخي: نعطّل الحساب بدل الحذف الفعلي
  await q('UPDATE users SET active=false WHERE id=$1', [u.id]);
  await adminLog(req.me.id, 'admin', `عطّل حساب ${u.name} (يُحتفظ بسجله التاريخي)`);
  res.json({ ok: true, softDeleted: true });
});

/* ---------- سجل موظفي الهيكل الإداري المستقل ---------- */
router.post('/structure/people', requireAdmin, async (req,res)=>{
  const b=req.body||{}, employeeNo=String(b.employeeNo||'').trim(), name=String(b.name||'').trim();
  if(!employeeNo||!name)return res.status(400).json({error:'الرقم الوظيفي والاسم مطلوبان.'});
  if(await one('SELECT 1 FROM structure_people WHERE lower(employee_no)=lower($1)',[employeeNo]))return res.status(409).json({error:'الرقم الوظيفي مسجل في الهيكل مسبقًا.'});
  const role=b.role||'employee';
  if(!['secretary_general','assistant_secretary_general','director','manager','employee'].includes(role))return res.status(400).json({error:'المستوى الإداري غير صالح.'});
  const id='sp'+Date.now().toString(36);
  await q(`INSERT INTO structure_people(id,employee_no,name,email,phone,title,suggested_role,organization_id,dept_id,manager_employee_no,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,employeeNo,name,String(b.email||'').trim().toLowerCase(),String(b.phone||''),String(b.title||''),role,b.organization||null,b.dept||null,String(b.managerEmployeeNo||'').trim()||null,b.active!==false]);
  await adminLog(req.me.id,'admin',`أضاف ${name} إلى سجل الهيكل الإداري`);
  res.status(201).json({id});
});

router.patch('/structure/people/:id', requireAdmin, async(req,res)=>{
  const p=await one('SELECT * FROM structure_people WHERE id=$1',[req.params.id]);if(!p)return res.status(404).json({error:'السجل غير موجود.'});
  const b=req.body||{},set=[],vals=[];const put=(c,v)=>{if(v!==undefined){set.push(`${c}=$${vals.length+1}`);vals.push(v||null);}};
  put('employee_no',b.employeeNo);put('name',b.name);put('email',b.email);put('phone',b.phone);put('title',b.title);put('suggested_role',b.role);put('organization_id',b.organization);put('dept_id',b.dept);put('manager_employee_no',b.managerEmployeeNo);if(b.active!==undefined)put('active',!!b.active);
  if(!set.length)return res.json({ok:true});vals.push(p.id);await q(`UPDATE structure_people SET ${set.join(',')} WHERE id=$${vals.length}`,vals);res.json({ok:true});
});

router.delete('/structure/people/:id', requireAdmin, async(req,res)=>{
  const p=await one('SELECT linked_user_id FROM structure_people WHERE id=$1',[req.params.id]);if(!p)return res.status(404).json({error:'السجل غير موجود.'});
  if(p.linked_user_id)return res.status(409).json({error:'السجل مرتبط بحساب مستخدم؛ عطّل الحساب أولًا بدل حذف بيانات الهيكل.'});
  await q('DELETE FROM structure_people WHERE id=$1',[req.params.id]);res.json({ok:true});
});

router.post('/structure/people/:id/create-account', requireAdmin, async(req,res)=>{
  const p=await one('SELECT * FROM structure_people WHERE id=$1',[req.params.id]);if(!p)return res.status(404).json({error:'السجل غير موجود.'});
  if(p.linked_user_id)return res.status(409).json({error:'تم إنشاء حساب لهذا الموظف مسبقًا.'});
  const email=String(req.body?.email||p.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:'أدخل بريدًا إلكترونيًا صحيحًا.'});
  const cfg=await getSetting('cfg'),domain=email.split('@')[1]||'';
  if(!cfg.domains.map(x=>String(x).toLowerCase()).includes(domain))return res.status(400).json({error:'البريد خارج النطاق المعتمد.'});
  const bad=validatePassword(password);if(bad)return res.status(400).json({error:bad});
  if(await one('SELECT 1 FROM users WHERE lower(email)=lower($1)',[email]))return res.status(409).json({error:'البريد مستخدم في حساب آخر.'});
  const role=req.body?.role||p.suggested_role,id='u'+Date.now().toString(36);
  if(!['secretary_general','assistant_secretary_general','director','manager','employee'].includes(role))return res.status(400).json({error:'الدور غير صالح.'});
  const manager=p.manager_employee_no?await one('SELECT id FROM users WHERE lower(employee_no)=lower($1) AND active=true',[p.manager_employee_no]):null;
  if(p.manager_employee_no&&!manager)return res.status(400).json({error:'أنشئ حساب المدير المباشر أولًا.'});
  await q(`INSERT INTO users(id,employee_no,name,email,phone,password_hash,dept_id,organization_id,manager_id,role,title,active,must_change_pw)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,true)`,[id,p.employee_no,p.name,email,p.phone,await hash(password),p.dept_id,p.organization_id,manager?.id||null,role,p.title]);
  await q('UPDATE structure_people SET linked_user_id=$1,email=$2,suggested_role=$3 WHERE id=$4',[id,email,role,p.id]);
  await adminLog(req.me.id,'admin',`أنشأ حسابًا من الهيكل للموظف ${p.name}`);res.status(201).json({id});
});

/* ============================================================
   استيراد الخطة السنوية وتحويلها إلى مهام
   ============================================================ */
const multer = require('multer');
const planUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

/* ---------- استيراد الهيكل الإداري من Excel ---------- */
const HKEY = {
  'الإدارة':'organization','الادارة':'organization','اسم الإدارة':'organization','اسم الادارة':'organization','management':'organization','organization':'organization',
  'القسم':'department','اسم القسم':'department','department':'department','section':'department',
  'الوحدة':'unit','اسم الوحدة':'unit','unit':'unit',
  'اسم منصب الإدارة العليا':'topTitle','اسم منصب الادارة العليا':'topTitle','منصب الإدارة العليا':'topTitle','منصب الادارة العليا':'topTitle',
  'الاسم':'name','اسم الموظف':'name','name':'name','full name':'name',
  'البريد':'email','البريد الإلكتروني':'email','email':'email',
  'الدور':'role','الصلاحية':'role','role':'role',
  'المسمى الوظيفي':'title','المسمى':'title','title':'title',
  'الجوال':'phone','رقم الجوال':'phone','phone':'phone',
  'كلمة المرور':'password','password':'password',
};
const STRUCT_ROLE = {
  'الأمين العام':'secretary_general','امين عام':'secretary_general','secretary_general':'secretary_general',
  'مساعد الأمين العام':'assistant_secretary_general','مساعد الامين العام':'assistant_secretary_general','assistant_secretary_general':'assistant_secretary_general',
  'مدير الإدارة':'director','مدير إدارة':'director','مدير ادارة':'director','director':'director',
  'رئيس القسم':'manager','رئيس قسم':'manager','manager':'manager',
  'موظف':'employee','employee':'employee',
  'مستشار':'consultant','مستشارة':'consultant','consultant':'consultant','advisor':'consultant','مستشار إدارة':'consultant',
};
const STRUCT_ORG_NAMES={D001:'إدارة تنمية الموارد',D002:'إدارة الإعلام وتقنية المعلومات',D003:'إدارة التخطيط والتطوير',D004:'إدارة البرامج والإغاثة والأيتام',D006:'الإدارة المالية',D007:'إدارة التعاقد والرقابة',D008:'إدارة الشؤون الإدارية',D009:'إدارة الشؤون التعليمية',D010:'إدارة العمل التطوعي الشبابي',D011:'إدارة العلاقات والمكاتب الدولية'};
const EXECUTIVE_ROLES = new Set(['secretary_general','assistant_secretary_general']);
const normalizeStructureRole = (x) => STRUCT_ROLE[String(x?.role || '').trim()] || STRUCT_ROLE[String(x?.role || '').trim().toLowerCase()];
const isStructureConsultant = (x) => /مستشار|consultant|advisor/i.test(`${x?.role || ''} ${x?.title || ''}`);
function normalizeStructurePlacement(x, role) {
  const globalPerson = EXECUTIVE_ROLES.has(role) || isStructureConsultant(x);
  x.organizationCodeNormalized = globalPerson ? '' : String(x.organizationCode || '').trim();
  x.departmentCodeNormalized = (globalPerson || role === 'director') ? '' : String(x.departmentCode || '').trim();
  return { globalPerson, organizationCode:x.organizationCodeNormalized, departmentCode:x.departmentCodeNormalized };
}
function structureRows(buffer) {
  const book = parseXlsx(buffer), out = [];
  for (const sheet of book.sheets) {
    const rows = sheet.rows.filter((r) => r.some((v) => String(v ?? '').trim()));
    if (!rows.length) continue;
    let hi = rows.findIndex((r) => r.some((v) => HKEY[String(v ?? '').trim().toLowerCase()]));
    if (hi < 0) continue;
    const keys = rows[hi].map((v) => HKEY[String(v ?? '').trim().toLowerCase()] || null);
    for (const cells of rows.slice(hi + 1)) {
      const x = { sheet:sheet.name };
      keys.forEach((k, i) => { if (k) x[k] = String(cells[i] ?? '').trim(); });
      if(x.topTitle&&!x.title)x.title=x.topTitle;
      if(x.unit)x.department=[x.department,x.unit].filter(Boolean).join(' / ');
      if(!x.role&&x.topTitle)x.role=x.topTitle;
      if (x.organization || x.department || x.topTitle || x.name || x.email) out.push(x);
    }
  }
  return out.slice(0, 1000);
}
const hv = (v) => String(v ?? '').trim().replace(/\*+$/,'').trim();
function templateSheetRows(sheet, fields) {
  if (!sheet) return [];
  const rows=sheet.rows.filter(r=>r.some(v=>hv(v)));
  if(!rows.length)return [];
  const header=rows[0].map(hv), index={};
  for(const [key,names] of Object.entries(fields)) index[key]=header.findIndex(h=>names.includes(h));
  return rows.slice(1).map(c=>Object.fromEntries(Object.entries(index).map(([k,i])=>[k,i<0?'':hv(c[i])]))).filter(x=>Object.values(x).some(Boolean));
}
function structureTemplateRows(buffer){
  const book=parseXlsx(buffer),find=n=>book.sheets.find(s=>hv(s.name)===n);
  const organizations=templateSheetRows(find('الإدارات'),{
    code:['رمز الإدارة'],name:['اسم الإدارة'],directorEmployeeNo:['الرقم الوظيفي للمدير'],active:['الحالة']
  }).filter(x=>x.code||x.name).map(x=>({entity:'organization',...x}));
  const departments=templateSheetRows(find('الأقسام'),{
    organizationCode:['رمز الإدارة'],code:['رمز القسم'],name:['اسم القسم'],headEmployeeNo:['الرقم الوظيفي لرئيس القسم'],active:['الحالة']
  }).filter(x=>x.code||x.name).map(x=>({entity:'department',...x}));
  const users=templateSheetRows(find('المستخدمون'),{
    employeeNo:['الرقم الوظيفي'],name:['الاسم الكامل'],role:['الدور في النظام'],title:['المسمى الوظيفي'],
    organizationCode:['رمز الإدارة'],departmentCode:['رمز القسم'],managerEmployeeNo:['الرقم الوظيفي للمدير المباشر'],
    phone:['رقم الجوال'],email:['البريد الإلكتروني'],active:['الحالة'],password:['كلمة المرور']
  }).filter(x=>x.employeeNo||x.name||x.email).map(x=>({entity:'user',...x}));
  if(!organizations.length&&!departments.length&&!users.length)throw new Error('القالب لا يحتوي أوراق الإدارات والأقسام والمستخدمين بالترويسات المعتمدة.');
  return [...organizations,...departments,...users];
}
function structureJsonRows(backup){
  if(!backup||backup.format!=='wamy-structure-backup'||Number(backup.version)!==1)throw new Error('صيغة النسخة غير معتمدة أو إصدارها غير مدعوم.');
  const organizations=Array.isArray(backup.organizations)?backup.organizations:[],departments=Array.isArray(backup.departments)?backup.departments:[],users=Array.isArray(backup.users)?backup.users:[];
  if(organizations.length+departments.length+users.length>1000)throw new Error('النسخة تتجاوز الحد الأقصى البالغ 1000 سجل.');
  const text=v=>String(v??'').trim(),active=v=>v===false||/^غير\s*نشط$/.test(text(v))?'غير نشط':'نشط';
  const rows=[
    ...organizations.map(x=>({entity:'organization',code:text(x.code),name:text(x.name),directorEmployeeNo:text(x.directorEmployeeNo),active:active(x.active)})),
    ...departments.map(x=>({entity:'department',organizationCode:text(x.organizationCode),code:text(x.code),name:text(x.name),headEmployeeNo:text(x.headEmployeeNo),active:active(x.active)})),
    ...users.map(x=>({entity:'user',employeeNo:text(x.employeeNo),name:text(x.name),role:text(x.role),title:text(x.title),organizationCode:text(x.organizationCode),departmentCode:text(x.departmentCode),managerEmployeeNo:text(x.managerEmployeeNo),phone:text(x.phone),email:text(x.email).toLowerCase(),active:active(x.active),password:text(x.password)}))
  ];
  if(!rows.length)throw new Error('النسخة لا تحتوي بيانات هيكل إداري.');
  return rows;
}

function eventParseDate(v, endOfDay = false) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += endOfDay ? 'T23:59:00+03:00' : 'T00:00:00+03:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00+03:00';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function eventDurationMs(unit) {
  return { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[unit] || 86400000;
}
function eventDurationTiming(row) {
  const unit = ['minute', 'hour', 'day', 'week'].includes(String(row.durationUnit || row.unit || '').trim())
    ? String(row.durationUnit || row.unit).trim()
    : 'day';
  let duration = row.durationValue !== undefined && row.durationValue !== null && row.durationValue !== ''
    ? Number(row.durationValue)
    : row.duration !== undefined && row.duration !== null && row.duration !== ''
      ? Number(row.duration)
      : null;
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) duration = null;
  let startAt = eventParseDate(row.startAt || row.start, false);
  let endAt = eventParseDate(row.endAt || row.end, true);
  const span = duration ? duration * eventDurationMs(unit) : null;
  if (startAt && span && !endAt) endAt = new Date(startAt.getTime() + span);
  else if (startAt && endAt && !duration) duration = Math.max(0.01, Math.round(((endAt - startAt) / eventDurationMs(unit)) * 100) / 100);
  else if (!startAt && endAt && span) startAt = new Date(endAt.getTime() - span);
  return { startAt, endAt, duration, unit };
}
function eventTypesBackupRows(backup) {
  const types = Array.isArray(backup?.eventTypes) ? backup.eventTypes : [];
  const rows = types.map((x) => ({
    entity: 'eventType',
    name: hv(x.name),
    description: hv(x.description),
    sort: hv(x.sort),
    active: hv(x.active || (x.active === false ? 'غير نشط' : 'نشط')),
  })).filter((x) => x.name);
  if (!rows.length && !Array.isArray(backup?.events)) throw new Error('النسخة لا تحتوي بيانات فعاليات أو أنواع فعّالة.');
  return rows;
}
function eventJsonRows(backup) {
  if (!backup || backup.format !== 'wamy-events-backup' || Number(backup.version) !== 1)
    throw new Error('صيغة النسخة غير معتمدة أو إصدارها غير مدعوم.');
  const types = Array.isArray(backup.eventTypes) ? backup.eventTypes : [];
  const events = Array.isArray(backup.events) ? backup.events : [];
  const rows = [
    ...types.map((x) => ({
      entity: 'eventType',
      name: hv(x.name),
      description: hv(x.description),
      sort: hv(x.sort),
      active: x.active === false ? 'غير نشط' : 'نشط',
    })).filter((x) => x.name),
    ...events.map((x) => ({
      entity: 'event',
      title: hv(x.title),
      typeName: hv(x.typeName || x.type),
      summary: hv(x.summary),
      organizerOrganizationCode: hv(x.organizerOrganizationCode || x.organizationCode),
      organizerDepartmentCode: hv(x.organizerDepartmentCode || x.departmentCode),
      participants: Array.isArray(x.participants) ? x.participants.join(' | ') : hv(x.participants),
      startAt: hv(x.startAt),
      endAt: hv(x.endAt),
      durationValue: hv(x.durationValue ?? x.duration),
      durationUnit: hv(x.durationUnit || x.unit),
      country: hv(x.country),
      city: hv(x.city),
      location: hv(x.location),
      notes: hv(x.notes),
      cancelledAt: hv(x.cancelledAt),
    })).filter((x) => x.title || x.typeName)
  ];
  if (!rows.length) throw new Error('النسخة لا تحتوي بيانات فعاليات.');
  return rows;
}
function eventsTemplateRows(buffer) {
  const book = parseXlsx(buffer), find = (n) => book.sheets.find((s) => hv(s.name) === n);
  const types = templateSheetRows(find('أنواع الفعاليات'), {
    name: ['اسم النوع'],
    description: ['الوصف', 'الوصف المختصر'],
    sort: ['الترتيب'],
    active: ['الحالة'],
  }).filter((x) => x.name).map((x) => ({ entity: 'eventType', ...x }));
  const events = templateSheetRows(find('الفعاليات'), {
    title: ['اسم الفعالية', 'العنوان'],
    typeName: ['نوع الفعالية', 'نوع الفعالية / المناسبة'],
    summary: ['وصف مختصر', 'الوصف المختصر'],
    organizerOrganizationCode: ['رمز الإدارة المنظمة'],
    organizerDepartmentCode: ['رمز القسم المنظم', 'رمز القسم'],
    participants: ['الإدارات المشاركة', 'الأقسام المشاركة'],
    startAt: ['تاريخ البداية', 'تاريخ ووقت البداية'],
    endAt: ['تاريخ النهاية', 'تاريخ ووقت النهاية'],
    durationValue: ['المدة'],
    durationUnit: ['وحدة المدة'],
    country: ['الدولة'],
    city: ['المدينة'],
    location: ['الموقع', 'الموقع التفصيلي'],
    notes: ['الملاحظات'],
    cancelledAt: ['تاريخ الإلغاء'],
  }).filter((x) => x.title || x.typeName).map((x) => ({ entity: 'event', ...x }));
  if (!types.length && !events.length) throw new Error('لم يُعثر على أوراق صالحة للفعاليات. استخدم ورقتي: أنواع الفعاليات، الفعاليات.');
  return [...types, ...events];
}
function eventsBackupRows(backup) {
  if (!backup || backup.format !== 'wamy-events-backup' || Number(backup.version) !== 1)
    throw new Error('صيغة النسخة غير معتمدة أو إصدارها غير مدعوم.');
  return eventJsonRows(backup);
}
router.post('/structure/parse-json', requireAdmin, async (req,res)=>{
  try{const rows=structureJsonRows(req.body?.backup);res.json({rows,count:rows.length});}
  catch(e){res.status(422).json({error:'تعذرت قراءة نسخة JSON: '+e.message});}
});
router.post('/structure/parse', requireAdmin, planUpload.single('file'), async (req,res) => {
  if (!req.file) return res.status(400).json({error:'اختر ملف Excel.'});
  try {
    let rows=structureTemplateRows(req.file.buffer);
    if(!rows.length) rows=structureRows(req.file.buffer);
    if (!rows.length) return res.status(422).json({error:'لم يُعثر على ترويسة صالحة. استخدم: اسم منصب الإدارة العليا، اسم الإدارة، القسم، الوحدة، الاسم، البريد، الدور، المسمى الوظيفي، الجوال، كلمة المرور.'});
    res.json({rows,count:rows.length});
  } catch(e) { res.status(422).json({error:'تعذرت قراءة ملف Excel: '+e.message}); }
});

router.post('/structure/import', requireAdmin, async (req,res) => {
  const rows=Array.isArray(req.body?.rows)?req.body.rows.slice(0,1000):[];
  const dryRun=req.body?.dryRun!==false;
  if(!rows.length)return res.status(400).json({error:'لا توجد صفوف للاستيراد.'});
  if(rows.some(x=>x.entity)) return importTemplateStructure(req,res,rows,dryRun);
  const cfg=await getSetting('cfg'), domains=cfg.domains.map(x=>x.toLowerCase());
  const orgNames=new Set(), deptNames=new Set(), emails=new Set(), results=[];
  for(const [i,x] of rows.entries()){
    const organization=String(x.organization||'').trim(), department=String(x.department||'').trim();
    const name=String(x.name||'').trim(),email=String(x.email||'').trim().toLowerCase();
    const roleText=String(x.role||x.topTitle||'').trim();
    const role=STRUCT_ROLE[roleText]||STRUCT_ROLE[roleText.toLowerCase()]||(name?'employee':null),globalPerson=EXECUTIVE_ROLES.has(role)||isStructureConsultant(x);
    const result={row:i+1,organization,department,name,email,role};
    if(!organization&&!globalPerson){results.push({...result,status:'error',message:'اسم الإدارة مطلوب'});continue;}
    if(organization)orgNames.add(organization);if(organization&&department)deptNames.add(organization+'\u0000'+department);
    if(!name&&!email){results.push({...result,status:'ready',message:department?'قسم جاهز':'إدارة جاهزة'});continue;}
    if(!name||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){results.push({...result,status:'error',message:'اسم المستخدم والبريد الصحيح مطلوبان'});continue;}
    if(!domains.includes(email.split('@')[1])){results.push({...result,status:'error',message:'البريد خارج النطاق المعتمد'});continue;}
    if(!role){results.push({...result,status:'error',message:'الدور غير معروف'});continue;}
    if(['manager','employee'].includes(role)&&!globalPerson&&!department){results.push({...result,status:'error',message:'القسم مطلوب لرئيس القسم والموظف'});continue;}
    const ph=normPhone(x.phone);if(ph.error){results.push({...result,status:'error',message:ph.error});continue;}
    if(emails.has(email)||await one('SELECT 1 FROM users WHERE lower(email)=lower($1)',[email])){results.push({...result,status:'skipped',message:'البريد موجود مسبقًا'});continue;}
    const password=String(x.password||'').trim()||genPassword(),bad=validatePassword(password);
    if(bad){results.push({...result,status:'error',message:bad});continue;}
    emails.add(email);results.push({...result,status:'ready',message:'مستخدم جاهز',password});
  }
  if(!dryRun){
    await tx(async c=>{
      const orgMap=new Map();
      for(const name of orgNames){let r=(await c.query('SELECT id FROM organizations WHERE lower(name)=lower($1)',[name])).rows[0];if(!r){const id='o'+Date.now().toString(36)+crypto.randomInt(1e5).toString(36);await c.query('INSERT INTO organizations(id,name) VALUES($1,$2)',[id,name]);r={id};}orgMap.set(name,r.id);}
      const deptMap=new Map();
      for(const key of deptNames){const [orgName,deptName]=key.split('\u0000'),org=orgMap.get(orgName);let r=(await c.query('SELECT id FROM departments WHERE organization_id=$1 AND lower(name)=lower($2)',[org,deptName])).rows[0];if(!r){const id='d'+Date.now().toString(36)+crypto.randomInt(1e5).toString(36);await c.query('INSERT INTO departments(id,name,organization_id) VALUES($1,$2,$3)',[id,deptName,org]);r={id};}deptMap.set(key,r.id);}
      for(const x of results.filter(r=>r.status==='ready'&&r.name)){
        const id='u'+Date.now().toString(36)+crypto.randomInt(1e6).toString(36),org=orgMap.get(x.organization),dept=x.department?deptMap.get(x.organization+'\u0000'+x.department):null;
        await c.query(`INSERT INTO users(id,name,email,phone,password_hash,dept_id,organization_id,role,title,must_change_pw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,[id,x.name,x.email,normPhone(rows[x.row-1].phone).phone||'',await hash(x.password),dept,org,x.role,String(rows[x.row-1].title||'')]);
        x.status='created';x.id=id;
      }
    });
    await adminLog(req.me.id,'admin',`استورد هيكلًا إداريًا: ${orgNames.size} إدارة، ${deptNames.size} قسم، ${results.filter(x=>x.status==='created').length} مستخدم`);
  }
  const summary=results.reduce((m,x)=>((m[x.status]=(m[x.status]||0)+1),m),{});
  res.json({dryRun,summary,results,organizations:orgNames.size,departments:deptNames.size});
});

async function importTemplateStructure(req,res,rows,dryRun){
  const orgRows=rows.filter(x=>x.entity==='organization'),deptRows=rows.filter(x=>x.entity==='department'),userRows=rows.filter(x=>x.entity==='user');
  const cfg=await getSetting('cfg'),domains=cfg.domains.map(x=>x.toLowerCase());
  const [dbOrgs,dbDepts,dbUsers]=await Promise.all([
    all('SELECT code FROM organizations WHERE code IS NOT NULL'),all('SELECT organization_id,code FROM departments WHERE code IS NOT NULL'),
    all('SELECT employee_no,email FROM users')]);
  const dbOrgCodes=new Set(dbOrgs.map(x=>String(x.code).toLowerCase())),dbEmp=new Set(dbUsers.map(x=>String(x.employee_no||'').toLowerCase()).filter(Boolean)),dbEmail=new Set(dbUsers.map(x=>x.email.toLowerCase()));
  const orgCount=new Map(),deptCount=new Map(),empCount=new Map(),emailCount=new Map();
  orgRows.forEach(x=>orgCount.set(x.code,(orgCount.get(x.code)||0)+1));
  deptRows.forEach(x=>{const k=x.organizationCode+'\0'+x.code;deptCount.set(k,(deptCount.get(k)||0)+1);});
  userRows.forEach(x=>{empCount.set(x.employeeNo,(empCount.get(x.employeeNo)||0)+1);const email=String(x.email||'').trim().toLowerCase();if(email)emailCount.set(email,(emailCount.get(email)||0)+1);});
  const orgMap=new Map(orgRows.map(x=>[x.code,x])),deptMap=new Map(deptRows.map(x=>[x.organizationCode+'\0'+x.code,x])),userMap=new Map(userRows.map(x=>[x.employeeNo,x]));
  // بعض الملفات القديمة وضعت الرمز أو الدور العام مكان اسم الإدارة؛ نستعيد الاسم من نطاق الهيكل المرفق.
  for(const x of orgRows){
    if(x.name===`الإدارة ${x.code}`||x.name==='مدير إدارة')x.name=STRUCT_ORG_NAMES[x.code]||'اسم الإدارة غير محدد';
  }
  const results=[];let seq=0;
  const add=(x,errors,password)=>results.push({row:++seq,entity:x.entity,code:x.code||x.employeeNo,name:x.name,status:errors.length?'error':'ready',message:errors.join('، ')||'جاهز للاستيراد',password});
  for(const x of orgRows){const e=[];if(!x.code)e.push('رمز الإدارة مطلوب');if(!x.name)e.push('اسم الإدارة مطلوب');if(orgCount.get(x.code)>1)e.push('رمز الإدارة مكرر داخل الملف');if(dbOrgCodes.has(x.code.toLowerCase()))e.push('رمز الإدارة موجود مسبقًا');const d=userMap.get(x.directorEmployeeNo),dr=d&&(STRUCT_ROLE[d.role]||STRUCT_ROLE[d.role?.toLowerCase()]);if(!x.directorEmployeeNo)e.push('الرقم الوظيفي للمدير مطلوب');else if(!d)e.push('رقم مدير الإدارة غير موجود في ورقة المستخدمين');else if(!['director','secretary_general','assistant_secretary_general'].includes(dr)||d.organizationCode!==x.code)e.push('مسؤول الإدارة لا يحمل دورًا قياديًا صحيحًا أو يتبع إدارة أخرى');add(x,e);}
  for(const x of deptRows){const e=[],k=x.organizationCode+'\0'+x.code;if(!x.organizationCode||!orgMap.has(x.organizationCode))e.push('رمز الإدارة غير موجود');if(!x.code)e.push('رمز القسم مطلوب');if(!x.name)e.push('اسم القسم مطلوب');if(deptCount.get(k)>1)e.push('رمز القسم مكرر داخل الإدارة');if(dbDepts.some(d=>String(d.code).toLowerCase()===x.code.toLowerCase()))e.push('رمز القسم موجود مسبقًا');const h=userMap.get(x.headEmployeeNo);if(!x.headEmployeeNo)e.push('الرقم الوظيفي لرئيس القسم مطلوب');else if(!h)e.push('رقم رئيس القسم غير موجود في ورقة المستخدمين');else if((STRUCT_ROLE[h.role]||STRUCT_ROLE[h.role?.toLowerCase()])!=='manager'||h.organizationCode!==x.organizationCode||h.departmentCode!==x.code)e.push('رئيس القسم لا يتبع القسم المحدد أو دوره غير صحيح');add(x,e);}
  for(const x of userRows){
    const e=[],role=normalizeStructureRole(x),placement=normalizeStructurePlacement(x,role);x.roleNormalized=role;
    const email=String(x.email||'').toLowerCase();
    if(!x.employeeNo)e.push('الرقم الوظيفي مطلوب');if(empCount.get(x.employeeNo)>1)e.push('الرقم الوظيفي مكرر داخل الملف');if(dbEmp.has(x.employeeNo.toLowerCase()))e.push('الرقم الوظيفي موجود مسبقًا');if(!x.name)e.push('الاسم الكامل مطلوب');if(!role)e.push('الدور غير معروف');
    if(!placement.globalPerson&&!orgMap.has(placement.organizationCode))e.push('رمز الإدارة غير موجود');
    if(['manager','employee'].includes(role)&&!placement.globalPerson&&!deptMap.has(placement.organizationCode+'\0'+placement.departmentCode))e.push('القسم غير موجود أو لا يتبع الإدارة');
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))e.push('البريد غير صحيح');else if(emailCount.get(email)>1)e.push('البريد مكرر داخل الملف');else if(!domains.includes(email.split('@')[1]))e.push('البريد خارج النطاق المعتمد');else if(dbEmail.has(email))e.push('البريد موجود مسبقًا');const ph=normPhone(x.phone);if(ph.error)e.push(ph.error);x.phoneNormalized=ph.phone||'';
    if(x.managerEmployeeNo){const m=userMap.get(x.managerEmployeeNo),mr=m&&normalizeStructureRole(m),mp=m&&normalizeStructurePlacement(m,mr);if(!m)e.push('المدير المباشر غير موجود');else if(m.employeeNo===x.employeeNo)e.push('لا يمكن أن يكون المستخدم مدير نفسه');else if(!placement.globalPerson&&mp.organizationCode!==placement.organizationCode)e.push('المدير المباشر يتبع إدارة أخرى');else if(role==='employee'&&!placement.globalPerson&&(mr!=='manager'||mp.departmentCode!==placement.departmentCode))e.push('المدير المباشر للموظف يجب أن يكون رئيس قسمه');else if(role==='manager'&&mr!=='director')e.push('المدير المباشر لرئيس القسم يجب أن يكون مدير الإدارة');}else if(!['director','secretary_general','assistant_secretary_general'].includes(role)&&!placement.globalPerson)e.push('المدير المباشر مطلوب');
    const password=String(x.password||'').trim()||genPassword();const bad=validatePassword(password);if(bad)e.push(bad);x.password=password;add(x,e,password);
  }
  const errors=results.filter(x=>x.status==='error').length;
  if(!dryRun&&errors)return res.status(409).json({error:`لم يتم الاستيراد. صحح ${errors} خطأ أولًا؛ العملية لم تُنشئ أي بيانات.`,dryRun:true,summary:{error:errors,ready:results.length-errors},results,organizations:orgRows.length,departments:deptRows.length,users:userRows.length});
  if(!dryRun){
    await tx(async c=>{
      const orgIds=new Map(),deptIds=new Map(),userIds=new Map();
      for(const x of orgRows){const id='o'+Date.now().toString(36)+crypto.randomInt(1e6).toString(36);await c.query('INSERT INTO organizations(id,code,name) VALUES($1,$2,$3)',[id,x.code,x.name]);orgIds.set(x.code,id);}
      for(const x of deptRows){const id='d'+Date.now().toString(36)+crypto.randomInt(1e6).toString(36);await c.query('INSERT INTO departments(id,code,name,organization_id) VALUES($1,$2,$3,$4)',[id,x.code,x.name,orgIds.get(x.organizationCode)]);deptIds.set(x.organizationCode+'\0'+x.code,id);}
      for(const x of userRows){const id='u'+Date.now().toString(36)+crypto.randomInt(1e7).toString(36);await c.query(`INSERT INTO users(id,employee_no,name,email,phone,password_hash,dept_id,organization_id,role,title,active,must_change_pw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,[id,x.employeeNo,x.name,x.email.toLowerCase(),x.phoneNormalized,await hash(x.password),x.departmentCodeNormalized?deptIds.get(x.organizationCodeNormalized+'\0'+x.departmentCodeNormalized):null,x.organizationCodeNormalized?orgIds.get(x.organizationCodeNormalized):null,x.roleNormalized,x.title||'',!/^غير\s*نشط$/.test(x.active||'')]);userIds.set(x.employeeNo,id);}
      for(const x of userRows)if(x.managerEmployeeNo)await c.query('UPDATE users SET manager_id=$1 WHERE id=$2',[userIds.get(x.managerEmployeeNo),userIds.get(x.employeeNo)]);
      for(const x of orgRows)await c.query('UPDATE organizations SET director_id=$1 WHERE id=$2',[userIds.get(x.directorEmployeeNo),orgIds.get(x.code)]);
      for(const x of deptRows)await c.query('UPDATE departments SET head_id=$1 WHERE id=$2',[userIds.get(x.headEmployeeNo),deptIds.get(x.organizationCode+'\0'+x.code)]);
    });
    results.forEach(x=>x.status='created');await adminLog(req.me.id,'admin',`استورد القالب المعتمد: ${orgRows.length} إدارة، ${deptRows.length} قسم، ${userRows.length} مستخدم`);
  }
  const summary=results.reduce((m,x)=>((m[x.status]=(m[x.status]||0)+1),m),{});
  return res.json({dryRun,summary,results,organizations:orgRows.length,departments:deptRows.length,users:userRows.length});
}

const QUARTERS = {
  'الربع الأول': [1, 3], 'الربع الاول': [1, 3], 'q1': [1, 3], '1': [1, 3],
  'الربع الثاني': [4, 6], 'q2': [4, 6], '2': [4, 6],
  'الربع الثالث': [7, 9], 'q3': [7, 9], '3': [7, 9],
  'الربع الرابع': [10, 12], 'q4': [10, 12], '4': [10, 12],
  'سنوي': [1, 12], 'مستمر': [1, 12], 'طوال العام': [1, 12], '': [1, 12],
};
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** يشتق التكرار من عدد مرات التنفيذ الوارد في الخطة */
function recurFromTimes(times) {
  const n = Number(times) || 1;
  if (n >= 300) return 'daily';
  if (n >= 40) return 'weekly';
  if (n >= 10) return 'monthly';
  if (n === 4) return 'quarterly';
  return null;
}

const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const clean = (s) => String(s == null ? '' : s).replace(/[\u202a-\u202e\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; };

/** يحدد أعمدة الجدول من صف الترويسة بمطابقة الأسماء العربية */
function mapHeader(row) {
  const idx = {};
  const want = {
    activity: ['النشاط'], program: ['البرنامج'], initiative: ['المبادرة'],
    goal: ['الهدف الإستراتيجي', 'الهدف الاستراتيجي'], indicator: ['المؤشر'],
    dept: ['القسم المنفذ', 'القسم المنفّذ'], supervisor: ['الجهة لمشرفة', 'الجهة المشرفة'],
    country: ['الدولة'], times: ['مرات التنفيذ'], benef: ['المستفيدون'],
    budget: ['الميزانية بالريال'], approved: ['الميزانية المعتمدة'], no: ['م'],
  };
  row.forEach((cell, i) => {
    const c = clean(cell);
    if (!c) return;
    for (const [key, names] of Object.entries(want))
      if (idx[key] === undefined && names.some((n) => c === n || c.replace(/\s/g, '') === n.replace(/\s/g, ''))) idx[key] = i;
  });
  return idx;
}

/** يحدد بداية الأعمدة الشهرية: 12 شهرًا × 3 أعمدة (مرات، مستفيدون، ميزانية) */
function findMonthStart(rows, headerRow) {
  for (let r = headerRow; r < Math.min(headerRow + 3, rows.length); r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (clean(rows[r][c]) === 'يناير') return c;
    }
  }
  return -1;
}

/** استخراج صفوف الخطة من ملف Excel — المصدر الموثوق */
function parseXlsxPlan(buffer, sheetName) {
  const { parseXlsx } = require('./xlsx');
  const wb = parseXlsx(buffer);
  const sheets = wb.sheets;
  const chosen = sheetName
    ? sheets.find((s) => s.name === sheetName)
    : sheets.find((s) => /تفصيل/.test(s.name)) || sheets[0];
  if (!chosen) throw new Error('لم يُعثر على ورقة مناسبة في الملف.');

  const rows = chosen.rows;
  let headerRow = -1, idx = null;
  for (let r = 0; r < Math.min(12, rows.length); r++) {
    const m = mapHeader(rows[r]);
    if (m.activity !== undefined && m.program !== undefined) { headerRow = r; idx = m; break; }
  }
  if (headerRow < 0)
    throw new Error('لم يُعثر على صف ترويسة يحتوي على «النشاط» و«البرنامج». تأكد أنك اخترت ورقة الخطة التفصيلية.');

  const ms = findMonthStart(rows, headerRow);
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const activity = clean(row[idx.activity]);
    if (!activity) continue;
    if (idx.no !== undefined && row[idx.no] == null && !activity) continue;

    const months = [];
    if (ms >= 0) {
      for (let m = 0; m < 12; m++) {
        const c = ms + m * 3;
        const t = num(row[c]);
        if (t) months.push({ m: m + 1, times: t, benef: num(row[c + 1]), budget: num(row[c + 2]) });
      }
    }
    out.push({
      idx: num(row[idx.no]) || out.length + 1,
      activity,
      program: clean(row[idx.program]),
      initiative: idx.initiative !== undefined ? clean(row[idx.initiative]) : '',
      goal: idx.goal !== undefined ? clean(row[idx.goal]) : '',
      indicator: idx.indicator !== undefined ? clean(row[idx.indicator]) : '',
      deptName: idx.dept !== undefined ? clean(row[idx.dept]) : '',
      supervisor: idx.supervisor !== undefined ? clean(row[idx.supervisor]) : '',
      country: idx.country !== undefined ? clean(row[idx.country]).replace(/^ـ+$/, '') : '',
      times: idx.times !== undefined ? num(row[idx.times]) : null,
      beneficiaries: idx.benef !== undefined ? num(row[idx.benef]) : null,
      budget: idx.approved !== undefined && num(row[idx.approved]) != null
        ? num(row[idx.approved]) : (idx.budget !== undefined ? num(row[idx.budget]) : null),
      months,
      source: 'xlsx',
      needsReview: false,
    });
  }
  return { rows: out, sheet: chosen.name, sheets: sheets.map((s) => s.name) };
}

/** استخراج من PDF — البنية موثوقة والنص العربي قد يكون مشوّهًا */
function parsePdfPlan(text) {
  const rows = [];
  let suspicious = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[\u202a-\u202e\u200e\u200f]/g, '');
    const parts = line.split('\t').map((x) => x.trim()).filter((x) => x !== '');
    if (parts.length < 4) continue;
    if (!/^\d{1,3}$/.test(parts[0])) continue;
    const tail = parts.slice(-3).map(num);
    if (tail.some((v) => v === null)) continue;
    const [times, beneficiaries, budget] = tail;
    const mid = parts.slice(1, -3).map(clean).filter(Boolean);
    if (!mid.length) continue;
    const program = mid[0];
    const activity = clean(mid.slice(1).join(' ')) || program;
    const flagged = /امل|اإل|اال|ال[أإآ]|رال|مل[اآ]/.test(program + ' ' + activity);
    if (flagged) suspicious++;
    rows.push({
      idx: Number(parts[0]), program, activity, times, beneficiaries, budget,
      months: [], deptName: '', initiative: '', goal: '', source: 'pdf', needsReview: flagged,
    });
  }
  return { rows, suspicious };
}

router.post('/plan/parse', requirePlanAccess, planUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يُرفع ملف.' });
  const name = (req.file.originalname || '').toLowerCase();
  const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xlsm') ||
    req.file.mimetype.includes('spreadsheet') || req.file.buffer.slice(0, 2).toString() === 'PK';

  try {
    if (isXlsx) {
      const r = parseXlsxPlan(req.file.buffer, req.body?.sheet);
      return res.json({
        ...r, source: 'xlsx',
        warning: r.rows.length
          ? `استُخرج ${r.rows.length} نشاطًا من ورقة «${r.sheet}» — النص مقروء من المصدر مباشرة بلا تشويه.` +
            (r.rows.some((x) => x.months.length) ? ' وتم استخراج التوزيع الشهري لتوليد الإجراءات التنفيذية تلقائيًا.' : '')
          : 'لم يُعثر على أنشطة في هذه الورقة.',
      });
    }
    const { PDFParse } = require('pdf-parse');
    const p = new PDFParse({ data: new Uint8Array(req.file.buffer) });
    const text = (await p.getText()).text;
    await p.destroy();
    const r = parsePdfPlan(text);
    return res.json({
      rows: r.rows, source: 'pdf', sheets: [],
      warning: r.rows.length
        ? `استُخرج ${r.rows.length} صفًا من ملف PDF. الأرقام والبنية موثوقة، أما النص العربي فقد يحتوي تشويهًا ` +
          `في الحروف (${r.suspicious} صفًا مشتبهًا) بسبب طريقة تصدير الملف. راجع كل عنوان قبل الإنشاء — ` +
          `والأفضل الاستيراد من ملف Excel الأصلي.`
        : 'لم يُعثر على صفوف بصيغة جدول الخطة التفصيلية.',
    });
  } catch (e) {
    return res.status(422).json({ error: 'تعذّرت قراءة الملف: ' + e.message });
  }
});

/** إنشاء المهام من صفوف الخطة بعد مراجعتها */
/** يضمن وجود تصنيف الخطة وحقولها قبل الاستيراد (للتركيبات المُحدَّثة) */
const PLAN_FIELDS = [
  ['pf_goal', 'الهدف الإستراتيجي', 'text'], ['pf_initiative', 'المبادرة', 'text'],
  ['pf_program', 'البرنامج', 'text'], ['pf_times', 'مرات التنفيذ المخططة', 'number'],
  ['pf_benef', 'المستفيدون المستهدفون', 'number'], ['pf_budget', 'الميزانية المعتمدة (ريال)', 'number'],
];
async function ensurePlanMeta() {
  await q(`INSERT INTO categories(id,name,sort) VALUES('plan','برنامج/نشاط من الخطة السنوية',
             (SELECT COALESCE(MAX(sort),0)+1 FROM categories)) ON CONFLICT (id) DO NOTHING`);
  for (const [id, name, type] of PLAN_FIELDS)
    await q(`INSERT INTO custom_fields(id,name,type,required,cats,sort)
             VALUES($1,$2,$3,false,'["plan"]'::jsonb,(SELECT COALESCE(MAX(sort),0)+1 FROM custom_fields))
             ON CONFLICT (id) DO NOTHING`, [id, name, type]);
}

router.post('/plan/import', requirePlanAccess, async (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 400) : null;
  const year = Number(b.year) || new Date().getFullYear();
  const dryRun = b.dryRun !== false;
  if (!rows || !rows.length) return res.status(400).json({ error: 'لا توجد صفوف للاستيراد.' });

  if (!dryRun) await ensurePlanMeta();
  const organizationId = req.me.role === 'director' ? req.me.organization_id : b.organization;
  if (!organizationId) return res.status(400).json({ error: 'حدد الإدارة المرتبطة بالخطة.' });
  const organization = await one('SELECT id,name FROM organizations WHERE id=$1', [organizationId]);
  if (!organization) return res.status(400).json({ error: 'الإدارة المحددة غير موجودة.' });
  const depts = await all('SELECT id,name FROM departments WHERE organization_id=$1', [organizationId]);
  const cats = await all('SELECT id,name FROM categories');
  const users = await all(`SELECT id,name,dept_id,role FROM users WHERE active=true AND organization_id=$1`, [organizationId]);
  const existing = new Set((await all('SELECT plan_ref FROM tasks WHERE plan_year=$1 AND plan_ref IS NOT NULL', [year])).map((r) => r.plan_ref));
  const seen = new Set();
  const results = [];

  for (const [i, r] of rows.entries()) {
    const activity = String(r.activity || '').trim();
    const program = String(r.program || '').trim();
    const out = { row: i + 1, activity, program };
    const push = (status, message, extra) => results.push({ ...out, status, message, ...(extra || {}) });

    if (!activity) { push('error', 'اسم النشاط مفقود'); continue; }

    const dept = depts.find((d) => d.id === r.dept || d.name === r.dept);
    if (!dept) { push('error', 'حدّد القسم المنفّذ لهذا النشاط'); continue; }

    const owner = users.find((u) => u.id === r.assignee);
    if (!owner) { push('error', 'حدّد رئيس القسم الذي تُسند إليه المهمة'); continue; }
    if (owner.role !== 'manager' || owner.dept_id !== dept.id) {
      push('error', `لا يصح إسناد نشاط الخطة إلى ${owner.name} — اختر رئيس القسم المحدد`); continue;
    }

    const ref = String(r.ref || `${year}/${dept.id}/${r.idx || i + 1}`);
    if (existing.has(ref) || seen.has(ref)) { push('skipped', 'مستوردة مسبقًا من الخطة نفسها'); continue; }

    // التواريخ من التوزيع الشهري إن وُجد، وإلا من الربع، وإلا السنة كاملة
    const mo = Array.isArray(r.months) ? r.months.filter((x) => x && x.m >= 1 && x.m <= 12) : [];
    let m1, m2;
    if (mo.length) { m1 = Math.min(...mo.map((x) => x.m)); m2 = Math.max(...mo.map((x) => x.m)); }
    else { [m1, m2] = QUARTERS[String(r.quarter || '').trim()] || QUARTERS['']; }
    const start = `${year}-${pad(m1)}-01`;
    const due = `${year}-${pad(m2)}-${pad(lastDay(year, m2))}`;
    const cat = cats.find((c) => c.id === r.cat) || cats.find((c) => c.id === 'plan') || cats[0];
    const times = Number(r.times) || 1;

    seen.add(ref);
    if (dryRun) {
      push('ready', 'جاهزة للإنشاء', {
        dept: dept.name, assignee: owner.name, start, due,
        steps: mo.length, recur: mo.length ? null : recurFromTimes(times),
      });
      continue;
    }

    const cf = {};
    if (r.initiative) cf.pf_initiative = r.initiative;
    if (r.goal) cf.pf_goal = r.goal;
    if (program) cf.pf_program = program;
    if (times) cf.pf_times = times;
    if (r.beneficiaries != null) cf.pf_benef = r.beneficiaries;
    if (r.budget != null) cf.pf_budget = r.budget;
    if (r.quarter) cf.pf_quarter = r.quarter;

    const descParts = [];
    if (r.goal) descParts.push(`الهدف الإستراتيجي: ${r.goal}`);
    if (r.initiative) descParts.push(`المبادرة: ${r.initiative}`);
    if (program) descParts.push(`البرنامج: ${program}`);
    if (times) descParts.push(`مرات التنفيذ المخططة: ${times}`);
    if (r.beneficiaries != null) descParts.push(`المستفيدون: ${Number(r.beneficiaries).toLocaleString('en')}`);
    if (r.budget != null) descParts.push(`الميزانية: ${Number(r.budget).toLocaleString('en')} ريال`);
    descParts.push(`مستوردة من الخطة السنوية ${year} — مرجع ${ref}`);

    const id = await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(4242)');
      const rr = await c.query(
        `SELECT 'T-' || lpad((COALESCE(MAX(NULLIF(regexp_replace(id,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS id FROM tasks`
      );
      const nid = rr.rows[0].id;
      await c.query(
        `INSERT INTO tasks(id,title,description,priority_id,category_id,dept_id,assignee_id,creator_id,status_id,
           start_date,est_days,due_date,progress,notes,recur,cf,plan_ref,plan_year)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'new',$9,$10,$11,0,'',$12,$13,$14,$15)`,
        [nid, activity, descParts.join(' · '), r.pri || 'medium', cat.id, dept.id, owner.id, req.me.id,
         start, Math.max(1, Math.round((new Date(due) - new Date(start)) / 86400000) || 1), due,
         mo.length ? null : recurFromTimes(times), JSON.stringify(cf), ref, year]
      );
      // توليد الإجراءات التنفيذية من التوزيع الشهري المعتمد في الخطة
      for (const [k, x] of mo.entries()) {
        const sd = `${year}-${pad(x.m)}-01`;
        const ed = `${year}-${pad(x.m)}-${pad(lastDay(year, x.m))}`;
        const bits = [];
        if (x.times) bits.push(`${x.times} مرة`);
        if (x.benef) bits.push(`${Number(x.benef).toLocaleString('en')} مستفيد`);
        if (x.budget) bits.push(`${Number(x.budget).toLocaleString('en')} ريال`);
        await c.query(
          `INSERT INTO steps(task_id,title,start_date,duration_days,due_date,status,owner_id,note,sort)
           VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
          [nid, `تنفيذ شهر ${AR_MONTHS[x.m - 1]}`, sd,
           Math.round((new Date(ed) - new Date(sd)) / 86400000) + 1, ed, owner.id, bits.join(' · '), k + 1]
        );
      }
      return nid;
    });
    await q('INSERT INTO activity(task_id,user_id,type,text) VALUES($1,$2,$3,$4)',
      [id, req.me.id, 'create', `أُنشئت من الخطة السنوية ${year} (${ref}) وأُسندت إلى ${owner.name}`]);
    await notify({ kind: 'assign', taskId: id, actorId: req.me.id, to: [owner.id],
      body: `أُسند إليك نشاط من الخطة السنوية ${year}: «${activity}» — الاستحقاق ${due}` });
    push('created', `أُنشئت المهمة ${id}${mo.length ? ` مع ${mo.length} إجراءً تنفيذيًا` : ''}`,
      { id, dept: dept.name, assignee: owner.name, start, due, steps: mo.length });
  }

  const summary = results.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
  if (!dryRun) await adminLog(req.me.id, 'admin',
    `استورد الخطة السنوية ${year}: ${summary.created || 0} مهمة جديدة، ${summary.skipped || 0} متجاوَزة، ${summary.error || 0} خطأ`);
  res.json({ dryRun, year, summary, results });
});

/* ============================================================
   القوائم المرجعية — تصنيفات، حالات، أولويات، إدارات، حقول
   ============================================================ */
const META = {
  organizations: { table: 'organizations', taskCol: null, label: 'الإدارة' },
  departments: { table: 'departments', taskCol: 'dept_id', label: 'القسم' },
  categories: { table: 'categories', taskCol: 'category_id', label: 'التصنيف' },
  statuses: { table: 'statuses', taskCol: 'status_id', label: 'الحالة' },
  priorities: { table: 'priorities', taskCol: 'priority_id', label: 'الأولوية' },
  custom_fields: { table: 'custom_fields', taskCol: null, label: 'الحقل' },
};

router.post('/meta/:kind', requireAdmin, async (req, res) => {
  const m = META[req.params.kind];
  if (!m) return res.status(400).json({ error: 'نوع غير معروف.' });
  const b = req.body || {};
  b.name = String(b.name || '').trim();
  if (!b.name) return res.status(400).json({ error: 'الاسم مطلوب.' });
  if(['organizations','departments'].includes(m.table)){b.code=String(b.code||'').trim();if(!b.code)return res.status(400).json({error:'الرمز مطلوب.'});}
  if (m.table === 'departments') {
    const org = await one('SELECT id FROM organizations WHERE id=$1', [b.organization]);
    if (!org) return res.status(400).json({ error: 'يجب اختيار إدارة صحيحة للقسم.' });
  }
  if (['organizations','departments'].includes(m.table)) {
    const dup = m.table === 'organizations'
      ? await one('SELECT 1 FROM organizations WHERE lower(name)=lower($1)', [b.name])
      : await one('SELECT 1 FROM departments WHERE organization_id=$1 AND lower(name)=lower($2)', [b.organization,b.name]);
    if (dup) return res.status(409).json({ error: `الاسم «${b.name}» موجود مسبقًا.` });
    const codeDup=m.table==='organizations'?await one('SELECT 1 FROM organizations WHERE lower(code)=lower($1)',[b.code]):await one('SELECT 1 FROM departments WHERE organization_id=$1 AND lower(code)=lower($2)',[b.organization,b.code]);
    if(codeDup)return res.status(409).json({error:`الرمز «${b.code}» موجود مسبقًا.`});
  }
  const id = String(b.id || 'c' + Date.now().toString(36));
  if (m.table === 'statuses')
    await q('INSERT INTO statuses(id,name,cls,color,is_open,sort) VALUES($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(sort),0)+1 FROM statuses))',
      [id, b.name, b.cls || 'b-gray', b.color || 'var(--gray)', b.open !== false]);
  else if (m.table === 'priorities')
    await q('INSERT INTO priorities(id,name,cls,color,rank) VALUES($1,$2,$3,$4,$5)', [id, b.name, b.cls || 'b-gray', b.color || 'var(--gray)', b.rank || 1]);
  else if (m.table === 'custom_fields')
    await q('INSERT INTO custom_fields(id,name,type,required,cats,sort) VALUES($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(sort),0)+1 FROM custom_fields))',
      [id, b.name, b.type || 'text', !!b.req, JSON.stringify(b.cats || [])]);
  else if (m.table === 'departments') {
    const head=b.headEmployeeNo?await one("SELECT id FROM users WHERE lower(employee_no)=lower($1) AND role='manager' AND dept_id IS NOT NULL",[b.headEmployeeNo]):null;
    if(b.headEmployeeNo&&!head)return res.status(400).json({error:'رئيس القسم غير موجود أو لا يحمل دور رئيس قسم.'});
    await q('INSERT INTO departments(id,code,name,organization_id,head_id,sort) VALUES($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(sort),0)+1 FROM departments))',[id,b.code,b.name,b.organization,head?.id||null]);
  }
  else if(m.table==='organizations') {
    const director=b.directorEmployeeNo?await one("SELECT id FROM users WHERE lower(employee_no)=lower($1) AND role='director'",[b.directorEmployeeNo]):null;
    if(b.directorEmployeeNo&&!director)return res.status(400).json({error:'مدير الإدارة غير موجود أو لا يحمل دور مدير إدارة.'});
    await q('INSERT INTO organizations(id,code,name,director_id,sort) VALUES($1,$2,$3,$4,(SELECT COALESCE(MAX(sort),0)+1 FROM organizations))',[id,b.code,b.name,director?.id||null]);
  }
  else
    await q(`INSERT INTO ${m.table}(id,name,sort) VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM ${m.table}))`, [id, b.name]);
  await adminLog(req.me.id, 'admin', `أضاف ${m.label}: ${b.name}`);
  res.status(201).json({ id });
});

router.patch('/meta/:kind/:id', requireAdmin, async (req, res) => {
  const m = META[req.params.kind];
  if (!m) return res.status(400).json({ error: 'نوع غير معروف.' });
  const b = req.body || {};
  const set = [], vals = [];
  ['name', 'code', 'cls', 'color', 'type'].forEach((k) => { if (b[k] !== undefined) { set.push(`${k}=$${vals.length + 1}`); vals.push(b[k]); } });
  if(b.directorEmployeeNo!==undefined&&m.table==='organizations'){const u=b.directorEmployeeNo?await one("SELECT id FROM users WHERE lower(employee_no)=lower($1) AND role='director'",[b.directorEmployeeNo]):null;if(b.directorEmployeeNo&&!u)return res.status(400).json({error:'مدير الإدارة غير موجود.'});set.push(`director_id=$${vals.length+1}`);vals.push(u?.id||null);}
  if(b.headEmployeeNo!==undefined&&m.table==='departments'){const u=b.headEmployeeNo?await one("SELECT id FROM users WHERE lower(employee_no)=lower($1) AND role='manager'",[b.headEmployeeNo]):null;if(b.headEmployeeNo&&!u)return res.status(400).json({error:'رئيس القسم غير موجود.'});set.push(`head_id=$${vals.length+1}`);vals.push(u?.id||null);}
  if (b.organization !== undefined && m.table === 'departments') { set.push(`organization_id=$${vals.length + 1}`); vals.push(b.organization); }
  if (b.open !== undefined && m.table === 'statuses') { set.push(`is_open=$${vals.length + 1}`); vals.push(!!b.open); }
  if (b.req !== undefined && m.table === 'custom_fields') { set.push(`required=$${vals.length + 1}`); vals.push(!!b.req); }
  if (b.cats !== undefined && m.table === 'custom_fields') { set.push(`cats=$${vals.length + 1}`); vals.push(JSON.stringify(b.cats)); }
  if (!set.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await q(`UPDATE ${m.table} SET ${set.join(',')} WHERE id=$${vals.length}`, vals);
  if (m.table === 'departments' && b.organization !== undefined)
    await q('UPDATE users SET organization_id=$1 WHERE dept_id=$2', [b.organization, req.params.id]);
  await adminLog(req.me.id, 'admin', `عدّل ${m.label} ${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/meta/:kind/:id', requireAdmin, async (req, res) => {
  const m = META[req.params.kind];
  if (!m) return res.status(400).json({ error: 'نوع غير معروف.' });
  if (m.taskCol) {
    const r = await one(`SELECT count(*)::int n FROM tasks WHERE ${m.taskCol}=$1`, [req.params.id]);
    if (r.n > 0) return res.status(409).json({ error: `لا يمكن الحذف — مرتبط بـ ${r.n} مهمة قائمة.` });
  }
  if (m.table === 'departments') {
    const r = await one('SELECT count(*)::int n FROM users WHERE dept_id=$1 AND active=true', [req.params.id]);
    if (r.n > 0) return res.status(409).json({ error: `لا يمكن الحذف — بها ${r.n} موظف.` });
  }
  if (m.table === 'organizations') {
    const r = await one('SELECT count(*)::int n FROM departments WHERE organization_id=$1', [req.params.id]);
    const u = await one('SELECT count(*)::int n FROM users WHERE organization_id=$1 AND active=true', [req.params.id]);
    if (req.query.cascade === 'true' && (r.n > 0 || u.n > 0)) {
      const self = await one('SELECT 1 FROM users WHERE id=$1 AND organization_id=$2', [req.me.id, req.params.id]);
      if (self) return res.status(409).json({ error: 'لا يمكنك حذف الإدارة التي يتبع لها حسابك الحالي.' });
      const tasks = await one(`SELECT count(*)::int n FROM tasks t JOIN departments d ON d.id=t.dept_id WHERE d.organization_id=$1`, [req.params.id]);
      if (tasks.n > 0) return res.status(409).json({ error: `لا يمكن حذف الإدارة لأنها مرتبطة بـ ${tasks.n} مهمة محفوظة. انقل المهام إلى إدارة أخرى أولًا.` });
      await tx(async (c) => {
        await c.query('UPDATE users SET active=false,dept_id=NULL,organization_id=NULL WHERE organization_id=$1', [req.params.id]);
        await c.query('DELETE FROM departments WHERE organization_id=$1', [req.params.id]);
        await c.query('DELETE FROM organizations WHERE id=$1', [req.params.id]);
      });
      await adminLog(req.me.id, 'admin', `حذف الإدارة ${req.params.id} مع أقسامها وعطّل مستخدميها`);
      return res.json({ ok:true, cascade:true, disabledUsers:u.n, deletedDepartments:r.n });
    }
    if (r.n > 0) return res.status(409).json({ error: `لا يمكن حذف الإدارة — تتبع لها ${r.n} أقسام. استخدم الحذف الشامل إذا أردت حذف الهيكل كاملًا.` });
    if (u.n > 0) return res.status(409).json({ error: `لا يمكن حذف الإدارة — يتبع لها ${u.n} مستخدمين.` });
  }
  await q(`DELETE FROM ${m.table} WHERE id=$1`, [req.params.id]);
  await adminLog(req.me.id, 'admin', `حذف ${m.label} ${req.params.id}`);
  res.json({ ok: true });
});

/* ============================================================
   أنواع الفعاليات والمناسبات
   ============================================================ */
router.get('/events/types', requireAdmin, async (_req, res) => {
  const rows = await all('SELECT id,name,description,sort,active FROM event_types ORDER BY sort,name');
  res.json({ eventTypes: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, sort: r.sort, active: r.active })) });
});

router.post('/events/types', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم النوع مطلوب.' });
  const description = String(b.description || '').trim();
  const sort = Number.isFinite(Number(b.sort)) ? Number(b.sort) : null;
  const active = b.active !== false;
  const dup = await one('SELECT 1 FROM event_types WHERE lower(name)=lower($1)', [name]);
  if (dup) return res.status(409).json({ error: 'هذا النوع موجود مسبقًا.' });
  const id = 'evt-type-' + Date.now().toString(36);
  await q(
    `INSERT INTO event_types(id,name,description,sort,active)
     VALUES($1,$2,$3,COALESCE($4,(SELECT COALESCE(MAX(sort),0)+1 FROM event_types)),$5)`,
    [id, name, description, sort, active]
  );
  await adminLog(req.me.id, 'admin', `أضاف نوع فعالية: ${name}`);
  res.status(201).json({ id });
});

router.patch('/events/types/:id', requireAdmin, async (req, res) => {
  const row = await one('SELECT * FROM event_types WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'نوع الفعالية غير موجود.' });
  const b = req.body || {};
  const set = [], vals = [];
  const put = (col, val) => { if (val === undefined) return; set.push(`${col}=$${vals.length + 1}`); vals.push(val); };
  if (b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'اسم النوع مطلوب.' });
    const dup = await one('SELECT 1 FROM event_types WHERE lower(name)=lower($1) AND id<>$2', [name, row.id]);
    if (dup) return res.status(409).json({ error: 'هذا النوع موجود مسبقًا.' });
    put('name', name);
  }
  if (b.description !== undefined) put('description', String(b.description || '').trim());
  if (b.sort !== undefined) put('sort', Number.isFinite(Number(b.sort)) ? Number(b.sort) : row.sort);
  if (b.active !== undefined) put('active', !!b.active);
  if (!set.length) return res.json({ ok: true });
  vals.push(row.id);
  await q(`UPDATE event_types SET ${set.join(',')} WHERE id=$${vals.length}`, vals);
  await adminLog(req.me.id, 'admin', `عدّل نوع الفعالية ${row.name}`);
  res.json({ ok: true });
});

router.delete('/events/types/:id', requireAdmin, async (req, res) => {
  const row = await one('SELECT * FROM event_types WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'نوع الفعالية غير موجود.' });
  const used = await one('SELECT count(*)::int n FROM events WHERE type_id=$1', [req.params.id]);
  if (used.n > 0) return res.status(409).json({ error: `لا يمكن حذف النوع — مستخدم في ${used.n} فعالية.` });
  await q('DELETE FROM event_types WHERE id=$1', [req.params.id]);
  await adminLog(req.me.id, 'admin', `حذف نوع الفعالية ${row.name}`);
  res.json({ ok: true });
});

async function eventBackupSnapshot() {
  const [orgs, depts, types, events] = await Promise.all([
    all(`SELECT o.id organization_id,o.code organization_code,o.name organization_name,
                d.id dept_id,d.code dept_code,d.name dept_name
         FROM departments d
         LEFT JOIN organizations o ON o.id = d.organization_id
         ORDER BY o.sort, d.sort, d.name`),
    all('SELECT id,name,description,sort,active FROM event_types ORDER BY sort,name'),
    all(`SELECT e.*, t.name type_name, t.description type_description,
                oo.code organizer_org_code, oo.name organizer_org_name,
                od.code organizer_dept_code, od.name organizer_dept_name
         FROM events e
         LEFT JOIN event_types t ON t.id = e.type_id
         LEFT JOIN departments od ON od.id = e.organizer_dept_id
         LEFT JOIN organizations oo ON oo.id = od.organization_id
         ORDER BY COALESCE(e.start_at, e.created_at) DESC`),
    all('SELECT id,code,name,organization_id FROM departments'),
  ]);
  const deptById = new Map(depts.map((d) => [d.dept_id, d]));
  return { orgs, depts, types, events, deptById };
}

function eventTokensFromRow(v) {
  if (Array.isArray(v)) return v.flatMap((x) => eventTokensFromRow(x));
  return String(v ?? '')
    .split(/[\n,|؛;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function eventActiveValue(v) {
  if (v === false) return false;
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return true;
  return !['غير نشط', 'inactive', 'false', '0', 'no', 'off'].includes(t);
}

function eventResolveDept(ref, ctx) {
  const orgCode = String(ref.organizerOrganizationCode || ref.organizationCode || ref.organization_code || '').trim().toLowerCase();
  const deptCode = String(ref.organizerDepartmentCode || ref.departmentCode || ref.department_code || '').trim().toLowerCase();
  const deptName = String(ref.organizerDepartmentName || ref.departmentName || ref.department_name || '').trim().toLowerCase();
  if (orgCode && deptCode) return ctx.deptByKey.get(`${orgCode}\u0000${deptCode}`) || null;
  if (deptCode && ctx.deptByCode.has(deptCode)) return ctx.deptByCode.get(deptCode);
  if (deptName && ctx.deptByName.has(deptName)) return ctx.deptByName.get(deptName);
  return null;
}

function eventResolveParticipants(ref, ctx, organizerDeptId) {
  const tokens = eventTokensFromRow(ref);
  const ids = [];
  for (const token of tokens) {
    if (!token) continue;
    let dept = null;
    if (token.includes('/')) {
      const [orgCode, deptCode] = token.split('/').map((x) => x.trim().toLowerCase());
      if (orgCode && deptCode) dept = ctx.deptByKey.get(`${orgCode}\u0000${deptCode}`) || null;
    }
    if (!dept && ctx.deptByKey.has(token.toLowerCase())) dept = ctx.deptByKey.get(token.toLowerCase());
    if (!dept && ctx.deptByCode.has(token.toLowerCase())) dept = ctx.deptByCode.get(token.toLowerCase());
    if (!dept && ctx.deptByName.has(token.toLowerCase())) dept = ctx.deptByName.get(token.toLowerCase());
    if (dept && dept.dept_id !== organizerDeptId) ids.push(dept.dept_id);
  }
  return [...new Set(ids)];
}

async function importEventsBackup(req, res, rows, dryRun) {
  const typesRows = rows.filter((x) => x.entity === 'eventType');
  const eventRows = rows.filter((x) => x.entity === 'event');
  const ctx = {};
  const [orgs, depts, existingTypes, existingEvents] = await Promise.all([
    all('SELECT id,code,name FROM organizations'),
    all(`SELECT d.id dept_id,d.code dept_code,d.name dept_name,o.code organization_code,o.name organization_name
         FROM departments d LEFT JOIN organizations o ON o.id=d.organization_id`),
    all('SELECT id,name,description,sort,active FROM event_types'),
    all('SELECT id,title,start_at,organizer_dept_id FROM events'),
  ]);
  ctx.orgByCode = new Map(orgs.map((o) => [String(o.code || '').trim().toLowerCase(), o]));
  ctx.deptByKey = new Map(depts.map((d) => [`${String(d.organization_code || '').trim().toLowerCase()}\u0000${String(d.dept_code || '').trim().toLowerCase()}`, d]));
  ctx.deptByCode = new Map(depts.map((d) => [String(d.dept_code || '').trim().toLowerCase(), d]));
  ctx.deptByName = new Map(depts.map((d) => [String(d.dept_name || '').trim().toLowerCase(), d]));
  ctx.typeByName = new Map(existingTypes.map((t) => [String(t.name || '').trim().toLowerCase(), t]));
  ctx.typeById = new Map(existingTypes.map((t) => [String(t.id || '').trim().toLowerCase(), t]));
  ctx.eventById = new Map(existingEvents.map((e) => [String(e.id || '').trim().toLowerCase(), e]));
  ctx.eventByKey = new Map(existingEvents.map((e) => [`${String(e.organizer_dept_id || '').trim().toLowerCase()}\u0000${String(e.title || '').trim().toLowerCase()}\u0000${e.start_at ? new Date(e.start_at).toISOString() : ''}`, e]));
  const results = [];
  const summary = { ready: 0, created: 0, updated: 0, skipped: 0, error: 0 };

  const normalizedTypeRows = typesRows.map((x, i) => ({ row: i + 1, name: String(x.name || '').trim(), description: String(x.description || '').trim(), sort: x.sort === '' || x.sort == null ? null : Number(x.sort), active: eventActiveValue(x.active), id: String(x.id || '').trim() }));
  const normalizedEventRows = eventRows.map((x, i) => ({ row: i + 1 + typesRows.length, ...x }));

  const typeRowsByName = new Map();
  for (const x of normalizedTypeRows) {
    const key = x.name.toLowerCase();
    if (!x.name) { results.push({ row: x.row, entity: 'eventType', name: '', status: 'error', message: 'اسم النوع مطلوب' }); summary.error++; continue; }
    typeRowsByName.set(key, x);
    const existing = x.id && ctx.typeById.get(x.id.toLowerCase()) || ctx.typeByName.get(key);
    results.push({ row: x.row, entity: 'eventType', name: x.name, status: existing ? 'updated' : 'ready', message: existing ? 'سيُحدَّث' : 'جاهز' });
    summary[existing ? 'updated' : 'ready']++;
  }
  for (const x of normalizedEventRows) {
    const title = String(x.title || '').trim();
    const typeName = String(x.typeName || x.type || '').trim();
    const organizer = eventResolveDept(x, ctx);
    const timing = eventDurationTiming(x);
    const ok = title && typeName && organizer && timing.startAt && timing.endAt && timing.endAt > timing.startAt;
    const key = `${String(organizer?.dept_id || '').trim().toLowerCase()}\u0000${title.toLowerCase()}\u0000${timing.startAt ? timing.startAt.toISOString() : ''}`;
    const existing = (x.id && ctx.eventById.get(String(x.id).trim().toLowerCase())) || ctx.eventByKey.get(key) || null;
    const row = {
      row: x.row,
      entity: 'event',
      id: String(x.id || '').trim(),
      title,
      typeName,
      organizer: organizer ? `${organizer.organization_code || ''}/${organizer.dept_code || ''}`.replace(/^\/|\/$/g, '') : '',
      status: ok ? (existing ? 'updated' : 'ready') : 'error',
      message: ok ? (existing ? 'سيُحدَّث' : 'جاهز') : !title ? 'اسم الفعالية مطلوب' : !typeName ? 'نوع الفعالية مطلوب' : !organizer ? 'الإدارة المنظمة غير موجودة' : 'التاريخ أو المدة غير صحيح',
    };
    if (ok) summary[existing ? 'updated' : 'ready']++;
    else summary.error++;
    results.push(row);
  }

  if (dryRun) {
    return res.json({
      dryRun: true,
      summary,
      results,
      eventTypes: normalizedTypeRows.length,
      events: normalizedEventRows.length,
    });
  }

  await tx(async (c) => {
    const typeIdByName = new Map(ctx.typeByName);
    for (const x of normalizedTypeRows) {
      if (!x.name) continue;
      const key = x.name.toLowerCase();
      let type = x.id ? await one('SELECT * FROM event_types WHERE id=$1', [x.id]) : null;
      if (!type) type = ctx.typeByName.get(key) || null;
      if (type) {
        await c.query('UPDATE event_types SET name=$1, description=$2, sort=$3, active=$4 WHERE id=$5', [x.name, x.description, x.sort ?? type.sort, x.active, type.id]);
        typeIdByName.set(key, { ...type, name: x.name, description: x.description, sort: x.sort ?? type.sort, active: x.active });
      } else {
        const id = x.id || `evt-type-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        await c.query('INSERT INTO event_types(id,name,description,sort,active) VALUES($1,$2,$3,$4,$5)', [id, x.name, x.description, x.sort ?? null, x.active]);
        typeIdByName.set(key, { id, name: x.name });
      }
    }

    const refreshedTypes = await c.query('SELECT id,name,description,sort,active FROM event_types');
    const typeByName = new Map(refreshedTypes.rows.map((t) => [String(t.name || '').trim().toLowerCase(), t]));
    const typeById = new Map(refreshedTypes.rows.map((t) => [String(t.id || '').trim().toLowerCase(), t]));
    const deptByKey = ctx.deptByKey;
    const deptByCode = ctx.deptByCode;
    const deptByName = ctx.deptByName;

    for (const x of normalizedEventRows) {
      const title = String(x.title || '').trim();
      const typeName = String(x.typeName || x.type || '').trim().toLowerCase();
      const type = (x.typeId && typeById.get(String(x.typeId).trim().toLowerCase())) || typeByName.get(typeName);
      const organizer = eventResolveDept(x, { deptByKey, deptByCode, deptByName });
      const timing = eventDurationTiming(x);
      if (!title || !type || !organizer || !timing.startAt || !timing.endAt || timing.endAt <= timing.startAt) continue;
      const participants = eventResolveParticipants(x.participants, { deptByKey, deptByCode, deptByName }, organizer.dept_id);
      const cancelledAt = String(x.cancelledAt || '').trim() || null;
      const key = `${String(organizer.dept_id || '').trim().toLowerCase()}\u0000${title.toLowerCase()}\u0000${timing.startAt.toISOString()}`;
      let existing = x.id ? ctx.eventById.get(String(x.id).trim().toLowerCase()) || null : null;
      if (!existing) existing = ctx.eventByKey.get(key) || null;
      if (existing) {
        await c.query(
          `UPDATE events SET title=$1,type_id=$2,summary=$3,organizer_dept_id=$4,start_at=$5,end_at=$6,duration_value=$7,duration_unit=$8,country=$9,city=$10,location=$11,participants=$12,notes=$13,cancelled_at=$14
           WHERE id=$15`,
          [title, type.id, String(x.summary || ''), organizer.dept_id, timing.startAt, timing.endAt, timing.duration, timing.unit, String(x.country || ''), String(x.city || ''), String(x.location || ''), JSON.stringify(participants), String(x.notes || ''), cancelledAt ? new Date(cancelledAt) : null, existing.id]
        );
        summary.updated++;
      } else {
        const id = x.id || `ev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        await c.query(
          `INSERT INTO events(id,title,type_id,summary,organizer_dept_id,created_by,start_at,end_at,duration_value,duration_unit,country,city,location,participants,notes,cancelled_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, title, type.id, String(x.summary || ''), organizer.dept_id, req.me.id, timing.startAt, timing.endAt, timing.duration, timing.unit, String(x.country || ''), String(x.city || ''), String(x.location || ''), JSON.stringify(participants), String(x.notes || ''), cancelledAt ? new Date(cancelledAt) : null]
        );
        summary.created++;
      }
    }
  });

  await adminLog(req.me.id, 'admin', `استورد فعاليات: ${summary.created} عنصرًا`);
  res.json({ dryRun: false, summary, results, eventTypes: normalizedTypeRows.length, events: normalizedEventRows.length });
}

router.get('/events/export.xlsx', requireAdmin, async (_req, res) => {
  const snapshot = await eventBackupSnapshot();
  const partText = (ids) => ids.map((id) => {
    const d = snapshot.deptById.get(id);
    return d ? `${d.organization_code || ''}/${d.dept_code || ''}`.replace(/^\/|\/$/g, '') : '';
  }).filter(Boolean).join(' | ');
  const sheets = [
    {
      name: 'دليل الاستخدام',
      rows: [
        ['نسخة احتياطية للفعاليات والمناسبات', ''],
        ['تاريخ التصدير', new Date().toISOString()],
        ['ملاحظة', 'يحتوي الملف على الأنواع والفعاليات مع الإدارات المشاركة.'],
      ],
    },
    {
      name: 'أنواع الفعاليات',
      rows: [
        ['اسم النوع*', 'الوصف', 'الترتيب', 'الحالة'],
        ...snapshot.types.map((t) => [t.name, t.description || '', t.sort ?? '', t.active === false ? 'غير نشط' : 'نشط']),
      ],
    },
    {
      name: 'الفعاليات',
      rows: [
        ['اسم الفعالية*', 'نوع الفعالية*', 'وصف مختصر', 'رمز الإدارة المنظمة*', 'رمز القسم المنظم*', 'الإدارات المشاركة', 'تاريخ البداية*', 'تاريخ النهاية*', 'المدة', 'وحدة المدة', 'الدولة', 'المدينة', 'الموقع', 'الملاحظات', 'تاريخ الإلغاء'],
        ...snapshot.events.map((e) => [e.title, e.type_name || '', e.summary || '', e.organizer_org_code || '', e.organizer_dept_code || '', partText(Array.isArray(e.participants) ? e.participants : []), e.start_at ? new Date(e.start_at).toISOString() : '', e.end_at ? new Date(e.end_at).toISOString() : '', e.duration_value ?? '', e.duration_unit || 'day', e.country || '', e.city || '', e.location || '', e.notes || '', e.cancelled_at ? new Date(e.cancelled_at).toISOString() : '']),
      ],
    },
  ];
  const file = buildXlsx(sheets);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`نسخة-الفعاليات-${new Date().toISOString().slice(0, 10)}.xlsx`)}`);
  res.send(file);
});

router.get('/events/export.json', requireAdmin, async (_req, res) => {
  const snapshot = await eventBackupSnapshot();
  const backup = {
    format: 'wamy-events-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    eventTypes: snapshot.types.map((t) => ({ id: t.id, name: t.name, description: t.description || '', sort: t.sort ?? null, active: t.active !== false })),
    events: snapshot.events.map((e) => ({
      id: e.id,
      title: e.title,
      typeId: e.type_id,
      typeName: e.type_name || '',
      summary: e.summary || '',
      organizerOrganizationCode: e.organizer_org_code || '',
      organizerDepartmentCode: e.organizer_dept_code || '',
      participants: (Array.isArray(e.participants) ? e.participants : []).map((id) => {
        const d = snapshot.deptById.get(id);
        return d ? `${d.organization_code || ''}/${d.dept_code || ''}`.replace(/^\/|\/$/g, '') : '';
      }).filter(Boolean),
      startAt: e.start_at ? new Date(e.start_at).toISOString() : '',
      endAt: e.end_at ? new Date(e.end_at).toISOString() : '',
      durationValue: e.duration_value == null ? '' : Number(e.duration_value),
      durationUnit: e.duration_unit || 'day',
      country: e.country || '',
      city: e.city || '',
      location: e.location || '',
      notes: e.notes || '',
      cancelledAt: e.cancelled_at ? new Date(e.cancelled_at).toISOString() : '',
    })),
  };
  const name = `نسخة-الفعاليات-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  await adminLog(req.me.id, 'admin', 'صدّر نسخة احتياطية من الفعاليات بصيغة JSON');
  res.send(JSON.stringify(backup, null, 2));
});

router.get('/events/template.xlsx', requireAdmin, async (_req, res) => {
  const sheets = [
    {
      name: 'أنواع الفعاليات',
      rows: [
        ['اسم النوع*', 'الوصف', 'الترتيب', 'الحالة'],
        ['ملتقى', 'يجمع المشاركين في لقاء أو تجمع معرفي', '1', 'نشط'],
        ['دورة تدريبية', 'برنامج تدريبي قصير أو متوسط', '2', 'نشط'],
        ['ورشة عمل', 'نشاط تطبيقي تفاعلي', '3', 'نشط'],
      ],
    },
    {
      name: 'الفعاليات',
      rows: [
        ['اسم الفعالية*', 'نوع الفعالية*', 'وصف مختصر', 'رمز الإدارة المنظمة*', 'رمز القسم المنظم*', 'الإدارات المشاركة', 'تاريخ البداية*', 'تاريخ النهاية*', 'المدة', 'وحدة المدة', 'الدولة', 'المدينة', 'الموقع', 'الملاحظات', 'تاريخ الإلغاء'],
        ['ملتقى القيادات الشبابية', 'ملتقى', 'ملتقى تنسيقي يهدف إلى جمع مديري الإدارات', 'D002', 'IT', 'D001 | D011', '2026-09-15T09:00:00+03:00', '2026-09-16T17:00:00+03:00', '2', 'day', 'السعودية', 'الرياض', 'مقر الندوة', '', ''],
      ],
    },
  ];
  const file = buildXlsx(sheets);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('قالب-الفعاليات.xlsx')}`);
  res.send(file);
});

router.get('/events/template.json', requireAdmin, async (_req, res) => {
  const backup = {
    format: 'wamy-events-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    eventTypes: [
      { id: 'evt-type-sample-1', name: 'ملتقى', description: 'يجمع المشاركين في لقاء أو تجمع معرفي', sort: 1, active: true },
      { id: 'evt-type-sample-2', name: 'دورة تدريبية', description: 'برنامج تدريبي قصير أو متوسط', sort: 2, active: true },
      { id: 'evt-type-sample-3', name: 'ورشة عمل', description: 'نشاط تطبيقي تفاعلي', sort: 3, active: true },
    ],
    events: [
      {
        id: 'ev-sample-1',
        title: 'ملتقى القيادات الشبابية',
        typeName: 'ملتقى',
        summary: 'ملتقى تنسيقي يهدف إلى جمع مديري الإدارات',
        organizerOrganizationCode: 'D002',
        organizerDepartmentCode: 'IT',
        participants: ['D001/PR', 'D011/CR'],
        startAt: '2026-09-15T09:00:00+03:00',
        endAt: '2026-09-16T17:00:00+03:00',
        durationValue: 2,
        durationUnit: 'day',
        country: 'السعودية',
        city: 'الرياض',
        location: 'مقر الندوة',
        notes: '',
        cancelledAt: '',
      },
    ],
  };
  const name = `قالب-الفعاليات-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(JSON.stringify(backup, null, 2));
});

router.post('/events/parse', requireAdmin, planUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'اختر ملف Excel.' });
  try {
    const rows = eventsTemplateRows(req.file.buffer);
    res.json({ rows, count: rows.length });
  } catch (e) {
    res.status(422).json({ error: 'تعذرت قراءة ملف Excel: ' + e.message });
  }
});

router.post('/events/parse-json', requireAdmin, async (req, res) => {
  try {
    const rows = eventsBackupRows(req.body?.backup);
    res.json({ rows, count: rows.length });
  } catch (e) {
    res.status(422).json({ error: 'تعذرت قراءة نسخة JSON: ' + e.message });
  }
});

router.post('/events/import', requireAdmin, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 1000) : [];
  const dryRun = req.body?.dryRun !== false;
  if (!rows.length) return res.status(400).json({ error: 'لا توجد صفوف للاستيراد.' });
  if (!rows.some((x) => x.entity === 'event' || x.entity === 'eventType')) return res.status(400).json({ error: 'صيغة استيراد غير معروفة.' });
  return importEventsBackup(req, res, rows, dryRun);
});

/* ============================================================
   الإعدادات والهوية
   ============================================================ */
router.put('/settings/cfg', requireAdmin, async (req, res) => {
  const cur = await getSetting('cfg');
  const next = { ...cur, ...(req.body || {}) };
  if (!Array.isArray(next.domains) || !next.domains.length)
    return res.status(400).json({ error: 'يجب تحديد نطاق بريد معتمد واحد على الأقل.' });
  next.domains = next.domains.map((d) => String(d).trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  const w = next.weights || {};
  const sum = (w.timeliness || 0) + (w.quality || 0) + (w.speed || 0);
  if (Math.abs(sum - 1) > 0.01) return res.status(400).json({ error: `مجموع أوزان التقييم يجب أن يساوي 1 (الحالي ${sum.toFixed(2)}).` });
  await setSetting('cfg', next);
  await adminLog(req.me.id, 'admin', 'حدّث إعدادات النظام');
  res.json({ cfg: next });
});

router.put('/settings/brand', requireAdmin, async (req, res) => {
  const cur = await getSetting('brand');
  const b = req.body || {};
  for (const k of ['primary', 'accent', 'loginBg'])
    if (b[k] && !/^#[0-9a-fA-F]{3,8}$/.test(b[k])) return res.status(400).json({ error: `كود لون غير صالح: ${k}` });
  for (const k of ['logo', 'logoDark', 'mark', 'markDark'])
    if (b[k] && String(b[k]).length > 700 * 1024) return res.status(413).json({ error: 'حجم الشعار كبير — استخدم SVG أو PNG أصغر.' });
  const next = { ...cur, ...b };
  await setSetting('brand', next);
  await adminLog(req.me.id, 'admin', 'حدّث الهوية البصرية');
  res.json({ brand: next });
});

router.post('/settings/reset-structure', requireAdmin, async (req,res) => {
  const b=req.body||{};
  if(b.confirmation!=='إعادة تهيئة التطبيق') return res.status(400).json({error:'اكتب عبارة التأكيد كما هي: إعادة تهيئة التطبيق'});
  const me=await one('SELECT password_hash FROM users WHERE id=$1',[req.me.id]);
  if(!me||!(await verify(String(b.password||''),me.password_hash))) return res.status(401).json({error:'كلمة مرور مسؤول النظام غير صحيحة.'});
  const counts=await tx(async c=>{
    const before=(await c.query(`SELECT (SELECT count(*) FROM tasks)::int tasks,(SELECT count(*) FROM departments)::int departments,(SELECT count(*) FROM organizations)::int organizations,(SELECT count(*) FROM users WHERE id<>$1)::int users`,[req.me.id])).rows[0];
    await c.query('DELETE FROM tasks');
    await c.query('DELETE FROM notifications');
    await c.query('DELETE FROM saved_filters');
    await c.query('DELETE FROM login_attempts');
    await c.query('DELETE FROM activity');
    await c.query('DELETE FROM structure_people');
    await c.query('DELETE FROM users WHERE id<>$1',[req.me.id]);
    await c.query('UPDATE users SET employee_no=NULL,dept_id=NULL,organization_id=NULL,manager_id=NULL WHERE id=$1',[req.me.id]);
    await c.query('DELETE FROM departments');
    await c.query('DELETE FROM organizations');
    return before;
  });
  counts.uploadedFiles=await purgeUploadedFiles();
  await adminLog(req.me.id,'security','أعاد تهيئة التطبيق وحذف جميع البيانات التشغيلية والهيكل والمستخدمين عدا حسابه الحالي');
  res.json({ok:true,counts});
});

const RESET_SECTIONS = new Set(['tasks','notifications','activity','accounts','structure','saved_filters','login_attempts','cfg','brand','events']);
router.post('/settings/reset-sections', requireAdmin, async (req,res)=>{
  const b=req.body||{}, sections=[...new Set(Array.isArray(b.sections)?b.sections:[])];
  if(!sections.length||sections.some(x=>!RESET_SECTIONS.has(x)))return res.status(400).json({error:'حدد قسمًا واحدًا صالحًا على الأقل.'});
  if(b.confirmation!=='إعادة تهيئة الأقسام المحددة')return res.status(400).json({error:'اكتب عبارة التأكيد كما هي: إعادة تهيئة الأقسام المحددة'});
  const me=await one('SELECT password_hash FROM users WHERE id=$1',[req.me.id]);
  if(!me||!(await verify(String(b.password||''),me.password_hash)))return res.status(401).json({error:'كلمة مرور مسؤول النظام غير صحيحة.'});
  const selected=new Set(sections), affected=new Set(sections);
  if(selected.has('structure'))['tasks','notifications','accounts','saved_filters','activity','login_attempts'].forEach(x=>affected.add(x));
  if(selected.has('accounts'))['notifications','saved_filters'].forEach(x=>affected.add(x));
  if(selected.has('tasks'))affected.add('notifications');
  const counts=await tx(async c=>{
    const count=async(table,where='TRUE')=>Number((await c.query(`SELECT count(*) n FROM ${table} WHERE ${where}`)).rows[0].n);
    const before={};
    for(const [key,table,where] of [['tasks','tasks'],['notifications','notifications'],['activity','activity'],['structurePeople','structure_people'],['departments','departments'],['organizations','organizations'],['savedFilters','saved_filters'],['loginAttempts','login_attempts'],['events','events'],['eventTypes','event_types']]) before[key]=await count(table,where);
    before.accounts=Number((await c.query('SELECT count(*) n FROM users WHERE id<>$1',[req.me.id])).rows[0].n);
    if(affected.has('tasks'))await c.query('DELETE FROM tasks');
    else if(affected.has('notifications'))await c.query('DELETE FROM notifications');
    if(affected.has('activity'))await c.query('DELETE FROM activity');
    if(affected.has('saved_filters'))await c.query('DELETE FROM saved_filters');
    if(affected.has('login_attempts'))await c.query('DELETE FROM login_attempts');
    if(affected.has('events'))await c.query('DELETE FROM events');
    if(affected.has('structure')){
      await c.query('DELETE FROM structure_people');
      await c.query('DELETE FROM users WHERE id<>$1',[req.me.id]);
      await c.query('UPDATE users SET employee_no=NULL,dept_id=NULL,organization_id=NULL,manager_id=NULL WHERE id=$1',[req.me.id]);
      await c.query('DELETE FROM departments');await c.query('DELETE FROM organizations');
    }else if(affected.has('accounts')) await c.query('DELETE FROM users WHERE id<>$1',[req.me.id]);
    if(affected.has('cfg'))await c.query(`INSERT INTO settings(key,value) VALUES('cfg',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[SETTING_DEFAULTS.cfg]);
    if(affected.has('brand'))await c.query(`INSERT INTO settings(key,value) VALUES('brand',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[SETTING_DEFAULTS.brand]);
    return before;
  });
  if(affected.has('tasks'))counts.uploadedFiles=await purgeUploadedFiles();
  await adminLog(req.me.id,'security',`أعاد تهيئة أقسام النظام: ${[...affected].join(', ')}`);
  res.json({ok:true,selected:sections,affected:[...affected],counts});
});

/* ============================================================
   الأمان والصيانة
   ============================================================ */

/* ---------- إخفاء مجموعات من قوائم المستخدمين والمهام ----------
   «مكاتب الندوة الدولية» هي الأقسام المسماة «… / مكتب …»؛ يُستخدم النمط
   لتحديدها مرة واحدة عند التبديل، ثم يصبح العمود departments.hidden
   هو المرجع، فلا يتأثر الإخفاء لاحقًا بأي تعديل على الأسماء. */
const INTL_OFFICE_PATTERN = '%/ مكتب%';

async function hiddenGroupsSummary() {
  const row = await one(
    `SELECT count(*)::int sections,
            count(*) FILTER (WHERE hidden)::int hidden_sections,
            (SELECT count(*)::int FROM users u JOIN departments d2 ON d2.id=u.dept_id
              WHERE d2.name LIKE $1 AND u.active=true) staff
       FROM departments WHERE name LIKE $1`, [INTL_OFFICE_PATTERN]);
  const totalHidden = await one(
    `SELECT count(*)::int sections,
            (SELECT count(*)::int FROM users u JOIN departments d2 ON d2.id=u.dept_id
              WHERE d2.hidden AND u.active=true) staff
       FROM departments WHERE hidden`);
  return {
    intlOffices: {
      sections: row?.sections || 0,
      staff: row?.staff || 0,
      hidden: (row?.hidden_sections || 0) > 0 && row.hidden_sections === row.sections,
      partiallyHidden: (row?.hidden_sections || 0) > 0 && row.hidden_sections !== row.sections,
    },
    totalHidden: { sections: totalHidden?.sections || 0, staff: totalHidden?.staff || 0 },
  };
}

router.get('/hidden-groups', requireAdmin, async (_req, res) => {
  res.json(await hiddenGroupsSummary());
});

router.post('/hidden-groups', requireAdmin, async (req, res) => {
  const hide = req.body?.intlOffices === true;
  const r = await q('UPDATE departments SET hidden=$1 WHERE name LIKE $2', [hide, INTL_OFFICE_PATTERN]);
  await q('INSERT INTO activity(task_id,user_id,type,text) VALUES(NULL,$1,$2,$3)', [
    req.me.id, 'admin',
    hide ? 'أخفى منسوبي مكاتب الندوة الدولية من قوائم المستخدمين والمهام'
         : 'أعاد إظهار منسوبي مكاتب الندوة الدولية في قوائم المستخدمين والمهام',
  ]);
  res.json({ ok: true, changed: r.rowCount, ...(await hiddenGroupsSummary()) });
});
router.get('/logins', requireAdmin, async (_req, res) => {
  const rows = await all('SELECT email,ok,reason,ip,created_at FROM login_attempts ORDER BY created_at DESC LIMIT 100');
  res.json({ logins: rows.map((r) => ({ email: r.email, ok: r.ok, reason: r.reason, ip: r.ip, at: r.created_at })) });
});

router.get('/mail/test', requireAdmin, async (_req, res) => res.json(await verifyTransport()));

/** نسخة احتياطية فورية عبر pg_dump — تُنزَّل مباشرة */
router.get('/backup', requireAdmin, async (req, res) => {
  const url = process.env.DATABASE_URL;
  if (!url) return res.status(500).json({ error: 'DATABASE_URL غير مضبوط.' });
  const name = `wamy-tasks-backup-${new Date().toISOString().slice(0, 10)}.sql`;
  res.setHeader('Content-Type', 'application/sql; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  const p = spawn('pg_dump', ['--no-owner', '--no-privileges', url], { env: process.env });
  p.stdout.pipe(res);
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => {
    if (code !== 0) { console.error('[backup] pg_dump فشل:', err); if (!res.headersSent) res.status(500).end(); else res.end(); }
    else adminLog(req.me.id, 'admin', 'أنشأ نسخة احتياطية يدوية').catch(() => {});
  });
});

router.get('/stats', requireAdmin, async (_req, res) => {
  const [t, u, a, n] = await Promise.all([
    one('SELECT count(*)::int n FROM tasks'), one('SELECT count(*)::int n FROM users WHERE active=true'),
    one('SELECT count(*)::int n, COALESCE(SUM(size),0)::bigint s FROM attachments'),
    one('SELECT count(*)::int n FROM activity'),
  ]);
  res.json({ tasks: t.n, users: u.n, attachments: a.n, attachmentsBytes: Number(a.s), activity: n.n, mail: await verifyTransport() });
});

module.exports = router;
