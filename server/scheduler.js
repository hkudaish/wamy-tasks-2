'use strict';
const { q, all, one, getSetting } = require('./db');
const { notify } = require('./mailer');

/**
 * مهمة يومية:
 *  1) تنبيه المهام المتأخرة والمهام التي اقترب موعدها.
 *  2) تنظيف التنبيهات القديمة المقروءة.
 * تُرسل مرة واحدة لكل مهمة في اليوم (يُمنع التكرار عبر فحص تنبيه اليوم نفسه).
 */
async function dailyDigest() {
  const cfg = await getSetting('cfg');

  const late = await all(
    `SELECT t.id, t.title, t.assignee_id, t.creator_id, t.due_date,
            (CURRENT_DATE - t.due_date) AS days
     FROM tasks t JOIN statuses s ON s.id = t.status_id
     WHERE s.is_open AND t.status_id <> 'cancelled' AND t.progress < 100 AND t.due_date < CURRENT_DATE`
  );
  for (const t of late) {
    const dup = await one(
      `SELECT 1 FROM notifications WHERE task_id=$1 AND kind='late' AND created_at::date = CURRENT_DATE LIMIT 1`, [t.id]
    );
    if (dup) continue;
    await notify({ kind: 'late', taskId: t.id, actorId: null, to: [t.assignee_id, t.creator_id],
      body: `«${t.title}» متأخرة ${t.days} يومًا عن موعدها النهائي` });
  }

  const near = await all(
    `SELECT t.id, t.title, t.assignee_id, (t.due_date - CURRENT_DATE) AS days
     FROM tasks t JOIN statuses s ON s.id = t.status_id
     WHERE s.is_open AND t.status_id <> 'cancelled' AND t.progress < 100
       AND t.due_date >= CURRENT_DATE AND t.due_date <= CURRENT_DATE + $1::int`,
    [Number(cfg.nearDueDays) || 3]
  );
  for (const t of near) {
    const dup = await one(
      `SELECT 1 FROM notifications WHERE task_id=$1 AND kind='near' AND created_at::date = CURRENT_DATE LIMIT 1`, [t.id]
    );
    if (dup) continue;
    await notify({ kind: 'near', taskId: t.id, actorId: null, to: [t.assignee_id],
      body: `«${t.title}» تستحق خلال ${t.days} يوم` });
  }

  await q(`DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '120 days'`);
  await q(`DELETE FROM login_attempts WHERE created_at < now() - interval '180 days'`);
  console.log(`[scheduler] التنبيهات اليومية: ${late.length} متأخرة، ${near.length} وشيكة`);
}

/** يعمل عند الإقلاع ثم كل ساعة، وينفّذ فعليًا مرة واحدة في اليوم عند الساعة المحددة */
function startScheduler() {
  const HOUR = Number(process.env.DIGEST_HOUR || 7); // بتوقيت الخادم
  let lastRun = null;
  const tick = async () => {
    try {
      const now = new Date();
      const key = now.toISOString().slice(0, 10);
      if (now.getHours() >= HOUR && lastRun !== key) { lastRun = key; await dailyDigest(); }
    } catch (e) { console.error('[scheduler]', e.message); }
  };
  setTimeout(tick, 15000);
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = { startScheduler, dailyDigest };
