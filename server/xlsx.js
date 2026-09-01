'use strict';
/**
 * قارئ XLSX مصغّر بلا اعتماديات خارجية.
 * ملف XLSX هو أرشيف ZIP يحتوي XML؛ نقرأ الفهرس المركزي ثم نفكّ الضغط بـ zlib،
 * ونستخرج القيم المخزّنة (بما فيها النتائج المحفوظة للصيغ).
 * كُتب داخليًا بدل حزمة خارجية لتقليل حجم التبعيات وسطح المخاطر الأمنية.
 */
const zlib = require('zlib');

/* ---------------- ZIP ---------------- */
function readZip(buf) {
  // البحث عن نهاية الفهرس المركزي (EOCD)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('الملف ليس أرشيف ZIP صالحًا (XLSX تالف؟)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // الترويسة المحلية قد تختلف أطوالها عن الفهرس
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw));

    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ---------------- XML ---------------- */
const decodeEntities = (s) =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
   .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** أسماء الأوراق بترتيبها، مع ربطها بملفاتها عبر العلاقات */
function sheetIndex(files) {
  const wb = files['xl/workbook.xml']().toString('utf8');
  const relsRaw = files['xl/_rels/workbook.xml.rels'] ? files['xl/_rels/workbook.xml.rels']().toString('utf8') : '';
  const rels = {};
  for (const m of relsRaw.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0]);
    const target = /\bTarget="([^"]+)"/.exec(m[0]);
    if (!id || !target) continue;
    rels[id[1]] = target[1].replace(/^\/?xl\//, '').replace(/^\.\//, '');
  }
  const out = [];
  for (const m of wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>/g)) {
    const tag = m[0];
    const name = /name="([^"]*)"/.exec(tag);
    const rid = /r:id="([^"]+)"/.exec(tag);
    if (!name) continue;
    const target = rid && rels[rid[1]] ? 'xl/' + rels[rid[1]] : null;
    out.push({ name: decodeEntities(name[1]), path: target });
  }
  // احتياط: إن تعذّر ربط العلاقات نستخدم الترتيب الافتراضي
  out.forEach((s, i) => { if (!s.path || !files[s.path]) s.path = `xl/worksheets/sheet${i + 1}.xml`; });
  return out.filter((s) => files[s.path]);
}

function sharedStrings(files) {
  if (!files['xl/sharedStrings.xml']) return [];
  const xml = files['xl/sharedStrings.xml']().toString('utf8');
  const out = [];
  for (const si of xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
    let txt = '';
    for (const t of si[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) txt += t[1];
    out.push(decodeEntities(txt));
  }
  return out;
}

const colToNum = (ref) => {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

/** يقرأ ورقة إلى مصفوفة صفوف (كل صف مصفوفة قيم، الفهرس 0 = العمود A) */
function readSheet(files, path) {
  const xml = files[path]().toString('utf8');
  const ss = sharedStrings(files);
  const rows = [];
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)\/>|<(?:\w+:)?row\b([^>]*?)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const rowAttrs = rm[1] !== undefined ? rm[1] : rm[2];
    const rowBody = rm[3] || '';
    const rAttr = /r="(\d+)"/.exec(rowAttrs);
    const rowIdx = rAttr ? Number(rAttr[1]) - 1 : rows.length;
    const cells = [];
    let prevCol = -1;   // الخلايا بلا سمة r تتبع الخلية السابقة مباشرة (سلوك OOXML)
    // البديل الأول للخلايا ذاتية الإغلاق <c .../> والثاني للخلايا ذات المحتوى
    for (const cm of rowBody.matchAll(/<(?:\w+:)?c\b([^>]*?)\/>|<(?:\w+:)?c\b([^>]*?)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const attrs = cm[1] !== undefined ? cm[1] : cm[2];
      const body = cm[3] || '';
      const rRef = /r="([A-Z]+\d+)"/.exec(attrs);
      const ci = rRef ? colToNum(rRef[1]) - 1 : prevCol + 1;
      prevCol = ci;
      const type = (/t="([^"]+)"/.exec(attrs) || [, 'n'])[1];
      let val = null;
      if (type === 'inlineStr') {
        let txt = '';
        for (const t of body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) txt += t[1];
        val = decodeEntities(txt);
      } else {
        const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);   // <v> يحمل النتيجة المحفوظة للصيغ أيضًا
        if (v) {
          const raw = decodeEntities(v[1]);
          if (type === 's') val = ss[Number(raw)] ?? '';
          else if (type === 'b') val = raw === '1';
          else if (type === 'str' || type === 'e') val = raw;
          else { const n = Number(raw); val = Number.isFinite(n) ? n : raw; }
        }
      }
      cells[ci] = val;
    }
    rows[rowIdx] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/** الواجهة العامة: يعيد { sheets:[{name, rows}] } */
function parseXlsx(buffer) {
  const files = readZip(buffer);
  if (!files['xl/workbook.xml']) throw new Error('الملف ليس مصنّف Excel بصيغة xlsx.');
  return { sheets: sheetIndex(files).map((s) => ({ name: s.name, rows: readSheet(files, s.path) })) };
}

module.exports = { parseXlsx };
