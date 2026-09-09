'use strict';
/** تخزين المرفقات على القرص المحلي فقط. */
const fs = require('fs');
const path = require('path');

const DRIVER = 'local';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function localPath(key) {
  const name = String(key || '');
  if (!name || path.basename(name) !== name) throw new Error('اسم ملف التخزين غير صالح.');
  return path.join(UPLOAD_DIR, name);
}

function newKey(_taskId, originalName) {
  const ext = path.extname(originalName || '').slice(0, 12).replace(/[^\w.]/g, '');
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext;
}

async function save(buffer, key) {
  await fs.promises.writeFile(localPath(key), buffer);
  return key;
}

async function serve(res, key, originalName) {
  return res.download(localPath(key), originalName);
}

async function remove(key) {
  await fs.promises.unlink(localPath(key)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function listAll() {
  const entries = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function purgeAll() {
  const keys = await listAll();
  await Promise.all(keys.map(remove));
  return keys.length;
}

module.exports = { DRIVER, newKey, save, serve, remove, purgeAll, listAll, UPLOAD_DIR };
