'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✔ تم إنشاء/تحديث مخطط قاعدة البيانات بنجاح.');
  } catch (e) {
    console.error('✖ فشل إنشاء المخطط:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
