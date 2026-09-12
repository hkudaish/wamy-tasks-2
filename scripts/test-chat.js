'use strict';
/**
 * اختبارات نظام المراسلات والصلاحيات والهيكل الإداري
 */
const { one, all, q } = require('../server/db');
const L = require('../server/logic');

async function runTests() {
  console.log('--- بدء اختبارات نظام الرسائل والصلاحيات ---');

  let passed = 0, failed = 0;
  function assert(name, condition) {
    if (condition) {
      console.log(`  ✔ [نجح] ${name}`);
      passed++;
    } else {
      console.error(`  ✖ [فشل] ${name}`);
      failed++;
    }
  }

  // 1. اختبار الدوال المنطقية الأساسية (Pure Logic Tests)
  const mockAdmin = { id: 'u-admin', role: 'admin', active: true, permissions: {} };
  const mockDirectorA = { id: 'u-dir-a', role: 'director', organization_id: 'org-a', orgIds: ['org-a'], active: true, permissions: {} };
  const mockDirectorB = { id: 'u-dir-b', role: 'director', organization_id: 'org-b', orgIds: ['org-b'], active: true, permissions: {} };
  const mockMgrA = { id: 'u-mgr-a', role: 'manager', organization_id: 'org-a', dept_id: 'dept-a1', active: true, permissions: {} };
  const mockEmpA1 = { id: 'u-emp-a1', role: 'employee', organization_id: 'org-a', dept_id: 'dept-a1', manager_id: 'u-mgr-a', active: true, permissions: {} };
  const mockEmpA2 = { id: 'u-emp-a2', role: 'employee', organization_id: 'org-a', dept_id: 'dept-a1', manager_id: 'u-mgr-a', active: true, permissions: {} };
  const mockEmpB1 = { id: 'u-emp-b1', role: 'employee', organization_id: 'org-b', dept_id: 'dept-b1', manager_id: 'u-mgr-b', active: true, permissions: {} };
  const mockDisabled = { id: 'u-disabled', role: 'employee', organization_id: 'org-a', dept_id: 'dept-a1', active: false, permissions: {} };

  // فحص canViewChat & canStartChat
  assert('مدير النظام يملك صلاحية المراسلة', L.canViewChat(mockAdmin) === true);
  assert('الموظف النشط يملك صلاحية المراسلة', L.canViewChat(mockEmpA1) === true);
  assert('المستخدم المعطل لا يملك صلاحية المراسلة', L.canViewChat(mockDisabled) === false);
  assert('المستخدم مع تعطيل chat_view صراحة لا يمكنه المراسلة', L.canViewChat({ active: true, role: 'employee', permissions: { chat_view: false } }) === false);

  // فحص الأهلية والتسلسل الإداري canMessageUser
  assert('مدير النظام يمكنه مراسلة أي مستخدم نشط', L.canMessageUser(mockAdmin, mockEmpB1) === true);
  assert('أي مستخدم يمكنه مراسلة مدير النظام', L.canMessageUser(mockEmpB1, mockAdmin) === true);

  assert('مدير الإدارة A يمكنه مراسلة رئيس القسم A1 في إدارته', L.canMessageUser(mockDirectorA, mockMgrA) === true);
  assert('مدير الإدارة A يمكنه مراسلة الموظف A1 في إدارته', L.canMessageUser(mockDirectorA, mockEmpA1) === true);
  assert('مدير الإدارة A لا يمكنه مراسلة موظف الإدارة B بلا مهمة مشتركة', L.canMessageUser(mockDirectorA, mockEmpB1) === false);

  assert('رئيس القسم A1 يمكنه مراسلة موظف في قسمه', L.canMessageUser(mockMgrA, mockEmpA1) === true);
  assert('الموظف A1 يمكنه مراسلة رئيس قسمه A1', L.canMessageUser(mockEmpA1, mockMgrA) === true);
  assert('الموظف A1 يمكنه مراسلة زميله A2 في نفس القسم', L.canMessageUser(mockEmpA1, mockEmpA2) === true);

  assert('الموظف A1 لا يمكنه مراسلة الموظف B1 في إدارة وقسم مختلفين', L.canMessageUser(mockEmpA1, mockEmpB1) === false);
  assert('الموظف A1 يمكنه مراسلة الموظف B1 عند وجود مهمة مشتركة مصرحة', L.canMessageUser(mockEmpA1, mockEmpB1, { sharedTask: true }) === true);
  assert('الموظف A1 يمكنه مراسلة B1 إذا كان ضمن قائمة المتعاونين', L.canMessageUser(mockEmpA1, mockEmpB1, { collaboratorIds: ['u-emp-b1'] }) === true);

  // 2. اختبار قاعدة البيانات والتسجيل
  console.log('\n--- اختبار تكامل قاعدة البيانات وجداول المحادثات ---');
  
  // إنشاء مستخدمين تجريبيين مؤقتين
  const testAdminId = 'test-u-adm-' + Date.now();
  const testEmpId = 'test-u-emp-' + Date.now();

  await q(
    `INSERT INTO users(id, name, email, password_hash, role, active, must_change_pw)
     VALUES($1, 'مشرف اختبار', $2, 'hash', 'admin', true, false),
           ($3, 'موظف اختبار', $4, 'hash', 'employee', true, false)`,
    [testAdminId, testAdminId + '@test.local', testEmpId, testEmpId + '@test.local']
  );

  const testConvId = 'test-conv-' + Date.now().toString(36);
  await q(
    `INSERT INTO conversations(id, type, title, created_by, last_message_at, last_message_preview, last_message_sender_id)
     VALUES($1, 'DIRECT', 'محادثة تجريبية', $2, now(), 'رسالة تجريبية', $2)`,
    [testConvId, testAdminId]
  );
  await q(
    `INSERT INTO conversation_participants(conversation_id, user_id, joined_at, last_read_at, is_active)
     VALUES($1, $2, now(), now() - interval '1 hour', true),
           ($1, $3, now(), now() - interval '1 hour', true)`,
    [testConvId, testAdminId, testEmpId]
  );

  // إرسال رسالة
  const msgInsert = await one(
    `INSERT INTO chat_messages(conversation_id, sender_id, message, created_at)
     VALUES($1, $2, $3, now()) RETURNING id`,
    [testConvId, testAdminId, 'مرحبًا بك في نظام المراسلات المعتمد']
  );
  assert('إدراج الرسالة في chat_messages بنجاح', !!msgInsert?.id);

  // إدراج مرجع مهمة
  const refInsert = await one(
    `INSERT INTO message_references(message_id, reference_type, reference_id, reference_title)
     VALUES($1, 'TASK', 'TSK-001', 'إعداد التقرير الدوري') RETURNING id`,
    [msgInsert.id]
  );
  assert('إدراج مرجع المهمة في message_references بنجاح', !!refInsert?.id);

  // فحص عداد غير المقروء للموظف
  const unreadRow = await one(
    `SELECT COUNT(m.id)::int as n
     FROM chat_messages m
     JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1
     WHERE m.conversation_id = $2
       AND m.sender_id <> $1
       AND m.deleted_at IS NULL
       AND m.created_at > cp.last_read_at`,
    [testEmpId, testConvId]
  );
  assert('عداد الرسائل غير المقروءة يظهر 1 رسالة للطرف الآخر', Number(unreadRow?.n) === 1);

  // تحديث قراءة الموظف
  await q('UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2', [testConvId, testEmpId]);
  const unreadAfter = await one(
    `SELECT COUNT(m.id)::int as n
     FROM chat_messages m
     JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1
     WHERE m.conversation_id = $2
       AND m.sender_id <> $1
       AND m.deleted_at IS NULL
       AND m.created_at > cp.last_read_at`,
    [testEmpId, testConvId]
  );
  assert('بعد تحديث last_read_at يصبح عداد غير المقروء 0', Number(unreadAfter?.n) === 0);

  // تنظيف السجلات المؤقتة
  await q('DELETE FROM conversations WHERE id=$1', [testConvId]);
  await q('DELETE FROM users WHERE id IN ($1, $2)', [testAdminId, testEmpId]);

  console.log(`\n================================`);
  console.log(`النتيجة الإجمالية: ${passed} نجح، ${failed} فشل.`);
  console.log(`================================`);
  if (failed > 0) process.exit(1);
  console.log('✔ جميع اختبارات نظام المراسلات والصلاحيات اكتملت بنجاح.');
  process.exit(0);
}

runTests().catch(err => {
  console.error('خطأ غير متوقع:', err);
  process.exit(1);
});
