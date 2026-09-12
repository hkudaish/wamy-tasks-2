'use strict';
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Ensure variables & PERMISSION_DEFS
const varMarker = '/* ---------- الحالات ---------- */';
const newVars = `/* ---------- الحالات ---------- */
let STATUSES = [
  {id:'new',        name:'جديدة',           cls:'b-purple', color:'var(--purple)',open:true},
  {id:'notstarted', name:'لم تبدأ',          cls:'b-gray',   color:'#5b6676', open:true},
  {id:'inprogress', name:'قيد التنفيذ',      cls:'b-brand',  color:'var(--brand)', open:true},
  {id:'waiting',    name:'بانتظار إجراء',    cls:'b-teal',   color:'var(--teal)',  open:true},
  {id:'approval',   name:'بانتظار اعتماد',   cls:'b-amber',  color:'var(--amber)', open:true},
  {id:'onhold',     name:'معلقة',            cls:'b-gray',   color:'#8b97a8', open:true},
  {id:'late',       name:'متأخرة',           cls:'b-red',    color:'var(--red)',   open:true},
  {id:'done',       name:'مكتملة',           cls:'b-green',  color:'var(--green)', open:false},
  {id:'cancelled',  name:'ملغاة',            cls:'b-gray',   color:'#8b97a8', open:false},
];

/* ---------- الأولويات ---------- */
let PRIORITIES = [
  {id:'urgent', name:'عاجلة',  cls:'b-red',   color:'var(--red)',   rank:4},
  {id:'high',   name:'عالية',  cls:'b-amber', color:'var(--amber)', rank:3},
  {id:'medium', name:'متوسطة', cls:'b-blue',  color:'var(--blue)',  rank:2},
  {id:'low',    name:'منخفضة', cls:'b-gray',  color:'#8b97a8', rank:1},
];

/* ---------- التصنيفات ---------- */
let CATEGORIES = [
  {id:'news',    name:'خبر وتغطية إعلامية'},
  {id:'stmt',    name:'بيان وتصريح رسمي'},
  {id:'video',   name:'إنتاج مرئي وفيديو'},
  {id:'design',  name:'تصميم وهوية بصرية'},
  {id:'event',   name:'فعالية واستقبال'},
  {id:'report',  name:'تقرير ومحتوى'},
  {id:'monitor', name:'رصد وتطوير'},
  {id:'admin',   name:'مهمة إدارية'},
];

/* ---------- المستخدمون والمراسلات ---------- */
let USERS = [];
let STRUCTURE_PEOPLE = [];
let EVENT_TYPES = [];
let EVENTS = [];
let CHAT_CONVERSATIONS = [];
let ACTIVE_CONVERSATION_ID = null;
let CHAT_MESSAGES = [];
let CHAT_CONTACTS = [];
let CHAT_FILTER = 'all';
let CHAT_SEARCH = '';
let CHAT_REPLY_TO = null;
let CHAT_ATTACHMENTS = [];
let CHAT_REFERENCES = [];
let CHAT_UNREAD_COUNT = 0;
let CHAT_POLL_T = null;
let CHAT_MSG_SEARCH = '';

let EVENT_FILTER = { q:'', type:'', org:'' };
let USER_FILTER={q:'',organization:'',dept:'',role:'',permission:'',sort:'asc'};
let USER_FILTER_T=null;
let TASKS = [];
let SEQ = 1;
const ROLE_AR = {admin:'مدير النظام', secretary_general:'الأمين العام', assistant_secretary_general:'مساعد الأمين العام', director:'مدير الإدارة', consultant:'مستشار', manager:'رئيس القسم', employee:'موظف'};
/* المدير قد يتولى أكثر من إدارة، فنطاقه مجموعة لا قيمة واحدة */
const myOrgIds = () => (ME && ME.orgIds && ME.orgIds.length ? ME.orgIds : [ME && ME.organization].filter(Boolean));
const inMyOrgs = org => myOrgIds().includes(org);
const PERMISSION_DEFS=[['create_self','إنشاء مهمة لنفسه'],['assign_others','إسناد مهام للآخرين ضمن النطاق'],['manage_tasks','تعديل وإدارة مهام النطاق'],['manage_events','إدارة الفعاليات ضمن النطاق'],['approve_close','اعتماد إغلاق المهام'],['reassign_tasks','إعادة إسناد المهام'],['delete_tasks','حذف المهام'],['view_reports','عرض التقارير'],['chat_view','عرض واستخدام الرسائل'],['chat_start','بدء محادثات جديدة'],['chat_attach_file','إرفاق ملفات في المحادثة'],['chat_mention_task','الإشارة للمهام في المحادثة']];
function rolePermissionDefaults(role){const managerial=['admin','secretary_general','assistant_secretary_general','director','manager'].includes(role);return {create_self:true,assign_others:managerial,manage_tasks:managerial,manage_events:managerial,approve_close:managerial,reassign_tasks:managerial,delete_tasks:role==='admin',view_reports:role!=='employee',chat_view:true,chat_start:true,chat_attach_file:true,chat_mention_task:true};}
function hasUserPermission(u,key){if(!u)return false;if(u.role==='admin')return true;return u.permissions&&typeof u.permissions[key]==='boolean'?u.permissions[key]:rolePermissionDefaults(u.role)[key];}`;

// Replace from STATUSES definition to organizationDisplayName
const regexVars = /\/\* ---------- الحالات ---------- \*\/[\s\S]*?const ORGANIZATION_NAMES=/;
content = content.replace(regexVars, newVars + '\nconst ORGANIZATION_NAMES=');

// 2. In renderNav(): Add 'messages' item
const navTarget = "{id:'dash', ic:'▦', t:'لوحة المؤشرات'},";
const navReplace = "{id:'dash', ic:'▦', t:'لوحة المؤشرات'},\n    {id:'messages', ic:'💬', t:'الرسائل', permission:'chat_view', n:CHAT_UNREAD_COUNT, hot:true},";
if (!content.includes("{id:'messages'")) {
  content = content.replace(navTarget, navReplace);
}

// 3. In PAGE_TITLES
content = content.replace("dash:'الملخص التنفيذي',", "dash:'الملخص التنفيذي',messages:'الرسائل والمحادثات',");

// 4. In render(): Add messages:vMessages
content = content.replace(
  "{dash:vDash,mine:vMine,",
  "{dash:vDash,messages:vMessages,mine:vMine,"
);
content = content.replace(
  "if(PAGE==='perf') drawPerf();",
  "if(PAGE==='perf') drawPerf();\n  if(PAGE==='messages') initMessagesView();"
);

// 5. In drawer footer: Add "مناقشة المهمة"
const drawerFooterTarget = "${can?`<button class=\"btn ghost sm\" onclick=\"openTaskForm('${t.id}')\">✎ تعديل</button>`:''}";
const drawerFooterReplace = "<button class=\"btn ghost sm\" onclick=\"discussTask('${t.id}')\" title=\"بدء أو فتح محادثة لمناقشة هذه المهمة\">💬 مناقشة المهمة</button>\n    " + drawerFooterTarget;
if (!content.includes("discussTask('${t.id}')")) {
  content = content.replace(drawerFooterTarget, drawerFooterReplace);
}

// 6. In boot() and startSync(): Add fetchChatUnreadCount()
if (!content.includes('fetchChatUnreadCount()')) {
  content = content.replace(
    "setNotifs(n.notifications);",
    "setNotifs(n.notifications);\n  fetchChatUnreadCount();"
  );
  content = content.replace(
    "TASKS = t.tasks; setNotifs(n.notifications);",
    "TASKS = t.tasks; setNotifs(n.notifications); fetchChatUnreadCount(); if(PAGE==='messages'&&ACTIVE_CONVERSATION_ID) pollChatActiveMessages();"
  );
}

// 7. Add complete chat functions & vMessages definition
const chatCode = `
/* ============================================================
   شاشة المراسلات والمحادثات — وامي (الرسائل)
   نظام محادثات فوري مقيّد بالصلاحيات والهيكل وسياق المهام
   ============================================================ */

function vMessages() {
  return \`
    <div class="msg-app" id="msgApp">
      <!-- القائمة الجانبية للمحادثات -->
      <div class="msg-sidebar \${ACTIVE_CONVERSATION_ID && window.innerWidth < 800 ? 'hide-mobile' : ''}" id="msgSidebar">
        <div class="msg-sidebar-head">
          <div class="msg-search-box">
            <input class="inp sm" id="chatSearchInp" placeholder="🔍 بحث في المحادثات…" value="\${esc(CHAT_SEARCH)}" oninput="onChatSearch(this.value)">
          </div>
          <button class="btn sm" onclick="openNewChatModal()" title="رسالة جديدة">＋ رسالة جديدة</button>
        </div>
        <div class="msg-tabs">
          <button class="msg-tab-btn \${CHAT_FILTER==='all'?'active':''}" onclick="setChatFilter('all')">الكل</button>
          <button class="msg-tab-btn \${CHAT_FILTER==='unread'?'active':''}" onclick="setChatFilter('unread')">غير المقروءة \${CHAT_UNREAD_COUNT>0?\`(\${CHAT_UNREAD_COUNT})\`:''}</button>
          <button class="msg-tab-btn \${CHAT_FILTER==='managers'?'active':''}" onclick="setChatFilter('managers')">القيادة</button>
          <button class="msg-tab-btn \${CHAT_FILTER==='team'?'active':''}" onclick="setChatFilter('team')">فريق العمل</button>
          <button class="msg-tab-btn \${CHAT_FILTER==='tasks'?'active':''}" onclick="setChatFilter('tasks')">نقاشات المهام</button>
        </div>
        <div class="msg-list" id="msgConvList">
          \${renderChatConvListHtml()}
        </div>
      </div>

      <!-- مساحة المحادثة الرئيسية -->
      <div class="msg-main-panel \${!ACTIVE_CONVERSATION_ID && window.innerWidth < 800 ? 'hide-mobile' : ''}" id="msgMainPanel">
        \${renderChatMainHtml()}
      </div>
    </div>
  \`;
}

function initMessagesView() {
  loadChatConversations(ACTIVE_CONVERSATION_ID);
  startChatPoller();
}

function startChatPoller() {
  clearInterval(CHAT_POLL_T);
  CHAT_POLL_T = setInterval(() => {
    if (PAGE !== 'messages' || document.hidden) return;
    fetchChatUnreadCount();
    if (ACTIVE_CONVERSATION_ID) {
      pollChatActiveMessages();
    }
  }, 4000);
}

async function fetchChatUnreadCount() {
  if (!ME || !hasUserPermission(ME, 'chat_view')) return;
  try {
    const res = await API.get('/chat/unread-count');
    CHAT_UNREAD_COUNT = Number(res?.unreadCount || 0);
    renderNav();
  } catch (e) { /* صامت */ }
}

async function loadChatConversations(autoSelectId) {
  try {
    const res = await API.get('/chat/conversations');
    CHAT_CONVERSATIONS = res?.conversations || [];
    
    if (autoSelectId) {
      ACTIVE_CONVERSATION_ID = autoSelectId;
      await loadChatMessages(autoSelectId);
    } else if (CHAT_CONVERSATIONS.length && !ACTIVE_CONVERSATION_ID && window.innerWidth >= 800) {
      ACTIVE_CONVERSATION_ID = CHAT_CONVERSATIONS[0].id;
      await loadChatMessages(ACTIVE_CONVERSATION_ID);
    }

    const listEl = document.getElementById('msgConvList');
    if (listEl) listEl.innerHTML = renderChatConvListHtml();
    fetchChatUnreadCount();
  } catch (e) {
    console.error('[chat-conversations]', e);
  }
}

function setChatFilter(f) {
  CHAT_FILTER = f;
  const listEl = document.getElementById('msgConvList');
  if (listEl) listEl.innerHTML = renderChatConvListHtml();
  const tabs = document.querySelectorAll('.msg-tab-btn');
  tabs.forEach(t => t.classList.remove('active'));
  document.querySelector(\`.msg-tab-btn[onclick*="'\${f}'"]\`)?.classList.add('active');
}

function onChatSearch(q) {
  CHAT_SEARCH = String(q || '').trim().toLowerCase();
  const listEl = document.getElementById('msgConvList');
  if (listEl) listEl.innerHTML = renderChatConvListHtml();
}

function filterConversations() {
  return CHAT_CONVERSATIONS.filter(c => {
    if (CHAT_FILTER === 'unread' && !c.unreadCount) return false;
    if (CHAT_FILTER === 'tasks' && c.type !== 'TASK') return false;
    if (CHAT_FILTER === 'managers') {
      const other = c.otherParticipant;
      if (!['admin','secretary_general','assistant_secretary_general','director','manager'].includes(other?.role)) return false;
    }
    if (CHAT_FILTER === 'team') {
      const other = c.otherParticipant;
      if (other?.role !== 'employee') return false;
    }
    if (CHAT_SEARCH) {
      const name = (c.title || c.otherParticipant?.name || '').toLowerCase();
      const prev = (c.lastMessagePreview || '').toLowerCase();
      const taskT = (c.task?.title || '').toLowerCase();
      if (!name.includes(CHAT_SEARCH) && !prev.includes(CHAT_SEARCH) && !taskT.includes(CHAT_SEARCH)) return false;
    }
    return true;
  });
}

function renderChatConvListHtml() {
  const list = filterConversations();
  if (!list.length) {
    return \`<div style="text-align:center;padding:30px 14px;color:var(--muted);font-size:12px">لا توجد محادثات تطابق الفلتر.<br><br><button class="btn ghost sm" onclick="openNewChatModal()">＋ بدء محادثة جديدة</button></div>\`;
  }

  return list.map(c => {
    const isAct = c.id === ACTIVE_CONVERSATION_ID;
    const other = c.otherParticipant || { name: 'محادثة' };
    const title = c.type === 'TASK' ? (c.task ? \`📌 \${c.task.title}\` : c.title) : other.name;
    const isOnline = other.lastLoginAt && (new Date() - new Date(other.lastLoginAt)) < 30 * 60 * 1000;
    const timeStr = c.lastMessageAt ? fmtDT(c.lastMessageAt).split('·')[1]?.trim() || fmtShort(c.lastMessageAt) : '';

    return \`
      <div class="msg-conv-item \${isAct ? 'active' : ''}" onclick="selectConversation('\${c.id}')">
        <div class="msg-conv-avatar-wrap">
          <div class="avatar" style="width:34px;height:34px;font-size:11px;background:\${c.type==='TASK'?'var(--brand-soft)':'var(--surface-2)'};color:\${c.type==='TASK'?'var(--brand)':'inherit'}">
            \${c.type === 'TASK' ? '📌' : initials(other.name || 'م')}
          </div>
          \${isOnline ? '<span class="msg-online-dot" title="متصل الآن"></span>' : ''}
        </div>
        <div class="msg-conv-info">
          <div class="msg-conv-title-row">
            <span class="msg-conv-name" title="\${esc(title)}">\${esc(title)}</span>
            <span class="msg-conv-time">\${timeStr}</span>
          </div>
          <div class="msg-conv-preview-row">
            <span class="msg-conv-snippet">\${esc(c.lastMessagePreview || (c.type === 'TASK' ? 'نقاش مهمة' : 'بدء محادثة جديدة'))}</span>
            \${c.unreadCount > 0 ? \`<span class="msg-unread-badge">\${nfm(c.unreadCount)}</span>\` : ''}
            \${c.isPinned ? '<span style="font-size:11px" title="مثبتة">📌</span>' : ''}
          </div>
        </div>
      </div>
    \`;
  }).join('');
}

async function selectConversation(convId) {
  ACTIVE_CONVERSATION_ID = convId;
  const listEl = document.getElementById('msgConvList');
  if (listEl) listEl.innerHTML = renderChatConvListHtml();
  await loadChatMessages(convId);
}

function clearActiveConversation() {
  ACTIVE_CONVERSATION_ID = null;
  render();
}

async function loadChatMessages(convId) {
  try {
    const res = await API.get(\`/chat/conversations/\${convId}/messages\`);
    CHAT_MESSAGES = res?.messages || [];
    
    // تحديث عداد غير المقروء محليًا
    const target = CHAT_CONVERSATIONS.find(c => c.id === convId);
    if (target) target.unreadCount = 0;
    fetchChatUnreadCount();

    const mainEl = document.getElementById('msgMainPanel');
    if (mainEl) mainEl.innerHTML = renderChatMainHtml();
    scrollChatToBottom();
  } catch (e) {
    console.error('[chat-messages]', e);
  }
}

async function pollChatActiveMessages() {
  if (!ACTIVE_CONVERSATION_ID) return;
  try {
    const res = await API.get(\`/chat/conversations/\${ACTIVE_CONVERSATION_ID}/messages\`);
    const newMsgs = res?.messages || [];
    if (newMsgs.length !== CHAT_MESSAGES.length || (newMsgs.length && newMsgs[newMsgs.length - 1].id !== CHAT_MESSAGES[CHAT_MESSAGES.length - 1]?.id)) {
      CHAT_MESSAGES = newMsgs;
      const streamEl = document.getElementById('msgStream');
      if (streamEl) {
        streamEl.innerHTML = renderChatStreamHtml();
        scrollChatToBottom();
      }
    }
  } catch (e) { /* صامت */ }
}

function scrollChatToBottom() {
  setTimeout(() => {
    const stream = document.getElementById('msgStream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, 50);
}

function renderChatMainHtml() {
  if (!ACTIVE_CONVERSATION_ID) {
    return \`
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);text-align:center;padding:30px">
        <div style="font-size:44px;margin-bottom:12px">💬</div>
        <div style="font-weight:700;font-size:16px;color:var(--text);margin-bottom:6px">مركز الرسائل والمحادثات المعتمدة</div>
        <div style="font-size:12.5px;max-width:380px;line-height:1.7">تواصل مع مديرك المباشر وفريق العمل والمشاركين في المهام وفق الهيكل الإداري المعتمد.</div>
        <button class="btn sm" style="margin-top:16px" onclick="openNewChatModal()">＋ رسالة جديدة</button>
      </div>
    \`;
  }

  const conv = CHAT_CONVERSATIONS.find(c => c.id === ACTIVE_CONVERSATION_ID);
  if (!conv) return '<div style="padding:20px;text-align:center">جارٍ تحميل المحادثة…</div>';

  const other = conv.otherParticipant || { name: 'محادثة' };
  const title = conv.type === 'TASK' ? (conv.task ? \`نقاش مهمة: \${conv.task.title}\` : conv.title) : other.name;
  const isOnline = other.lastLoginAt && (new Date() - new Date(other.lastLoginAt)) < 30 * 60 * 1000;

  return \`
    <!-- رأس المحادثة -->
    <div class="msg-main-head">
      <button class="icon-btn" style="margin-inline-end:4px" onclick="clearActiveConversation()" title="رجوع">←</button>
      <div class="avatar" style="width:36px;height:36px;font-size:12px;background:var(--brand-soft);color:var(--brand)">
        \${conv.type === 'TASK' ? '📌' : initials(other.name || 'م')}
      </div>
      <div class="msg-main-head-info">
        <div class="msg-main-head-name">
          <span>\${esc(title)}</span>
          \${conv.type === 'TASK' ? '<span class="badge b-purple">محادثة مهمة</span>' : ''}
        </div>
        <div class="msg-main-head-sub">
          \${conv.type === 'TASK' && conv.task
            ? \`المسؤول: \${esc(conv.task.assigneeName || '—')} · الحالة: \${esc(ST(conv.task.status).name)}\`
            : \`\${esc(ROLE_AR[other.role] || '')} \${other.title ? '· ' + esc(other.title) : ''} \${other.dept ? '· ' + esc(dname(other.dept)) : ''} \${isOnline ? '· <span style=\"color:var(--green)\">متصل</span>' : ''}\`}
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        \${conv.taskId ? \`<button class="btn ghost sm" onclick="openTask('\${conv.taskId}')" title="عرض تفاصيل المهمة">📋 تفاصيل المهمة</button>\` : ''}
        <button class="icon-btn" onclick="togglePinConversation('\${conv.id}')" title="\${conv.isPinned ? 'إلغاء التثبيت' : 'تثبيت المحادثة'}">\${conv.isPinned ? '📌' : '📍'}</button>
      </div>
    </div>

    <!-- تيار الرسائل -->
    <div class="msg-stream-wrap" id="msgStream">
      \${renderChatStreamHtml()}
    </div>

    <!-- شريط الإدخال والرد والمرفقات -->
    <div class="msg-composer">
      \${CHAT_REPLY_TO ? \`
        <div class="msg-banner-row">
          <span><b>رد على \${esc(CHAT_REPLY_TO.name)}:</b> \${esc(CHAT_REPLY_TO.snippet)}</span>
          <button class="icon-btn sm" onclick="cancelChatReply()">✕</button>
        </div>
      \` : ''}

      \${CHAT_REFERENCES.length ? \`
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          \${CHAT_REFERENCES.map((r, i) => \`
            <span class="badge b-blue" style="font-size:11.5px">
              📌 \${esc(r.title)}
              <button style="border:none;background:transparent;cursor:pointer;margin-inline-start:4px;color:inherit" onclick="removeChatReference(\${i})">✕</button>
            </span>
          \`).join('')}
        </div>
      \` : ''}

      \${CHAT_ATTACHMENTS.length ? \`
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          \${CHAT_ATTACHMENTS.map((a, i) => \`
            <span class="badge b-gray" style="font-size:11.5px">
              📎 \${esc(a.originalName)}
              <button style="border:none;background:transparent;cursor:pointer;margin-inline-start:4px;color:inherit" onclick="removeChatAttachment(\${i})">✕</button>
            </span>
          \`).join('')}
        </div>
      \` : ''}

      <div class="msg-composer-inputs">
        <button class="icon-btn" onclick="openChatTaskPicker()" title="إرفاق مهمة / إجراء مرجعي">📌</button>
        <label class="icon-btn" style="cursor:pointer" title="إرفاق ملفات">📎<input type="file" multiple hidden onchange="handleChatFileUpload(this)"></label>
        <textarea class="inp msg-input-textarea" id="chatMsgInput" placeholder="اكتب رسالتك هنا… (Enter للإرسال، Shift+Enter لسطر جديد)" onkeydown="handleChatInputKey(event)"></textarea>
        <button class="btn sm" style="padding:9px 16px;border-radius:18px" onclick="sendActiveChatMessage()" id="chatSendBtn">إرسال 🚀</button>
      </div>
    </div>
  \`;
}

function renderChatStreamHtml() {
  if (!CHAT_MESSAGES.length) {
    return \`<div style="text-align:center;padding:40px 10px;color:var(--muted);font-size:12.5px">لا توجد رسائل سابقة. ابدأ المحادثة الآن!</div>\`;
  }

  let lastDateStr = '';
  return CHAT_MESSAGES.map(m => {
    const isMe = m.senderId === ME.id;
    const msgDate = new Date(m.createdAt);
    const dateStr = fmtDate(iso(msgDate));
    let dateSep = '';
    if (dateStr !== lastDateStr) {
      lastDateStr = dateStr;
      dateSep = \`<div class="msg-date-divider"><span>\${dateStr}</span></div>\`;
    }

    const timeStr = msgDate.toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', hour12: true, numberingSystem: 'latn' });
    const isDeleted = m.isDeleted;

    // المراجع (مهام، إجراءات)
    const refsHtml = (m.references || []).map(r => \`
      <div class="msg-ref-task-card" \${r.refId ? \`onclick="openTask('\${r.refId}')" style="cursor:pointer"\` : ''}>
        <div class="msg-ref-task-title">📌 \${esc(r.title || r.refId)}</div>
        <div class="msg-ref-task-details">
          \${r.meta?.status ? \`<span class="badge \${ST(r.meta.status).cls}">\${ST(r.meta.status).name}</span>\` : ''}
          \${r.meta?.assignee ? \`<span>المسؤول: \${esc(r.meta.assignee)}</span>\` : ''}
          \${r.meta?.due ? \`<span>الاستحقاق: \${fmtDate(r.meta.due)}</span>\` : ''}
        </div>
      </div>
    \`).join('');

    // المرفقات
    const attachHtml = (m.attachments || []).map(a => \`
      <div>
        <a class="msg-attachment-chip" href="\${a.url}" target="_blank" download="\${esc(a.name)}">
          📎 \${esc(a.name)} \${a.size ? \`<span style=\"opacity:.7\">(\${Math.round(a.size/1024)} KB)</span>\` : ''}
        </a>
      </div>
    \`).join('');

    return \`
      \${dateSep}
      <div class="msg-bubble-row \${isMe ? 'me' : 'other'}" id="msg-\${m.id}">
        <div class="avatar" style="width:28px;height:28px;font-size:10px;flex:none;align-self:flex-end">
          \${initials(m.senderName || 'م')}
        </div>
        <div class="msg-bubble">
          \${!isMe ? \`<div style="font-weight:700;font-size:11px;margin-bottom:3px;opacity:.9">\${esc(m.senderName)}</div>\` : ''}
          \${m.replyToId ? \`<div class="msg-reply-quote-box">رد على رسالة سابقة</div>\` : ''}
          \${refsHtml}
          <div style="\${isDeleted ? 'font-style:italic;opacity:.75' : ''}">\${esc(m.message)}</div>
          \${attachHtml}
          <div class="msg-bubble-meta">
            <span>\${timeStr}</span>
            \${isMe ? \`<span>\${m.isRead ? '✓✓' : '✓'}</span>\` : ''}
          </div>
        </div>
        <div class="msg-bubble-actions">
          \${!isDeleted ? \`<button class="icon-btn sm" onclick="setChatReplyTo(\${m.id}, '\${esc(m.senderName)}', '\${esc(m.message.slice(0, 40))}')" title="رد">↩</button>\` : ''}
          \${isMe && !isDeleted ? \`<button class="icon-btn sm" onclick="deleteChatMessage(\${m.id})" title="حذف الرسالة">🗑</button>\` : ''}
        </div>
      </div>
    \`;
  }).join('');
}

function handleChatInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendActiveChatMessage();
  }
}

async function sendActiveChatMessage() {
  if (!ACTIVE_CONVERSATION_ID) return;
  const inp = document.getElementById('chatMsgInput');
  const text = String(inp?.value || '').trim();

  if (!text && !CHAT_ATTACHMENTS.length && !CHAT_REFERENCES.length) {
    return;
  }

  const btn = document.getElementById('chatSendBtn');
  if (btn) btn.disabled = true;

  try {
    const payload = {
      message: text,
      replyToId: CHAT_REPLY_TO?.id || null,
      attachments: CHAT_ATTACHMENTS,
      references: CHAT_REFERENCES,
    };

    const res = await API.post(\`/chat/conversations/\${ACTIVE_CONVERSATION_ID}/messages\`, payload);
    if (res?.message) {
      CHAT_MESSAGES.push(res.message);
      if (inp) inp.value = '';
      cancelChatReply();
      CHAT_ATTACHMENTS = [];
      CHAT_REFERENCES = [];
      
      const streamEl = document.getElementById('msgStream');
      if (streamEl) {
        streamEl.innerHTML = renderChatStreamHtml();
        scrollChatToBottom();
      }

      // تحديث المعاينة في القائمة
      const conv = CHAT_CONVERSATIONS.find(c => c.id === ACTIVE_CONVERSATION_ID);
      if (conv) {
        conv.lastMessagePreview = text || 'مرفق/مرجع';
        conv.lastMessageAt = new Date().toISOString();
        const listEl = document.getElementById('msgConvList');
        if (listEl) listEl.innerHTML = renderChatConvListHtml();
      }
    }
  } catch (e) {
    toast('تعذّر إرسال الرسالة: ' + e.message, 'bad');
  } finally {
    if (btn) btn.disabled = false;
    if (inp) inp.focus();
  }
}

function setChatReplyTo(id, name, snippet) {
  CHAT_REPLY_TO = { id, name, snippet };
  const mainEl = document.getElementById('msgMainPanel');
  if (mainEl) mainEl.innerHTML = renderChatMainHtml();
  document.getElementById('chatMsgInput')?.focus();
}

function cancelChatReply() {
  CHAT_REPLY_TO = null;
  const mainEl = document.getElementById('msgMainPanel');
  if (mainEl) mainEl.innerHTML = renderChatMainHtml();
}

async function handleChatFileUpload(input) {
  const files = input.files;
  if (!files || !files.length) return;
  const fd = new FormData();
  for (let i = 0; i < files.length; i++) {
    fd.append('files', files[i]);
  }

  toast('يجري رفع المرفقات…');
  try {
    const r = await fetch('/api/chat/upload', {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'فشل الرفع' }));
      throw new Error(err.error || 'فشل رفع الملفات');
    }
    const res = await r.json();
    if (res?.files) {
      CHAT_ATTACHMENTS.push(...res.files);
      const mainEl = document.getElementById('msgMainPanel');
      if (mainEl) mainEl.innerHTML = renderChatMainHtml();
      toast('تم إرفاق الملفات بنجاح');
    }
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    input.value = '';
  }
}

function removeChatAttachment(index) {
  CHAT_ATTACHMENTS.splice(index, 1);
  const mainEl = document.getElementById('msgMainPanel');
  if (mainEl) mainEl.innerHTML = renderChatMainHtml();
}

function removeChatReference(index) {
  CHAT_REFERENCES.splice(index, 1);
  const mainEl = document.getElementById('msgMainPanel');
  if (mainEl) mainEl.innerHTML = renderChatMainHtml();
}

/* نافذة اختيار مهمة للإشارة إليها */
function openChatTaskPicker() {
  const tasks = visible();
  const m = document.getElementById('modal');
  m.innerHTML = \`
    <div class="modal-h">
      <h3>📌 إرفاق مهمة في المحادثة</h3>
      <div style="flex:1"></div>
      <button class="icon-btn" onclick="closeAll()">✕</button>
    </div>
    <div class="modal-b">
      <input class="inp sm" id="taskPickerSearch" placeholder="🔍 ابحث في مهامك المصرحة…" oninput="filterChatTaskPicker(this.value)">
      <div style="max-height:360px;overflow-y:auto;margin-top:10px" id="taskPickerList">
        \${renderChatTaskPickerListHtml(tasks)}
      </div>
    </div>
  \`;
  document.getElementById('overlay').classList.add('open');
  m.classList.add('open');
}

function filterChatTaskPicker(q) {
  const s = String(q || '').trim().toLowerCase();
  const tasks = visible().filter(t => t.title.toLowerCase().includes(s) || t.id.toLowerCase().includes(s));
  const el = document.getElementById('taskPickerList');
  if (el) el.innerHTML = renderChatTaskPickerListHtml(tasks);
}

function renderChatTaskPickerListHtml(tasks) {
  if (!tasks.length) return '<div style="padding:20px;text-align:center;color:var(--muted)">لا توجد مهام مطابقة.</div>';
  return tasks.slice(0, 30).map(t => \`
    <div class="rank" style="cursor:pointer;padding:8px 10px;margin-bottom:6px;border-radius:6px;background:var(--surface-2)" onclick="attachTaskToChat('\${t.id}')">
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:13px">\${esc(t.title)}</div>
        <div class="t-meta">\${esc(t.id)} · \${esc(uname(t.assignee))} · \${esc(ST(effStatus(t)).name)}</div>
      </div>
      <span class="badge \${PR(t.pri).cls}">\${PR(t.pri).name}</span>
    </div>
  \`).join('');
}

function attachTaskToChat(taskId) {
  const t = TASKS.find(x => x.id === taskId);
  if (t) {
    CHAT_REFERENCES.push({
      type: 'TASK',
      id: t.id,
      title: t.title,
      meta: { status: effStatus(t), pri: t.pri, due: t.due, assignee: uname(t.assignee) },
    });
    closeAll();
    const mainEl = document.getElementById('msgMainPanel');
    if (mainEl) mainEl.innerHTML = renderChatMainHtml();
    document.getElementById('chatMsgInput')?.focus();
  }
}

/* نافذة بدء محادثة جديدة مع جهات الاتصال المصرح بها فقط */
async function openNewChatModal() {
  const m = document.getElementById('modal');
  m.innerHTML = \`
    <div class="modal-h">
      <h3>✉️ رسالة جديدة</h3>
      <div style="flex:1"></div>
      <button class="icon-btn" onclick="closeAll()">✕</button>
    </div>
    <div class="modal-b">
      <div class="alert info" style="margin-bottom:10px;font-size:12px">
        <span>🔒</span>
        <div>جهات الاتصال مقيدة بنطاقك الإداري والهيكل التنظيمي المعتمد. لا يمكن مراسلة المستخدمين خارج نطاقك.</div>
      </div>
      <input class="inp sm" id="newChatUserSearch" placeholder="🔍 ابحث بالاسم، المسمى، أو القسم…" oninput="filterNewChatContacts(this.value)">
      <div style="max-height:380px;overflow-y:auto;margin-top:10px" id="newChatContactsList">
        <div style="padding:20px;text-align:center">جارٍ جلب جهات الاتصال المصرح بها…</div>
      </div>
    </div>
  \`;
  document.getElementById('overlay').classList.add('open');
  m.classList.add('open');

  try {
    const res = await API.get('/chat/contacts');
    CHAT_CONTACTS = res?.contacts || [];
    renderNewChatContactsList(CHAT_CONTACTS);
  } catch (e) {
    document.getElementById('newChatContactsList').innerHTML = \`<div style="color:var(--red);padding:20px;text-align:center">\${e.message}</div>\`;
  }
}

function filterNewChatContacts(q) {
  const s = String(q || '').trim().toLowerCase();
  const filtered = CHAT_CONTACTS.filter(u =>
    u.name.toLowerCase().includes(s) ||
    (u.title || '').toLowerCase().includes(s) ||
    dname(u.dept).toLowerCase().includes(s)
  );
  renderNewChatContactsList(filtered);
}

function renderNewChatContactsList(contacts) {
  const el = document.getElementById('newChatContactsList');
  if (!el) return;
  if (!contacts.length) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">لا توجد جهات اتصال مصرح بها مطابقة للبحث.</div>';
    return;
  }

  el.innerHTML = contacts.map(u => \`
    <div class="rank" style="cursor:pointer;padding:8px 10px;margin-bottom:6px;border-radius:6px;background:var(--surface-2)" onclick="startDirectChat('\${u.id}')">
      <div class="avatar" style="width:32px;height:32px;font-size:11px">\${initials(u.name)}</div>
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:13px">\${esc(u.name)}</div>
        <div class="t-meta">\${esc(ROLE_AR[u.role] || '')} \${u.title ? '· ' + esc(u.title) : ''} \${u.dept ? '· ' + esc(dname(u.dept)) : ''}</div>
      </div>
      <button class="btn ghost sm" style="padding:4px 10px">مراسلة</button>
    </div>
  \`).join('');
}

async function startDirectChat(recipientId) {
  closeAll();
  busy(true);
  try {
    const res = await API.post('/chat/conversations', { recipientId, type: 'DIRECT' });
    if (res?.conversationId) {
      PAGE = 'messages';
      go('messages');
      ACTIVE_CONVERSATION_ID = res.conversationId;
      await loadChatConversations(res.conversationId);
    }
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    busy(false);
  }
}

/* مناقشة المهمة: الانتقال للمحادثة وفتح نقاش المهمة */
async function discussTask(taskId) {
  closeAll();
  busy(true);
  try {
    const res = await API.post('/chat/conversations', { taskId, type: 'TASK' });
    if (res?.conversationId) {
      PAGE = 'messages';
      go('messages');
      ACTIVE_CONVERSATION_ID = res.conversationId;
      await loadChatConversations(res.conversationId);
      const t = TASKS.find(x => x.id === taskId);
      if (t) {
        CHAT_REFERENCES = [{
          type: 'TASK',
          id: t.id,
          title: t.title,
          meta: { status: effStatus(t), pri: t.pri, due: t.due, assignee: uname(t.assignee) },
        }];
        const mainEl = document.getElementById('msgMainPanel');
        if (mainEl) mainEl.innerHTML = renderChatMainHtml();
      }
    }
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    busy(false);
  }
}

async function togglePinConversation(convId) {
  try {
    const res = await API.post(\`/chat/conversations/\${convId}/pin\`);
    const conv = CHAT_CONVERSATIONS.find(c => c.id === convId);
    if (conv) conv.isPinned = res?.isPinned;
    CHAT_CONVERSATIONS.sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));
    render();
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function deleteChatMessage(msgId) {
  if (!confirm('هل أنت متأكد من حذف هذه الرسالة؟')) return;
  try {
    await API.del(\`/chat/messages/\${msgId}\`);
    const m = CHAT_MESSAGES.find(x => x.id === msgId);
    if (m) {
      m.isDeleted = true;
      m.message = 'تم حذف هذه الرسالة';
    }
    const streamEl = document.getElementById('msgStream');
    if (streamEl) streamEl.innerHTML = renderChatStreamHtml();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
`;

// Insert the chatCode right after vEvents function
const vEventsEnd = "function vEvents(){";
content = content.replace(vEventsEnd, chatCode + "\n" + vEventsEnd);

fs.writeFileSync(filePath, content, 'utf8');
console.log('✔ Successfully updated public/index.html with Messages module.');
