'use strict';
const BASE=process.env.TEST_BASE_URL||'http://127.0.0.1:3000/api';
const ADMIN_EMAIL=process.env.ADMIN_EMAIL||'admin@wamy.org';
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'WamyAdmin_2026_Local';
const stamp=Date.now();
const made={orgs:[],tasks:[]};
const results=[];
const ok=(name,pass,detail='')=>{results.push({name,pass:!!pass,detail});if(!pass)throw new Error(name+(detail?': '+detail:''));};

async function request(path,{method='GET',body,cookie,expected}={}){
  const r=await fetch(BASE+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});
  let data={};try{data=await r.json();}catch{}
  if(expected!==undefined&&r.status!==expected)throw new Error(`${method} ${path}: expected ${expected}, got ${r.status} ${data.error||''}`);
  return {status:r.status,data,cookie:(r.headers.get('set-cookie')||'').split(';')[0]};
}
async function login(email,password='RoleTest123'){
  const r=await request('/auth/login',{method:'POST',body:{email,password},expected:200});return {cookie:r.cookie,user:r.data.user};
}
async function adminPost(path,body){return (await request(path,{method:'POST',body,cookie:admin.cookie,expected:201})).data;}
async function createOrg(tag){const x=await adminPost('/admin/meta/organizations',{code:`${tag}${stamp}`,name:`اختبار صلاحيات ${tag} ${stamp}`});made.orgs.push(x.id);return x.id;}
async function createUser(tag,role,organization,dept=null,managerEmployeeNo=null){
  const employeeNo=`RB${stamp}${tag}`,email=`rbac-${stamp}-${tag.toLowerCase()}@wamy.org`;
  const x=await adminPost('/admin/users',{employeeNo,managerEmployeeNo,name:`اختبار ${tag}`,email,password:'RoleTest123',role,title:role,organization,dept,phone:'',active:true});
  return {id:x.id,employeeNo,email};
}
async function createDept(tag,organization){return (await adminPost('/admin/meta/departments',{code:`${tag}${stamp}`,name:`قسم ${tag}`,organization})).id;}
async function createTask(session,assignee,title){
  const r=await request('/tasks',{method:'POST',cookie:session.cookie,body:{title,desc:'RBAC integration test',pri:'medium',cat:'admin',assignee,start:'2026-08-25',due:'2026-09-05',est:11},expected:201});made.tasks.push(r.data.task.id);return r.data.task;
}

let admin;
(async()=>{
 try{
  admin=await login(ADMIN_EMAIL,ADMIN_PASSWORD);ok('دخول مسؤول النظام',admin.user.role==='admin',admin.user.role);
  const orgA=await createOrg('A'),orgB=await createOrg('B');
  const dirA=await createUser('DA','director',orgA),dirB=await createUser('DB','director',orgB);
  await request(`/admin/meta/organizations/${orgA}`,{method:'PATCH',cookie:admin.cookie,body:{directorEmployeeNo:dirA.employeeNo},expected:200});
  await request(`/admin/meta/organizations/${orgB}`,{method:'PATCH',cookie:admin.cookie,body:{directorEmployeeNo:dirB.employeeNo},expected:200});
  const depA=await createDept('SA',orgA),depB=await createDept('SB',orgB);
  const headA=await createUser('HA','manager',orgA,depA,dirA.employeeNo),headB=await createUser('HB','manager',orgB,depB,dirB.employeeNo);
  await request(`/admin/meta/departments/${depA}`,{method:'PATCH',cookie:admin.cookie,body:{headEmployeeNo:headA.employeeNo},expected:200});
  await request(`/admin/meta/departments/${depB}`,{method:'PATCH',cookie:admin.cookie,body:{headEmployeeNo:headB.employeeNo},expected:200});
  const empA=await createUser('EA','employee',orgA,depA,headA.employeeNo),empB=await createUser('EB','employee',orgB,depB,headB.employeeNo);
  const sessions={dirA:await login(dirA.email),dirB:await login(dirB.email),headA:await login(headA.email),headB:await login(headB.email),empA:await login(empA.email),empB:await login(empB.email)};
  Object.entries(sessions).forEach(([k,s])=>ok(`دخول الدور ${k}`,!!s.cookie,s.user.role));

  const taskA=await createTask(sessions.dirA,empA.id,`مهمة إدارة A ${stamp}`);
  const taskB=await createTask(sessions.dirB,empB.id,`مهمة إدارة B ${stamp}`);
  const taskHead=await createTask(sessions.headA,empA.id,`مهمة رئيس قسم A ${stamp}`);

  for(const [who,session,want,forbid] of [
    ['مدير الإدارة A',sessions.dirA,[taskA.id,taskHead.id],[taskB.id]],
    ['رئيس القسم A',sessions.headA,[taskA.id,taskHead.id],[taskB.id]],
    ['الموظف A',sessions.empA,[taskA.id,taskHead.id],[taskB.id]],
    ['الموظف B',sessions.empB,[taskB.id],[taskA.id,taskHead.id]],
  ]){
    const list=(await request('/tasks',{cookie:session.cookie,expected:200})).data.tasks.map(t=>t.id);
    ok(`نطاق رؤية ${who}`,want.every(x=>list.includes(x))&&forbid.every(x=>!list.includes(x)),list.join(','));
  }
  const adminTasks=(await request('/tasks',{cookie:admin.cookie,expected:200})).data.tasks.map(t=>t.id);
  ok('مسؤول النظام يرى الإدارتين',[taskA.id,taskB.id,taskHead.id].every(x=>adminTasks.includes(x)));

  const personal=await createTask(sessions.empA,empA.id,`مهمة شخصية للموظف ${stamp}`);ok('الموظف ينشئ مهمة لنفسه',personal.assignee===empA.id,personal.assignee);
  await request('/tasks',{method:'POST',cookie:sessions.empA.cookie,body:{title:'إسناد موظف لغيره',assignee:empB.id,start:'2026-08-25',due:'2026-09-05'},expected:403});ok('الموظف لا يسند مهمة لغيره',true);
  await request(`/admin/users/${empA.id}`,{method:'PATCH',cookie:admin.cookie,body:{permissions:{create_self:false}},expected:200});
  await request('/tasks',{method:'POST',cookie:sessions.empA.cookie,body:{title:'محجوبة بالتخصيص',assignee:empA.id,start:'2026-08-25',due:'2026-09-05'},expected:403});ok('مدير النظام يعطّل صلاحية فردية',true);
  await request(`/admin/users/${empA.id}`,{method:'PATCH',cookie:admin.cookie,body:{permissions:{}},expected:200});
  await request('/tasks',{method:'POST',cookie:sessions.dirA.cookie,body:{title:'عبر الإدارة',assignee:empB.id,start:'2026-08-25',due:'2026-09-05'},expected:400});ok('مدير الإدارة لا يسند خارج إدارته',true);
  await request('/tasks',{method:'POST',cookie:sessions.headA.cookie,body:{title:'عبر القسم',assignee:empB.id,start:'2026-08-25',due:'2026-09-05'},expected:400});ok('رئيس القسم لا يسند خارج قسمه',true);
  await request(`/tasks/${taskA.id}/action`,{method:'POST',cookie:sessions.empA.cookie,body:{action:'reassign',value:empB.id},expected:403});ok('الموظف لا يعيد الإسناد',true);
  await request(`/tasks/${taskA.id}/action`,{method:'POST',cookie:sessions.headA.cookie,body:{action:'reassign',value:empB.id},expected:403});ok('رئيس القسم لا يعيد الإسناد خارج قسمه',true);

  let c=await request(`/tasks/${taskA.id}/action`,{method:'POST',cookie:sessions.empA.cookie,body:{action:'complete'},expected:200});
  ok('إنهاء الموظف يرسل للاعتماد',c.data.task.status==='approval',c.data.task.status);
  await request(`/tasks/${taskA.id}/action`,{method:'POST',cookie:sessions.empA.cookie,body:{action:'approve',value:5},expected:403});ok('الموظف لا يعتمد الإغلاق',true);
  c=await request(`/tasks/${taskA.id}/action`,{method:'POST',cookie:sessions.headA.cookie,body:{action:'approve',value:5},expected:200});
  ok('رئيس القسم يعتمد إغلاق مهمة قسمه',c.data.task.status==='done',c.data.task.status);

  await request('/admin/users',{cookie:sessions.dirA.cookie,expected:403});ok('إدارة المستخدمين لمسؤول النظام فقط',true);
  const bootA=(await request('/bootstrap',{cookie:sessions.dirA.cookie,expected:200})).data;
  ok('Bootstrap مدير الإدارة معزول',bootA.organizations.length===1&&bootA.organizations[0].id===orgA&&bootA.users.every(u=>u.organization===orgA));
  const bootHead=(await request('/bootstrap',{cookie:sessions.headA.cookie,expected:200})).data;
  ok('Bootstrap رئيس القسم يقتصر على قسمه',bootHead.users.every(u=>u.dept===depA||u.id===headA.id));
  const notes=(await request('/notifications',{cookie:sessions.empA.cookie,expected:200})).data.notifications||[];
  ok('وصول إشعار الإسناد للموظف',notes.some(n=>n.taskId===taskA.id||n.task_id===taskA.id),`notifications=${notes.length}`);
 }catch(e){results.push({name:'خطأ تنفيذي',pass:false,detail:e.message});process.exitCode=1;}
 finally{
  if(admin){for(const id of [...made.tasks].reverse())try{await request(`/tasks/${id}`,{method:'DELETE',cookie:admin.cookie});}catch{}
    for(const id of [...made.orgs].reverse())try{await request(`/admin/meta/organizations/${id}?cascade=true`,{method:'DELETE',cookie:admin.cookie});}catch{}
  }
  const passed=results.filter(x=>x.pass).length,failed=results.length-passed;
  console.log(JSON.stringify({passed,failed,results},null,2));
 }
})();
