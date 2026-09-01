param(
  [string]$OutputDirectory = "backups"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $projectRoot $OutputDirectory
New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$targetFile = Join-Path $targetDirectory "wamy_tasks_$timestamp.dump"

& docker compose --project-directory $projectRoot exec -T db pg_dump -U wamy -d wamy_tasks -Fc --no-owner --no-acl | Set-Content -AsByteStream -Path $targetFile
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $targetFile -ErrorAction SilentlyContinue
  throw "Database export failed."
}

Write-Host "Database backup created: $targetFile"
Write-Host "This file may contain personal data. Transfer it through an encrypted channel; do not commit it to Git."
