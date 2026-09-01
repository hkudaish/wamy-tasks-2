#!/usr/bin/env bash
# نسخة احتياطية يومية لقاعدة البيانات والمرفقات
# الاستخدام في cron:  0 2 * * *  /opt/wamy-tasks/scripts/backup.sh >> /var/log/wamy-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

STAMP=$(date +%Y-%m-%d_%H%M)
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DIR"

echo "[$(date -Is)] بدء النسخ الاحتياطي"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$DIR/db_$STAMP.sql.gz"
echo "  ✔ قاعدة البيانات: $DIR/db_$STAMP.sql.gz"

if [ -d "${UPLOAD_DIR:-./uploads}" ]; then
  tar -czf "$DIR/files_$STAMP.tar.gz" -C "$(dirname "${UPLOAD_DIR:-./uploads}")" "$(basename "${UPLOAD_DIR:-./uploads}")"
  echo "  ✔ المرفقات: $DIR/files_$STAMP.tar.gz"
fi

find "$DIR" -name '*.gz' -mtime +"$KEEP" -delete
echo "[$(date -Is)] اكتمل النسخ الاحتياطي (يُحتفظ بـ $KEEP يومًا)"
