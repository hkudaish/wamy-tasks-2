'use strict';
const fs=require('fs'),path=require('path');
const {parseXlsx}=require('../server/xlsx');
const {buildXlsx}=require('../server/xlsx-export');
const [source,output]=process.argv.slice(2);if(!source||!output)throw new Error('Usage: node reformat-users-structure.js source.xlsx output.xlsx');
const clean=v=>String(v??'').replace(/\s+/g,' ').trim(), esc=v=>clean(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const book=parseXlsx(fs.readFileSync(source)),sheet=book.sheets.find(s=>clean(s.name)==='المستخدمون')||book.sheets[0];
if(!sheet)throw new Error('لا توجد ورقة مستخدمين في الملف.');
const headers=sheet.rows[0].map(x=>clean(x).replace(/\*$/,'')),at=(names)=>headers.findIndex(h=>names.includes(h));
const ix={no:at(['الرقم الوظيفي']),name:at(['الاسم الكامل']),role:at(['الدور في النظام']),title:at(['المسمى الوظيفي']),org:at(['رمز الإدارة']),dept:at(['رمز القسم']),manager:at(['الرقم الوظيفي للمدير المباشر']),phone:at(['رقم الجوال']),email:at(['البريد الإلكتروني']),deptName:at(['القسم / الوحدة','اسم القسم'])};
if(ix.no<0||ix.name<0||ix.role<0)throw new Error('ترويسات الرقم الوظيفي والاسم والدور مطلوبة.');
const rows=sheet.rows.slice(1).filter(r=>clean(r[ix.no])||clean(r[ix.name])).map(r=>({employeeNo:clean(r[ix.no]),name:clean(r[ix.name]),sourceRole:clean(r[ix.role]),title:clean(r[ix.title]),org:clean(r[ix.org]),dept:clean(r[ix.dept]),sourceManager:clean(r[ix.manager]),phone:clean(r[ix.phone]),email:clean(r[ix.email]).toLowerCase(),deptName:clean(r[ix.deptName])}));
const roleOf=r=>/مساعد\s*الأمين/.test(r.sourceRole)?'مساعد الأمين العام':/الأمين\s*العام/.test(r.sourceRole)?'الأمين العام':/مدير\s*إدارة/.test(r.sourceRole)?'مدير إدارة':/رئيس\s*قسم/.test(r.sourceRole)?'رئيس قسم':'موظف';
for(const r of rows){r.role=roleOf(r);r.global=['الأمين العام','مساعد الأمين العام'].includes(r.role)||/مستشار/.test(`${r.sourceRole} ${r.title}`);if(r.global){r.org='';r.dept='';}else if(r.role==='مدير إدارة')r.dept='';else if(!r.dept||r.dept==='0')r.dept=`${r.org}-S000`;}
const usedNos=new Set(rows.map(r=>r.employeeNo)),usedEmails=new Set();let serial=0;
const nextNo=prefix=>{let n;do n=`SIM-${prefix}-${String(++serial).padStart(3,'0')}`;while(usedNos.has(n));usedNos.add(n);return n;};
const validEmail=e=>/^[^@\s]+@wamy\.org$/i.test(e)&&!usedEmails.has(e);const emailFor=r=>{let e=r.email;if(!validEmail(e))e=`structure.${String(++serial).padStart(4,'0')}@wamy.org`;usedEmails.add(e);return e;};
const phoneFor=(r,i)=>{const digits=clean(r.phone).replace(/\D/g,'');if(/^05\d{8}$/.test(digits))return '+966'+digits.slice(1);if(/^9665\d{8}$/.test(digits))return '+'+digits;return `+9665${String(10000000+i).slice(-8)}`;};
const orgCodes=[...new Set(rows.filter(r=>!r.global&&r.org).map(r=>r.org))].sort();
const orgNames={D001:'إدارة تنمية الموارد',D002:'إدارة الإعلام وتقنية المعلومات',D003:'إدارة التخطيط والتطوير',D004:'إدارة البرامج والإغاثة والأيتام',D006:'الإدارة المالية',D007:'إدارة التعاقد والرقابة',D008:'إدارة الشؤون الإدارية',D009:'إدارة الشؤون التعليمية',D010:'إدارة العمل التطوعي الشبابي',D011:'إدارة العلاقات والمكاتب الدولية'};
const directors=new Map();for(const code of orgCodes){let d=rows.find(r=>r.org===code&&r.role==='مدير إدارة');if(!d){d={employeeNo:nextNo(`DIR-${code}`),name:`مدير افتراضي — الإدارة ${code}`,role:'مدير إدارة',title:`مدير الإدارة ${code}`,org:code,dept:'',global:false,synthetic:true};rows.push(d);}directors.set(code,d);}
const deptKeys=[...new Set(rows.filter(r=>!r.global&&r.role!=='مدير إدارة'&&r.org&&r.dept).map(r=>`${r.org}\0${r.dept}`))];
const heads=new Map();for(const key of deptKeys){const [org,dept]=key.split('\0');let h=rows.find(r=>r.org===org&&r.dept===dept&&r.role==='رئيس قسم');if(!h){h={employeeNo:nextNo(`HEAD-${dept}`),name:`رئيس افتراضي — ${dept}`,role:'رئيس قسم',title:`رئيس القسم ${dept}`,org,dept,global:false,synthetic:true};rows.push(h);}heads.set(key,h);}
for(const r of rows){if(r.global||r.role==='مدير إدارة')r.manager='';else if(r.role==='رئيس قسم')r.manager=directors.get(r.org)?.employeeNo||'';else r.manager=heads.get(`${r.org}\0${r.dept}`)?.employeeNo||'';}
const orgRows=orgCodes.map(code=>[code,orgNames[code]||'اسم الإدارة غير محدد',directors.get(code).employeeNo,'نشط']);
const deptRows=deptKeys.map(key=>{const [org,dept]=key.split('\0'),sample=rows.find(r=>r.org===org&&r.dept===dept&&r.deptName);return [org,dept,sample?.deptName||(dept.endsWith('-S000')?'مكتب الإدارة':`القسم ${dept}`),heads.get(key).employeeNo,'نشط'];});
const userRows=rows.map((r,i)=>[r.employeeNo,r.name,r.role,r.title||r.role,r.org,r.dept,r.manager,phoneFor(r,i),emailFor(r),'نشط',r.synthetic?'بيانات ربط افتراضية أُضيفت لاستكمال الهيكل':'أُعيد تنسيق السجل من الملف المرفق']);
const sheets=[
 {name:'دليل الاستخدام',rows:[['القالب المعتمد للهيكل الإداري',''],['المصدر',path.basename(source)],['الإدارات',orgRows.length],['الأقسام',deptRows.length],['المستخدمون',userRows.length],['ملاحظة','تم تجاهل رموز الإدارة والقسم للإدارة العليا والمستشارين، وتجاهل رمز القسم لمديري الإدارات.']]},
 {name:'الإدارات',rows:[['رمز الإدارة*','اسم الإدارة*','الرقم الوظيفي للمدير*','الحالة*'],...orgRows]},
 {name:'الأقسام',rows:[['رمز الإدارة*','رمز القسم*','اسم القسم*','الرقم الوظيفي لرئيس القسم*','الحالة*'],...deptRows]},
 {name:'المستخدمون',rows:[['الرقم الوظيفي*','الاسم الكامل*','الدور في النظام*','المسمى الوظيفي*','رمز الإدارة*','رمز القسم','الرقم الوظيفي للمدير المباشر','رقم الجوال*','البريد الإلكتروني*','الحالة*','ملاحظات'],...userRows]}
];
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,buildXlsx(sheets));
console.log(JSON.stringify({output,sourceUsers:sheet.rows.length-1,users:userRows.length,organizations:orgRows.length,departments:deptRows.length,syntheticUsers:rows.filter(r=>r.synthetic).length,consultants:rows.filter(r=>r.global&&/مستشار/.test(`${r.sourceRole||''} ${r.title||''}`)).length},null,2));
