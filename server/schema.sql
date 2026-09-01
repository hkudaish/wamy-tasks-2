-- ============================================================
-- نظام إدارة ومتابعة المهام — الندوة العالمية للشباب الإسلامي
-- مخطط قاعدة البيانات (PostgreSQL 14+)
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  sort  INT NOT NULL DEFAULT 0
);
INSERT INTO organizations(id,name,sort) VALUES('org-default','الإدارة العامة',0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS departments (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  sort  INT  NOT NULL DEFAULT 0,
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT DEFAULT 'org-default'
);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT DEFAULT 'org-default';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS code TEXT;
UPDATE departments SET organization_id='org-default' WHERE organization_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(organization_id);
-- إخفاء قسم وكل منسوبيه من قوائم المستخدمين والمهام (يضبطه مدير النظام من لوحة التحكم)
ALTER TABLE departments ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_departments_hidden ON departments(hidden) WHERE hidden;

CREATE TABLE IF NOT EXISTS categories (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  sort  INT  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS statuses (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  cls      TEXT NOT NULL DEFAULT 'b-gray',
  color    TEXT NOT NULL DEFAULT 'var(--gray)',
  is_open  BOOLEAN NOT NULL DEFAULT TRUE,
  sort     INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS priorities (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  cls    TEXT NOT NULL DEFAULT 'b-gray',
  color  TEXT NOT NULL DEFAULT 'var(--gray)',
  rank   INT  NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT DEFAULT '',
  notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  password_hash  TEXT NOT NULL,
  dept_id        TEXT REFERENCES departments(id) ON DELETE SET NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin','director','manager','employee')),
  title          TEXT DEFAULT '',
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_pw BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));
CREATE INDEX IF NOT EXISTS idx_users_dept  ON users(dept_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_no TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE users u SET organization_id=d.organization_id FROM departments d
WHERE u.dept_id=d.id AND u.organization_id IS NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','secretary_general','assistant_secretary_general','director','consultant','manager','employee'));
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_code ON organizations(lower(code)) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_org_code ON departments(organization_id,lower(code)) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_no ON users(lower(employee_no)) WHERE employee_no IS NOT NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS director_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS head_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- سجل الهيكل الإداري مستقل عن حسابات الدخول. يمكن لمسؤول النظام إنشاء الحساب لاحقًا
-- من السجل نفسه، دون إعادة إدخال بيانات الموظف.
CREATE TABLE IF NOT EXISTS structure_people (
  id TEXT PRIMARY KEY,
  employee_no TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  title TEXT DEFAULT '',
  suggested_role TEXT NOT NULL DEFAULT 'employee',
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  dept_id TEXT REFERENCES departments(id) ON DELETE CASCADE,
  manager_employee_no TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_structure_people_employee_no ON structure_people(lower(employee_no));
INSERT INTO structure_people(id,employee_no,name,email,phone,title,suggested_role,organization_id,dept_id,active,linked_user_id)
SELECT 'sp-'||u.id,u.employee_no,u.name,u.email,u.phone,u.title,u.role,u.organization_id,u.dept_id,u.active,u.id
FROM users u WHERE u.employee_no IS NOT NULL AND u.role<>'admin'
ON CONFLICT (lower(employee_no)) DO UPDATE SET linked_user_id=EXCLUDED.linked_user_id;
DELETE FROM structure_people WHERE linked_user_id IN (SELECT id FROM users WHERE role='admin');
UPDATE users SET employee_no=NULL,dept_id=NULL,organization_id=NULL,manager_id=NULL WHERE role='admin';

CREATE TABLE IF NOT EXISTS custom_fields (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL,
  required  BOOLEAN NOT NULL DEFAULT FALSE,
  cats      JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort      INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  priority_id   TEXT NOT NULL REFERENCES priorities(id),
  category_id   TEXT NOT NULL REFERENCES categories(id),
  dept_id       TEXT REFERENCES departments(id) ON DELETE SET NULL,
  assignee_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  status_id     TEXT NOT NULL REFERENCES statuses(id),
  created_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  start_date    DATE NOT NULL,
  est_days      INT  NOT NULL DEFAULT 1 CHECK (est_days > 0),
  due_date      DATE NOT NULL,
  closed_date   DATE,
  progress      INT  NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  notes         TEXT NOT NULL DEFAULT '',
  delay_reason  TEXT NOT NULL DEFAULT '',
  quality       INT CHECK (quality BETWEEN 1 AND 5),
  recur         TEXT,
  recur_done    BOOLEAN NOT NULL DEFAULT FALSE,
  parent_recur  TEXT,
  cf            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_dept     ON tasks(dept_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_updated  ON tasks(updated_at DESC);

-- ترميز الحالة البصري الموحّد: إنشاء، تنفيذ، اكتمال بانتظار الإغلاق، ثم إغلاق.
UPDATE statuses SET cls='b-blue', color='var(--blue)' WHERE id IN ('new','notstarted');
UPDATE statuses SET cls='b-amber', color='var(--amber)' WHERE id='inprogress';
UPDATE statuses SET name='مكتملة — بانتظار الإغلاق', cls='b-green', color='var(--green)' WHERE id='approval';
UPDATE statuses SET name='مغلقة', cls='b-gray', color='var(--gray)' WHERE id='done';

CREATE TABLE IF NOT EXISTS subtasks (
  id       BIGSERIAL PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  done     BOOLEAN NOT NULL DEFAULT FALSE,
  sort     INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);

CREATE TABLE IF NOT EXISTS comments (
  id         BIGSERIAL PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  parent_id  BIGINT REFERENCES comments(id) ON DELETE CASCADE,
  mentions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          BIGSERIAL PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL,
  orig_name   TEXT NOT NULL,
  size        BIGINT NOT NULL,
  mime        TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_att_task ON attachments(task_id);

CREATE TABLE IF NOT EXISTS extensions (
  id         BIGSERIAL PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_date  DATE NOT NULL,
  to_date    DATE NOT NULL,
  reason     TEXT NOT NULL,
  by_user    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ext_task ON extensions(task_id);

-- سجل النشاط: غير قابل للتعديل أو الحذف (تمنعه الصلاحيات على مستوى قاعدة البيانات)
CREATE TABLE IF NOT EXISTS activity (
  id         BIGSERIAL PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity(created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  to_user    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ,
  emailed    BOOLEAN NOT NULL DEFAULT FALSE,
  sms_sent   BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(to_user, created_at DESC);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sms_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS whatsapp_sent BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  ok         BOOLEAN NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_email ON login_attempts(lower(email), created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id      BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filters_user ON saved_filters(user_id);

-- ============================================================
-- الفعاليات والمناسبات
-- ============================================================
CREATE TABLE IF NOT EXISTS event_types (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort        INT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_types_name ON event_types(lower(name));

INSERT INTO event_types(id,name,description,sort,active) VALUES
('evt-type-01','ملتقى','لقاء واسع يجمع مهتمين أو مختصين حول محور محدد',1,true),
('evt-type-02','منتدى','جلسات حوارية أو نقاشية منظمة',2,true),
('evt-type-03','دورة تدريبية','برنامج تعليمي أو تدريبي',3,true),
('evt-type-04','ورشة عمل','نشاط تطبيقي قصير ومكثف',4,true),
('evt-type-05','قافلة طبية','أنشطة رعاية وخدمة صحية ميدانية',5,true),
('evt-type-06','احتفال','مناسبة احتفالية أو تكريمية',6,true),
('evt-type-07','رحلة أو طلعة اجتماعية','نشاط اجتماعي أو ترفيهي',7,true),
('evt-type-08','مؤتمر','تجمع علمي أو تنظيمي واسع',8,true),
('evt-type-09','معرض','عرض منتجات أو إنجازات أو محتوى',9,true),
('evt-type-10','زيارة','زيارة رسمية أو ميدانية',10,true),
('evt-type-11','حملة','حملة توعوية أو ميدانية',11,true),
('evt-type-12','برنامج','برنامج منظم متعدد الأنشطة',12,true),
('evt-type-13','فعالية مجتمعية','مناسبة ذات أثر مجتمعي مباشر',13,true),
('evt-type-14','أخرى','أي فعالية أو مناسبة أخرى',14,true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  type_id           TEXT NOT NULL REFERENCES event_types(id) ON DELETE RESTRICT,
  summary           TEXT NOT NULL DEFAULT '',
  organizer_dept_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  start_at          TIMESTAMPTZ NOT NULL,
  end_at            TIMESTAMPTZ,
  duration_value    NUMERIC(10,2),
  duration_unit     TEXT NOT NULL DEFAULT 'day',
  country           TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  location          TEXT NOT NULL DEFAULT '',
  participants      JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes             TEXT NOT NULL DEFAULT '',
  cancelled_at      TIMESTAMPTZ,
  notified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type_id);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(organizer_dept_id);
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 0;
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE events ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS organizer_dept_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS duration_value NUMERIC(10,2);
ALTER TABLE events ADD COLUMN IF NOT EXISTS duration_unit TEXT NOT NULL DEFAULT 'day';
ALTER TABLE events ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE events ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- تحديث updated_at تلقائيًا
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_touch ON tasks;
CREATE TRIGGER trg_tasks_touch BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_events_touch ON events;
CREATE TRIGGER trg_events_touch BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============================================================
-- الإجراءات التنفيذية داخل المهمة (إضافة 2026-08)
-- كل إجراء له إطار زمني مستقل: بدء، مدة متوقعة، إنجاز مستهدف
-- ============================================================
CREATE TABLE IF NOT EXISTS steps (
  id            BIGSERIAL PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  start_date    DATE,
  duration_days INT CHECK (duration_days IS NULL OR duration_days > 0),
  due_date      DATE,
  done_date     DATE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','doing','done','blocked')),
  owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  sort          INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_steps_task ON steps(task_id, sort);

-- توقيت دقيق ومدة متعددة الوحدات، مع إبقاء حقول التاريخ القديمة للتوافق.
ALTER TABLE steps ADD COLUMN IF NOT EXISTS start_at       TIMESTAMPTZ;
ALTER TABLE steps ADD COLUMN IF NOT EXISTS duration_value NUMERIC(10,2);
ALTER TABLE steps ADD COLUMN IF NOT EXISTS duration_unit  TEXT NOT NULL DEFAULT 'day';
ALTER TABLE steps ADD COLUMN IF NOT EXISTS due_at         TIMESTAMPTZ;
ALTER TABLE steps ADD COLUMN IF NOT EXISTS delay_note     TEXT NOT NULL DEFAULT '';
UPDATE steps SET duration_value=duration_days WHERE duration_value IS NULL AND duration_days IS NOT NULL;
UPDATE steps SET start_at=start_date::timestamp AT TIME ZONE 'Asia/Riyadh' WHERE start_at IS NULL AND start_date IS NOT NULL;
UPDATE steps SET due_at=(due_date::timestamp + interval '23 hours 59 minutes') AT TIME ZONE 'Asia/Riyadh' WHERE due_at IS NULL AND due_date IS NOT NULL;

-- مرجع الخطة السنوية للمهام المستوردة
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_ref  TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_year INT;
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_year, plan_ref);

-- تصحيح أسماء الإدارات المستوردة سابقًا بالنمط «الإدارة D001».
-- منع بقاء رمز الإدارة في الاسم عند ترحيل ملفات قديمة؛ الاسم النهائي يُحفظ من نطاق الهيكل المرفق.
UPDATE organizations AS o
SET name = 'اسم الإدارة غير محدد'
FROM users AS u
WHERE o.director_id = u.id
  AND btrim(o.name) = 'الإدارة ' || btrim(o.code)
  AND u.role = 'director';
