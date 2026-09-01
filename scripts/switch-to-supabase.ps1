<#
  تبديل التطبيق المحلي للعمل على قاعدة بيانات Supabase.

  يفعل:
   1. ينسخ .env من المجلد الأصلي إلى نسخة العمل (فتصبح مكتفية بذاتها)
   2. يرمّز كلمة المرور تلقائيًا (@ # / : وغيرها) فلا يكسر DATABASE_URL
   3. يختبر الاتصال بـ Supabase ويقارن البيانات بالمحلية قبل أي تبديل
   4. يحتفظ بالرابط المحلي معلّقًا في .env للرجوع السريع
   5. يعيد تشغيل الخادم ويتحقق من صحته

  الاستخدام:
    .\scripts\switch-to-supabase.ps1 -DbPassword 'كلمة-المرور-الجديدة'
    .\scripts\switch-to-supabase.ps1 -DbPassword '...' -Revert     # للرجوع للمحلية
#>
param(
  [Parameter(Mandatory = $false)][string]$DbPassword,
  [switch]$Revert,
  [string]$PoolerHost = 'aws-0-eu-west-2.pooler.supabase.com',
  [int]$PoolerPort    = 5432,
  [string]$DbUser     = 'postgres.vnakykapjlihzrdzpdpo'
)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$bin    = 'C:\Program Files\PostgreSQL\18\bin'
$envNew = Join-Path $root '.env'
$envOld = 'D:\wamy-tasks\.env'
$env:PGCONNECT_TIMEOUT = '20'

function Read-EnvLines {
  if (Test-Path $envNew) { return Get-Content $envNew }
  if (Test-Path $envOld) { Write-Host "  نسخ .env من $envOld"; return Get-Content $envOld }
  throw 'لم يُعثر على ملف .env في أي من المسارين.'
}
function Set-EnvKey([string[]]$lines, [string]$key, [string]$value) {
  $found = $false
  $out = foreach ($l in $lines) {
    if ($l -match "^\s*$key\s*=") { $found = $true; "$key=$value" } else { $l }
  }
  if (-not $found) { $out = @($out) + "$key=$value" }
  return $out
}
function Stop-App {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server/index.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Milliseconds 800
}
function Start-App {
  Push-Location $root
  Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WindowStyle Hidden `
    -RedirectStandardOutput '.runtime\app.log' -RedirectStandardError '.runtime\app-error.log'
  Pop-Location
  Start-Sleep -Seconds 6
}
function Test-Health {
  try { $r = Invoke-WebRequest 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 12; return $r.Content }
  catch { return "فشل: $($_.Exception.Message)" }
}

$lines = Read-EnvLines

# ---------- الرجوع إلى المحلية ----------
if ($Revert) {
  $saved = ($lines | Where-Object { $_ -match '^#\s*LOCAL_DATABASE_URL=' } | Select-Object -First 1)
  if (-not $saved) { throw 'لا يوجد رابط محلي محفوظ في .env (سطر # LOCAL_DATABASE_URL=).' }
  $localUrl = $saved -replace '^#\s*LOCAL_DATABASE_URL=', ''
  $lines = Set-EnvKey $lines 'DATABASE_URL' $localUrl
  $lines = Set-EnvKey $lines 'PG_SSL' 'false'
  Set-Content -Path $envNew -Value $lines -Encoding UTF8
  Write-Host 'أُعيد DATABASE_URL إلى القاعدة المحلية.'
  Stop-App; Start-App
  Write-Host "الصحة: $(Test-Health)"
  return
}

if (-not $DbPassword) { throw 'مرّر -DbPassword أو استخدم -Revert.' }

# ---------- بناء الرابط مع ترميز آمن ----------
Add-Type -AssemblyName System.Web
$encPw   = [System.Web.HttpUtility]::UrlEncode($DbPassword)
$supaUrl = "postgresql://$DbUser`:$encPw@$PoolerHost`:$PoolerPort/postgres"
if ($encPw -ne $DbPassword) { Write-Host '  رُمِّزت رموز خاصة في كلمة المرور تلقائيًا' }

# ---------- التحقق قبل التبديل ----------
Write-Host '— اختبار الاتصال بـ Supabase…'
$env:PGPASSWORD = $DbPassword
$n = & "$bin\psql.exe" -h $PoolerHost -p $PoolerPort -U $DbUser -d postgres -t -A -c 'SELECT count(*) FROM users;' 2>&1
if ($LASTEXITCODE -ne 0) { throw "تعذّر الاتصال بـ Supabase: $n" }
Write-Host "  متصل ✔ — المستخدمون في Supabase: $n"

$localLine = ($lines | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1)
$localUrl  = $localLine -replace '^\s*DATABASE_URL\s*=', ''
if ($localUrl -like '*supabase*') { Write-Host '  تنبيه: DATABASE_URL يشير إلى Supabase أصلًا.' -ForegroundColor Yellow }
else {
  $env:PGPASSWORD = 'WamyLocalDb_8vN4pQ2k'
  $nl = & "$bin\psql.exe" -h 127.0.0.1 -p 55432 -U wamy -d wamy_tasks -t -A -c 'SELECT count(*) FROM users;' 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  المستخدمون في المحلية    : $nl"
    if ($nl -ne $n) { Write-Host '  تنبيه: العددان مختلفان — البيانات متشعّبة.' -ForegroundColor Yellow }
  }
}

# ---------- التبديل ----------
Write-Host '— تحديث .env…'
if (-not ($lines | Where-Object { $_ -match '^#\s*LOCAL_DATABASE_URL=' })) {
  $lines = @("# LOCAL_DATABASE_URL=$localUrl") + $lines
}
$lines = Set-EnvKey $lines 'DATABASE_URL' $supaUrl
$lines = Set-EnvKey $lines 'PG_SSL' 'true'
Set-Content -Path $envNew -Value $lines -Encoding UTF8
Write-Host "  كُتب: $envNew"

Write-Host '— إعادة تشغيل الخادم…'
Stop-App; Start-App
$health = Test-Health
Write-Host "  الصحة: $health"
if ($health -notmatch '"db":true') { throw 'الخادم لا يتصل بقاعدة البيانات — راجع .runtime\app-error.log' }

Write-Host ''
Write-Host 'تم التبديل. التطبيق يعمل الآن على Supabase.'
Write-Host 'للرجوع: .\scripts\switch-to-supabase.ps1 -Revert'
$env:PGPASSWORD = $null
