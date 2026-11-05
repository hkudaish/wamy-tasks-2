'use strict';
/** تخزين المرفقات محليًا أثناء التطوير وعلى Netlify Blobs في النشر. */
const fs = require('fs');
const path = require('path');
const { IS_NETLIFY } = require('./platform');

const DRIVER = IS_NETLIFY ? 'netlify-blobs' : 'local';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
if (DRIVER === 'local') fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function blobStore() {
  if (!process.env.NETLIFY) return null;
  return require('@netlify/blobs').getStore('wamy-uploads');
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function localPath(key) {
  const name = String(key || '');
  if (!name || path.basename(name) !== name) throw new Error('اسم ملف التخزين غير صالح.');
  return path.join(UPLOAD_DIR, name);
}

function newKey(_taskId, originalName) {
  const ext = path.extname(originalName || '').slice(0, 12).replace(/[^\w.]/g, '');
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext;
}

async function save(buffer, key, mimeType) {
  const store = blobStore();
  if (store) {
    await store.set(key, toArrayBuffer(buffer), {
      metadata: { contentType: mimeType || 'application/octet-stream' },
    });
    return key;
  }
  await fs.promises.writeFile(localPath(key), buffer);
  return key;
}

async function serve(res, key, originalName) {
  const store = blobStore();
  if (store) {
    const data = await store.get(key, { type: 'arrayBuffer' });
    const stored = await store.getMetadata(key);
    res.type(stored?.metadata?.contentType || 'application/octet-stream');
    res.attachment(originalName);
    return res.send(Buffer.from(data));
  }
  return res.download(localPath(key), originalName);
}

async function remove(key) {
  const store = blobStore();
  if (store) return store.delete(key);
  await fs.promises.unlink(localPath(key)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function listAll() {
  const store = blobStore();
  if (store) {
    const keys = [];
    for await (const page of store.list({ paginate: true })) {
      keys.push(...page.blobs.map((blob) => blob.key));
    }
    return keys;
  }
  const entries = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function purgeAll() {
  const store = blobStore();
  if (store) return (await store.deleteAll()).deletedBlobs;
  const keys = await listAll();
  await Promise.all(keys.map(remove));
  return keys.length;
}

module.exports = { DRIVER, newKey, save, serve, remove, purgeAll, listAll, UPLOAD_DIR };
