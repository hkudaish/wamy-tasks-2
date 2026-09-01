<#
  رفع مخطط قاعدة البيانات وبياناتها إلى Supabase.

  الاستخدام:
    .\scripts\supabase-push.ps1 -ConnectionString "postgresql://postgres:PASS@db.xxxx.supabase.co:5432/postgres"
    .\scripts\supabase-push.ps1 -ConnectionString "..." -DumpFile "backups\wamy_2026-08-31_2253.dump"

  ملاحظات مهمة:
   • استخدم اتصال «Direct connection» أو «Session pooler» (منفذ 5432).
     لا تستخدم Transaction pooler (منفذ 6543) — لا يدعم ما يحتاجه pg_restore.
   • السكربت لا يحذف شيئًا من القاعدة المحلية، ولا يغيّر DATABASE_URL.
#>
param(
  [Parameter(Mandatory = $true)][string]$ConnectionString,
  [string]$DumpFile,
  [switch]$Clean   # امسح الكائنات الموجودة في الهدف قبل الاستعادة
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin  = 'C:\Program Files\PostgreSQL\18\bin'

if (-not (Test-Path "$bin\pg_restore.exe")) { throw "لم يُعثر على أدوات PostgreSQL في: $bin" }

if (-not $DumpFile) {
  $latest = Get-ChildItem (Join-Path $root 'backups') -Filter '*.dump' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "لا توجد نسخة .dump في مجلد backups — أنشئها أولًا بـ pg_dump." }
  $DumpFile = $latest.FullName
}
if (-not (Test-Path $DumpFile)) { throw "الملف غير موجود: $DumpFile" }

Write-Host "النسخة المستخدمة : $DumpFile"
Write-Host "الحجم            : $([math]::Round((Get-Item $DumpFile).Length/1KB,1)) KB"
Write-Host ''

# 1) اختبار الاتصال قبل أي كتابة
Write-Host '— اختبار الاتصال بـ Supabase…'
$ver = & "$bin\psql.exe" $ConnectionString -t -A -c 'SELECT version();' 2>&1
if ($LASTEXITCODE -ne 0) { throw "تعذّر الاتصال: $ver" }
$verShort = ($ver -split '\(')[0]
Write-Host "  متصل ✔  $verShort"

$existing = & "$bin\psql.exe" $ConnectionString -t -A -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';" 2>&1
Write-Host "  جداول موجودة حاليًا في public: $existing"
if ([int]$existing -gt 0 -and -not $Clean) {
  Write-Host '  تنبيه: القاعدة الهدف ليست فارغة. أعد التشغيل مع -Clean لاستبدال الكائنات.' -ForegroundColor Yellow
}
Write-Host ''

# 2) الاستعادة — pg_restore يُنشئ الجداول ثم البيانات ثم المفاتيح الأجنبية بالترتيب الصحيح
Write-Host '— جارٍ الرفع…'
$rargs = @('--no-owner', '--no-acl', '--no-comments', '-d', $ConnectionString, $DumpFile)
if ($Clean) { $rargs = @('--clean', '--if-exists') + $rargs }
& "$bin\pg_restore.exe" @rargs
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host "  pg_restore انتهى بالرمز $code (قد تكون تحذيرات غير قاتلة)" -ForegroundColor Yellow }

# 3) التحقق من اكتمال البيانات
Write-Host ''
Write-Host '— التحقق من الصفوف في Supabase:'
$q = @('SELECT ''users'' t, count(*) n FROM users','UNION ALL SELECT ''departments'', count(*) FROM departments','UNION ALL SELECT ''organizations'', count(*) FROM organizations','UNION ALL SELECT ''structure_people'', count(*) FROM structure_people','UNION ALL SELECT ''tasks'', count(*) FROM tasks','UNION ALL SELECT ''events'', count(*) FROM events','UNION ALL SELECT ''settings'', count(*) FROM settings','ORDER BY 1;') -join ' '
& "$bin\psql.exe" $ConnectionString -c $q

Write-Host ''
Write-Host 'تم. القاعدة المحلية لم تتغيّر، وDATABASE_URL كما هو.'
Write-Host 'للتبديل لاحقًا: ضع رابط Supabase في DATABASE_URL ثم أعد تشغيل الخادم.'
