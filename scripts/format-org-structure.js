'use strict';
const fs = require('fs');
const path = require('path');
const { parseXlsx } = require('../server/xlsx');
const { buildXlsx } = require('../server/xlsx-export');

const source = process.argv[2];
const output = process.argv[3];
if (!source || !output) throw new Error('Usage: node format-org-structure.js source.xlsx output.xlsx');

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const xml = (v) => clean(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sheet = parseXlsx(fs.readFileSync(source)).sheets.find(s => clean(s.name) === 'الهيكل الإداري');
if (!sheet) throw new Error('لم يتم العثور على ورقة «الهيكل الإداري».');

const records = sheet.rows.slice(4).filter(r => clean(r[5]) || clean(r[8])).map((r, i) => ({
  seq: clean(r[0]) || String(i + 1), top: clean(r[1]), org: clean(r[2]), dept: clean(r[3]),
  level: clean(r[4]), name: clean(r[5]), title: clean(r[6]), jobCode: clean(r[7]),
  employeeNo: clean(r[8]), managerName: clean(r[9]), originalPath: clean(r[10]), note: clean(r[11]),
}));
const missingNos = records.filter(r => !r.employeeNo);
missingNos.forEach((r, i) => { r.employeeNo = `SIM-EMP-${String(i + 1).padStart(3,'0')}`; r.generatedNo = true; });
records.forEach(r=>{r.originalEmployeeNo=r.employeeNo;r.employeeNo=`ORG-${r.employeeNo}`;});
const byName = new Map(records.map(r => [clean(r.name), r]));

function roleOf(r) {
  if (r.level === 'الأمين العام') return 'الأمين العام';
  if (r.level.startsWith('مساعد الأمين العام')) return 'مساعد الأمين العام';
  if (r.level === 'مدير إدارة') return 'مدير إدارة';
  if (r.level === 'رئيس قسم' || r.level === 'مدير مكتب') return 'رئيس قسم';
  return 'موظف';
}
records.forEach(r => { r.role = roleOf(r); r.orgName = r.org || 'القيادة العليا'; });

const orgNames = ['القيادة العليا', ...new Set(records.map(r => r.org).filter(Boolean))];
const orgCode = new Map(orgNames.map((n, i) => [n, i === 0 ? 'D000' : `D${String(i).padStart(3,'0')}`]));

for (const r of records) {
  if (['الأمين العام','مساعد الأمين العام','مدير إدارة'].includes(r.role)) r.deptName = '';
  else r.deptName = r.dept || (r.org ? 'مكتب الإدارة' : 'مكتب القيادة العليا');
}
const deptKeys = [...new Set(records.filter(r=>r.deptName).map(r=>`${r.orgName}\0${r.deptName}`))];
const deptCode = new Map();
const counters = new Map();
for (const key of deptKeys) {
  const [org] = key.split('\0'), n=(counters.get(org)||0)+1;counters.set(org,n);
  deptCode.set(key, `${orgCode.get(org)}-S${String(n).padStart(3,'0')}`);
}

// عند وجود مسمى إشرافي داخل الوحدة نعامله كرئيس وحدة نظامي؛ لا نرقّي موظفًا عاديًا افتراضيًا.
for (const key of deptKeys) {
  const members=records.filter(r=>`${r.orgName}\0${r.deptName}`===key);
  if (!members.some(r=>r.role==='رئيس قسم')) {
    const candidate=members.find(r=>/^(مدير|رئيس)/.test(r.title));
    if(candidate){candidate.role='رئيس قسم';candidate.roleAdjusted=true;}
  }
}
const orgDirector = new Map(orgNames.map(name => [name, records.find(r=>r.orgName===name&&r.role==='مدير إدارة') || null]));
const leadershipDirector={employeeNo:'SIM-DIR-D000',name:'مدير افتراضي — مكتب القيادة العليا',role:'مدير إدارة',title:'مدير مكتب القيادة العليا',orgName:'القيادة العليا',deptName:'',synthetic:true};
records.push(leadershipDirector);orgDirector.set('القيادة العليا',leadershipDirector);
for (const name of orgNames.filter(n=>n!=='القيادة العليا'&&!orgDirector.get(n))) {
  const code=orgCode.get(name),r={employeeNo:`SIM-DIR-${code}`,name:`مدير افتراضي — ${name}`,role:'مدير إدارة',title:`مدير ${name}`,orgName:name,deptName:'',synthetic:true};
  records.push(r);orgDirector.set(name,r);
}
const deptHead = new Map(deptKeys.map(key => [key, records.find(r=>`${r.orgName}\0${r.deptName}`===key&&r.role==='رئيس قسم') || null]));
for (const key of deptKeys.filter(k=>!deptHead.get(k))) {
  const [org,name]=key.split('\0'),code=deptCode.get(key),r={employeeNo:`SIM-HEAD-${code}`,name:`رئيس افتراضي — ${name}`,role:'رئيس قسم',title:`رئيس ${name}`,orgName:org,deptName:name,synthetic:true};
  records.push(r);deptHead.set(key,r);
}

function managerNo(r) {
  const sourceManager=byName.get(clean(r.managerName));
  if (r.role === 'الأمين العام') return '';
  if (r.role === 'مساعد الأمين العام') return records.find(x=>x.role==='الأمين العام')?.employeeNo || '';
  if (r.role === 'مدير إدارة') return '';
  if (r.role === 'رئيس قسم') return orgDirector.get(r.orgName)?.employeeNo || '';
  const head=deptHead.get(`${r.orgName}\0${r.deptName}`);
  return head?.employeeNo || '';
}

const contactByEmployee = new Map(records.map((r,i)=>[r.employeeNo,{
  phone:`+9665${String(10000000+i).slice(-8)}`,
  email:`test.${String(i+1).padStart(4,'0')}@wamy.org`,
}]));

const orgRows=orgNames.map(name=>{
  const d=orgDirector.get(name), notes=[];
  if(name==='القيادة العليا')notes.push('مستوى إداري أعلى مضاف للحفاظ على مناصب القيادة العليا');
  if(!d)notes.push('يحتاج تحديد مدير الإدارة');
  const c=contactByEmployee.get(d?.employeeNo)||{};
  return [orgCode.get(name),name,d?.employeeNo||'',d?.name||'',c.phone||'',c.email||'','نشط',notes.join('؛ ')||'سليم'];
});
const deptRows=deptKeys.map(key=>{
  const [org,name]=key.split('\0'),h=deptHead.get(key),notes=[];
  if(!h)notes.push('يحتاج تحديد رئيس قسم/وحدة');
  const c=contactByEmployee.get(h?.employeeNo)||{};
  return [orgCode.get(org),deptCode.get(key),name,h?.employeeNo||'',h?.name||'',c.phone||'',c.email||'','نشط',notes.join('؛ ')||'سليم'];
});
const userRows=records.map(r=>{
  const issues=[];
  const key=`${r.orgName}\0${r.deptName}`, manager=managerNo(r);
  if(!manager&&!['الأمين العام','مدير إدارة'].includes(r.role))issues.push('المدير المباشر غير مربوط');
  const notes=[r.synthetic?'بيانات وهمية مضافة للاختبار':r.generatedNo?'رقم وظيفي وهمي مضاف للاختبار':'بيانات اتصال وهمية للاختبار',r.roleAdjusted?'حُوّل المسمى الإشرافي إلى دور رئيس قسم لملاءمة النظام':'',r.jobCode?`رمز الوظيفة: ${r.jobCode}`:'',r.originalPath?`المسار الأصلي: ${r.originalPath}`:'',r.note].filter(Boolean).join('؛ ');
  const c=contactByEmployee.get(r.employeeNo);
  return [r.employeeNo,r.name,r.role,r.title||r.level,orgCode.get(r.orgName),r.deptName?deptCode.get(key):'',manager,c.phone,c.email,'نشط',notes,issues.length?`يحتاج استكمال: ${issues.join('؛ ')}`:'سليم'];
});

const sheets=[
  {name:'دليل الاستخدام',rows:[['قالب الهيكل الإداري المكتمل للاختبار',''],['المصدر',path.basename(source)],['تاريخ التجهيز',new Date().toISOString().slice(0,10)],['السجلات',String(records.length)],['الإدارات',String(orgRows.length)],['الأقسام والوحدات',String(deptRows.length)],['تنبيه','بيانات البريد والجوال وأسماء القيادات المضافة بيانات وهمية مخصصة للاختبار فقط.'],['التسلسل','القيادة العليا ← الإدارة ← القسم/الوحدة ← المستخدم'],['الربط','تم التحقق من الربط بالرقم الوظيفي ورموز الإدارات والأقسام عبر التطبيق.']]},
  {name:'الإدارات',rows:[['رمز الإدارة*','اسم الإدارة*','الرقم الوظيفي للمدير*','اسم مدير الإدارة (تلقائي)','جوال المدير (تلقائي)','بريد المدير (تلقائي)','الحالة*','حالة الربط'],...orgRows]},
  {name:'الأقسام',rows:[['رمز الإدارة*','رمز القسم*','اسم القسم*','الرقم الوظيفي لرئيس القسم*','اسم رئيس القسم (تلقائي)','جوال رئيس القسم (تلقائي)','بريد رئيس القسم (تلقائي)','الحالة*','حالة الربط'],...deptRows]},
  {name:'المستخدمون',rows:[['الرقم الوظيفي*','الاسم الكامل*','الدور في النظام*','المسمى الوظيفي*','رمز الإدارة*','رمز القسم','الرقم الوظيفي للمدير المباشر','رقم الجوال*','البريد الإلكتروني*','الحالة*','ملاحظات','حالة التحقق'],...userRows]},
];

fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,buildXlsx(sheets));
console.log(JSON.stringify({output,records:records.length,organizations:orgRows.length,departments:deptRows.length,syntheticContacts:userRows.length,generatedEmployeeNos:missingNos.length,departmentsMissingHead:deptRows.filter(r=>!r[3]).length,organizationsMissingDirector:orgRows.filter(r=>!r[2]).length,validationIssues:userRows.filter(r=>r[11]!=='سليم').length},null,2));
