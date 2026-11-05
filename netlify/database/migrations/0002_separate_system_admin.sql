-- فصل حساب مدير النظام عن بيانات الموظفين وهيكل الإدارة.
-- الحساب: hkudaish@gmail.com — كلمة المرور الابتدائية مطابقة للبريد ويمكن تغييرها من الملف الشخصي.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  aid TEXT;
  old_emp TEXT;
BEGIN
  SELECT id, employee_no INTO aid, old_emp FROM users
   WHERE role = 'admin'
   ORDER BY (lower(email) = 'hkudaish@gmail.com') DESC, created_at
   LIMIT 1;
  IF aid IS NULL THEN RETURN; END IF;

  -- لا يظهر مدير النظام في قوائم الهيكل ولا مديرًا لأي إدارة أو قسم
  DELETE FROM structure_people
   WHERE linked_user_id IN (SELECT id FROM users WHERE role = 'admin')
      OR (old_emp IS NOT NULL AND lower(employee_no) = lower(old_emp));
  UPDATE organizations SET director_id = NULL WHERE director_id IN (SELECT id FROM users WHERE role = 'admin');
  UPDATE departments   SET head_id     = NULL WHERE head_id     IN (SELECT id FROM users WHERE role = 'admin');
  UPDATE users SET manager_id = NULL WHERE manager_id IN (SELECT id FROM users WHERE role = 'admin');

  IF NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = 'hkudaish@gmail.com' AND id <> aid) THEN
    UPDATE users
       SET email = 'hkudaish@gmail.com',
           password_hash = crypt('hkudaish@gmail.com', gen_salt('bf', 12)),
           must_change_pw = false,
           active = true
     WHERE id = aid;
  END IF;

  -- الرقم الوظيفي والإدارة والقسم تخص الموظفين فقط
  UPDATE users SET employee_no = NULL, organization_id = NULL, dept_id = NULL WHERE role = 'admin';
END
$$;
