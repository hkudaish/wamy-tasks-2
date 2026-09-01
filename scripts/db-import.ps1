param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,
  [switch]$ConfirmReplace
)

$ErrorActionPreference = "Stop"
if (-not $ConfirmReplace) {
  throw "Import replaces database content. Run again with -ConfirmReplace after verifying the target and taking a backup."
}

$resolvedBackup = (Resolve-Path -LiteralPath $BackupFile).Path
$projectRoot = Split-Path -Parent $PSScriptRoot

& docker compose --project-directory $projectRoot up -d db
if ($LASTEXITCODE -ne 0) { throw "PostgreSQL could not be started." }

Get-Content -AsByteStream -Raw -LiteralPath $resolvedBackup | & docker compose --project-directory $projectRoot exec -T db pg_restore -U wamy -d wamy_tasks --clean --if-exists --no-owner --no-acl
if ($LASTEXITCODE -ne 0) { throw "Database import failed." }

& docker compose --project-directory $projectRoot up -d app
if ($LASTEXITCODE -ne 0) { throw "The application could not be started after import." }
Write-Host "Database restored and application started."
