#!/usr/bin/env bash
# استعادة نسخة احتياطية — يوقف الخدمة أولًا
# الاستخدام: scripts/restore.sh backups/db_2026-08-18_0200.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
FILE="${1:?حدد ملف النسخة الاحتياطية}"
read -rp "سيُستبدل محتوى قاعدة البيانات بالكامل. اكتب YES للمتابعة: " a
[ "$a" = "YES" ] || { echo "أُلغيت العملية."; exit 1; }
gunzip -c "$FILE" | psql "$DATABASE_URL"
echo "✔ تمت الاستعادة."
