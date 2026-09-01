# نظام إدارة ومتابعة المهام — الندوة العالمية للشباب الإسلامي

نظام داخلي لإدارة المهام ومتابعة الأداء. عربي بالكامل (RTL)، يعمل على خادم المنظمة، وبياناته في قاعدة بيانات PostgreSQL.

> **هذا المستند موجّه لفريق تقنية المعلومات.** المستخدم النهائي لا يحتاج منه شيئًا.

---

## 1. المتطلبات

| المكوّن | الحد الأدنى | الموصى به |
|---|---|---|
| نظام التشغيل | Ubuntu 22.04 / RHEL 9 | Ubuntu 24.04 LTS |
| Node.js | 20 | 20 LTS |
| PostgreSQL | 14 | 16 |
| المعالج / الذاكرة | 2 vCPU / 2 GB | 2 vCPU / 4 GB |
| القرص | 20 GB | 40 GB (يتوسع مع المرفقات) |
| الشبكة | داخلي فقط | خلف Nginx + شهادة TLS |

النظام مصمَّم لعدد مستخدمين يقاس بالعشرات لا الآلاف؛ خادم واحد يكفي تمامًا.

---

## 2. التشغيل السريع بـ Docker (الأسهل)

```bash
git clone <المستودع> /opt/wamy-tasks && cd /opt/wamy-tasks
cp .env.example .env

# 1) أنشئ مفتاح الجلسات وكلمة مرور قاعدة البيانات
openssl rand -hex 32                      # ضعه في SESSION_SECRET
openssl rand -base64 24                   # ضعه في POSTGRES_PASSWORD

# 2) عدّل .env: ADMIN_EMAIL و ADMIN_PASSWORD و APP_URL و ALLOWED_DOMAIN
nano .env

# 3) شغّل
docker compose up -d --build

# 4) هيّئ قاعدة البيانات وأنشئ حساب مدير النظام
docker compose exec app npm run setup
```

النظام الآن على `http://127.0.0.1:3000`. ضع أمامه Nginx (القسم 4).

**لبيانات اختبار قبول (35 مهمة و12 مستخدمًا):** `docker compose exec app npm run seed -- --demo`
لا تُشغّل هذا الأمر على بيئة الإنتاج الفعلية.

---

## 3. التشغيل المباشر بدون Docker

```bash
sudo apt install -y nodejs npm postgresql postgresql-client
sudo -u postgres psql -c "CREATE USER wamy WITH PASSWORD 'كلمة_مرور_قوية';"
sudo -u postgres psql -c "CREATE DATABASE wamy_tasks OWNER wamy;"

cd /opt/wamy-tasks
npm ci --omit=dev
cp .env.example .env && nano .env      # DATABASE_URL و SESSION_SECRET و ADMIN_*
npm run setup
```

تشغيل كخدمة نظام — `/etc/systemd/system/wamy-tasks.service`:

```ini
[Unit]
Description=WAMY Tasks
After=network.target postgresql.service

[Service]
Type=simple
User=wamy
WorkingDirectory=/opt/wamy-tasks
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now wamy-tasks
sudo systemctl status wamy-tasks
```

---

## 4. Nginx وشهادة TLS

```nginx
server {
  listen 443 ssl http2;
  server_name tasks.wamy.org;

  ssl_certificate     /etc/letsencrypt/live/tasks.wamy.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tasks.wamy.org/privkey.pem;

  client_max_body_size 25m;          # يجب أن يتجاوز MAX_UPLOAD_MB

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
server { listen 80; server_name tasks.wamy.org; return 301 https://$host$request_uri; }
```

> بعد تفعيل HTTPS اضبط `COOKIE_SECURE=true` في `.env` وأعد التشغيل. **بدون HTTPS لا تُشغّل النظام خارج الشبكة الداخلية.**

---

## 4ب. إنشاء حسابات الموظفين (استيراد دفعة واحدة)

بعد أول دخول لمدير النظام: **المستخدمون والصلاحيات ← ⇪ استيراد قائمة**.

1. نزّل القالب أو الصق الأعمدة مباشرة من Excel.
2. الأعمدة: `الاسم` و`البريد الإلكتروني` (إلزاميان)، ثم `الإدارة` و`الدور` و`المسمى الوظيفي` (اختيارية).
3. اضغط **① فحص القائمة** — لا يُنشأ شيء، ويُعرض تشخيص لكل صف على حدة.
4. صحّح الأخطاء ثم **② إنشاء الحسابات**.
5. **نزّل ملف بيانات الدخول فورًا** — كلمات المرور لا تظهر مرة أخرى.

القواعد المفروضة على الخادم: البريد على النطاق المعتمد فقط · لا تكرار · الإدارة يجب أن تكون مسجّلة مسبقًا · كل حساب يُطالَب بتغيير كلمة المرور عند أول دخول.

---

## 5. البريد الإلكتروني

اترك `SMTP_HOST` فارغًا لتعطيل البريد — يعمل النظام كاملًا بالتنبيهات الداخلية فقط.
لتفعيله املأ بيانات SMTP في `.env`، ثم اختبر من: **لوحة التحكم ← الأمان** أو عبر `GET /api/admin/mail/test`.
اختيار القنوات (داخل النظام / بريد) لكل نوع تنبيه يتم من **لوحة التحكم ← التنبيهات** دون إعادة تشغيل.

---

## 6. النسخ الاحتياطي والاستعادة

```bash
# جدولة يومية 2 فجرًا
sudo crontab -e
0 2 * * * /opt/wamy-tasks/scripts/backup.sh >> /var/log/wamy-backup.log 2>&1
```

يحفظ السكربت نسخة مضغوطة من قاعدة البيانات ومجلد المرفقات في `backups/`، ويحذف ما تجاوز 30 يومًا (يُضبط بـ `BACKUP_KEEP_DAYS`).

**الاستعادة:**
```bash
sudo systemctl stop wamy-tasks
./scripts/restore.sh backups/db_2026-08-18_0200.sql.gz
sudo systemctl start wamy-tasks
```

> **انسخ ملفات `backups/` إلى مخزن خارج الخادم.** نسخة احتياطية على القرص نفسه ليست نسخة احتياطية.

مدير النظام يستطيع أيضًا تنزيل نسخة فورية من داخل النظام (لوحة التحكم ← النسخ الاحتياطي)، وهي **لا تُغني** عن الجدولة.

---

## 7. الأمان المطبَّق

| الضابط | التنفيذ |
|---|---|
| تقييد نطاق البريد | يُفرض على **الخادم** قبل التحقق من كلمة المرور، وقابل للتعديل من لوحة التحكم |
| تشفير كلمات المرور | bcrypt بـ 12 جولة |
| الجلسات | JWT في كوكي `httpOnly` + `SameSite=Lax` + `Secure` على HTTPS |
| انتهاء الخمول | متدحرج: تُجدَّد الجلسة مع كل طلب وتنتهي بعد `idleMinutes` |
| قفل المحاولات | إيقاف مؤقت بعد 5 محاولات فاشلة خلال 15 دقيقة |
| تحديد المعدل | 30 محاولة دخول / 15 دقيقة، و600 طلب / دقيقة لكل عنوان |
| الصلاحيات RBAC | تُفرض في **استعلامات قاعدة البيانات** لا في الواجهة — لا يمكن تجاوزها بتعديل المتصفح |
| منطق العمل | التأخير والتقييم والتكرار والاعتماد كلها على الخادم؛ العميل يعرض فقط |
| «متأخرة» | حالة محسوبة، يرفض الخادم إسنادها يدويًا (منع تجميل المؤشرات) |
| التمديد وإعادة الفتح | يرفضهما الخادم بلا سبب مكتوب |
| سجل النشاط | جدول `activity` للإضافة فقط، يشمل الإجراءات الإدارية |
| المرفقات | فحص النوع والحجم، تُخزَّن بأسماء عشوائية خارج مسار عام، وتُقدَّم بعد فحص الصلاحية |
| ترويسات HTTP | Helmet + CSP يمنع السكربتات الخارجية و`frame-ancestors 'none'` |
| الحذف | حذف المستخدم = تعطيل، حفاظًا على السجل التاريخي |

**نقطة مفتوحة موثّقة:** الواجهة تستخدم معالِجات أحداث مضمّنة (`onclick`)، لذا يسمح CSP بـ `script-src-attr 'unsafe-inline'`. التخفيف: كل نص من المستخدم يمر عبر ترميز HTML قبل الإدراج، ولا تُحمَّل أي سكربتات خارجية. إن تطلبت سياسة أمن المعلومات لديكم CSP صارمًا بالكامل، فالمعالجة هي تحويل المعالِجات إلى مستمعات مفوَّضة (عمل مقدَّر بيوم إلى يومين).

**المرحلة التالية المقترحة أمنيًا:** التحقق بخطوتين (2FA) أو الربط بـ SSO المؤسسي — البنية جاهزة لاستقبالهما.

---

## 8. البنية

```
server/
  index.js      إقلاع Express، الترويسات الأمنية، تحديد المعدل
  db.js         تجمّع اتصالات PostgreSQL + الإعدادات
  schema.sql    مخطط قاعدة البيانات
  auth.js       المصادقة والجلسات والقفل وسياسة كلمة المرور
  logic.js      منطق العمل: التأخير، التقييم، الصلاحيات
  routes.js     المهام والتعليقات والمرفقات والتنبيهات
  admin.js      المستخدمون والقوائم والإعدادات والهوية والنسخ الاحتياطي
  mailer.js     التنبيهات البريدية (SMTP اختياري)
  scheduler.js  التنبيهات اليومية والتنظيف
  seed.js       التهيئة وبيانات الاختبار
public/index.html   الواجهة (صفحة واحدة، عربية RTL، خط دبي مدمج)
scripts/            النسخ الاحتياطي والاستعادة
assets/             الشعار
```

## 9. واجهات API الرئيسية

| المسار | الوصف |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | الجلسة |
| `GET /api/bootstrap` | القوائم المرجعية والإعدادات والهوية والمستخدمون |
| `GET/POST /api/tasks` · `PATCH/DELETE /api/tasks/:id` | المهام |
| `POST /api/tasks/:id/action` | كل إجراءات العمل (الحالة، الإنجاز، الاعتماد، التمديد، إعادة الإسناد…) |
| `POST /api/tasks/:id/comments` · `/subtasks` · `/attachments` | التعاون |
| `GET /api/notifications` · `POST /api/notifications/read` | التنبيهات |
| `GET /api/activity` | سجل النشاط |
| `/api/admin/*` | المستخدمون والقوائم والإعدادات والهوية وسجل الدخول والنسخة الاحتياطية |
| `GET /api/health` | فحص الصحة (للمراقبة) |

## 10. المراقبة والصيانة

- **الصحة:** راقب `GET /api/health` — يعيد `503` عند تعذّر الوصول لقاعدة البيانات.
- **السجلات:** `journalctl -u wamy-tasks -f` أو `docker compose logs -f app`.
- **التحديث:** `git pull && npm ci --omit=dev && npm run migrate && systemctl restart wamy-tasks` — المخطط تراكمي وآمن على البيانات.
- **المساحة:** راقب مجلد المرفقات؛ الحجم الأقصى للملف يُضبط بـ `MAX_UPLOAD_MB`.

## 11. أول تشغيل — قائمة تحقق

- [ ] `SESSION_SECRET` عشوائي 32 بايت، و`COOKIE_SECURE=true` خلف HTTPS
- [ ] `ADMIN_PASSWORD` قوية، وتُغيَّر من داخل النظام بعد أول دخول
- [ ] `ALLOWED_DOMAIN` = نطاق بريد وامي الرسمي
- [ ] الوصول مقيَّد بالشبكة الداخلية أو VPN
- [ ] النسخ الاحتياطي مجدول ويُنسخ خارج الخادم، وجُرِّبت **الاستعادة** فعليًا
- [ ] رفع الشعار الرسمي وضبط الألوان من: لوحة التحكم ← الهوية البصرية
- [ ] إنشاء المستخدمين وضبط الإدارات والتصنيفات
- [ ] عدم تشغيل `seed --demo` على بيئة الإنتاج
