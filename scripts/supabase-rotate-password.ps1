<#
  تبديل كلمة مرور قاعدة بيانات Supabase.

  يولّد كلمة قوية (28 محرفًا، حروف وأرقام فقط — بلا رموز تكسر DATABASE_URL)،
  يطبّقها، يتحقق أن القديمة لم تعد تعمل والجديدة تعمل، ثم يعرضها مرة واحدة
  ويحفظها في ملف على جهازك.

  الاستخدام:
    .\scripts\supabase-rotate-password.ps1 -CurrentPassword 'الكلمة-الحالية'
    .\scripts\supabase-rotate-password.ps1 -CurrentPassword '...' -NewPassword 'كلمتك-المختارة'
#>
param(
  [Parameter(Mandatory = $true)][string]$CurrentPassword,
  [string]$NewPassword,
  [string]$Host_    = 'aws-0-eu-west-2.pooler.supabase.com',
  [int]$Port        = 5432,
  [string]$User     = 'postgres.vnakykapjlihzrdzpdpo',
  [string]$Database = 'postgres',
  [string]$OutFile  = "$env:USERPROFILE\supabase-db-password.txt"
)

$ErrorActionPreference = 'Stop'
$bin = 'C:\Program Files\PostgreSQL\18\bin'
if (-not (Test-Path "$bin\psql.exe")) { throw "لم يُعثر على psql في: $bin" }
$env:PGCONNECT_TIMEOUT = '20'

function Try-Connect([string]$pw) {
  $env:PGPASSWORD = $pw
  & "$bin\psql.exe" -h $Host_ -p $Port -U $User -d $Database -t -A -c 'SELECT 1;' *> $null
  return ($LASTEXITCODE -eq 0)
}

Write-Host '— التحقق من الكلمة الحالية…'
if (-not (Try-Connect $CurrentPassword)) { throw 'الكلمة الحالية غير صحيحة أو تعذّر الاتصال.' }
Write-Host '  صحيحة ✔'

if (-not $NewPassword) {
  $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $buf = New-Object byte[] 28
  $rng.GetBytes($buf)
  $NewPassword = -join ($buf | ForEach-Object { $chars[$_ % $chars.Length] })
  Write-Host '  وُلِّدت كلمة جديدة (28 محرفًا، حروف وأرقام فقط)'
}
if ($NewPassword.Length -lt 12) { throw 'الكلمة الجديدة قصيرة — 12 محرفًا على الأقل.' }
if ($NewPassword -match "[`"'\\]") { throw 'تجنّب علامات الاقتباس والشرطة العكسية في الكلمة.' }

Write-Host '— تطبيق التغيير…'
$env:PGPASSWORD = $CurrentPassword
& "$bin\psql.exe" -h $Host_ -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 `
  -c "ALTER USER postgres WITH PASSWORD '$NewPassword';"
if ($LASTEXITCODE -ne 0) { throw 'فشل تنفيذ ALTER USER.' }

Write-Host '— التحقق بعد التغيير…'
Start-Sleep -Seconds 3
$oldWorks = Try-Connect $CurrentPassword
$newWorks = Try-Connect $NewPassword
Write-Host ("  القديمة ما زالت تعمل؟ {0}" -f $(if ($oldWorks) { 'نعم ✘ (المتوقع: لا)' } else { 'لا ✔' }))
Write-Host ("  الجديدة تعمل؟        {0}" -f $(if ($newWorks) { 'نعم ✔' } else { 'لا ✘' }))
if (-not $newWorks) { throw 'الكلمة الجديدة لا تعمل — راجع لوحة Supabase فورًا.' }

Set-Content -Path $OutFile -Value $NewPassword -NoNewline -Encoding UTF8
Write-Host ''
Write-Host '════════════════════════════════════════'
Write-Host " كلمة المرور الجديدة: $NewPassword"
Write-Host '════════════════════════════════════════'
Write-Host " حُفظت في: $OutFile"
Write-Host ''
Write-Host 'ضعها في DATABASE_URL هكذا (بلا ترميز — حروف وأرقام فقط):'
Write-Host "  postgresql://$User`:$NewPassword@$Host_`:6543/postgres   ← للتطبيق (Transaction pooler)"
Write-Host "  postgresql://$User`:$NewPassword@$Host_`:5432/postgres   ← للنسخ والاستعادة"
$env:PGPASSWORD = $null
