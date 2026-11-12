// Liest Anki-Stapel: Pakete (.apkg / .colpkg, z. B. aus AnkiMobile oder AnkiDroid),
// den Text-Export ("Notizen als Text") sowie einfache Tabellen (Frage; Antwort; Fach).

const SEPARATORS = { tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':' };

function parseRows(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Bilder stehen im Kartentext als Marke ⟦img:dateiname⟧ und werden bei der Anzeige eingesetzt.
const IMG_OPEN = '⟦img:';
const IMG_CLOSE = '⟧';
export const IMG_RE = /⟦img:([^⟧]+)⟧/g;

function mediaName(src) {
  if (!src || /^(https?:|data:|\/\/)/i.test(src)) return '';
  let name = src;
  try { name = decodeURIComponent(src); } catch { /* Name enthält ein einzelnes % */ }
  return name.normalize('NFC').replace(/[⟦⟧]/g, '');
}

function toText(value, isHtml) {
  let out = value;
  if (isHtml) {
    const doc = new DOMParser().parseFromString(value, 'text/html');
    doc.querySelectorAll('style,script').forEach((el) => el.remove());
    // Export "Karten als Text": Rückseite enthält Vorderseite + <hr id=answer>
    const hr = doc.querySelector('hr#answer');
    if (hr) { while (hr.previousSibling) hr.previousSibling.remove(); hr.remove(); }
    doc.querySelectorAll('img').forEach((el) => {
      const name = mediaName(el.getAttribute('src'));
      el.replaceWith(name ? `\n${IMG_OPEN}${name}${IMG_CLOSE}\n` : '[Bild]');
    });
    doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
    doc.querySelectorAll('hr').forEach((el) => el.replaceWith('\n'));
    doc.querySelectorAll('li').forEach((el) => { el.prepend('• '); el.append('\n'); });
    doc.querySelectorAll('td,th').forEach((el) => el.append('  '));
    doc.querySelectorAll('div,p,tr,h1,h2,h3,h4,h5,h6,ul,ol,table').forEach((el) => { el.prepend('\n'); el.append('\n'); });
    out = doc.body.textContent;
  }
  return out
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const CLOZE = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

// Baut aus rohen Notizen ({ fields, deck, guid, tags }) fertige Karten.
function makeCards(entries, isHtml, fallbackDeck) {
  const cards = [];
  const seenIds = new Set();
  let skipped = 0;

  for (const entry of entries) {
    const content = entry.fields.map((f) => toText(f, isHtml));
    let front = content[0] || '';
    let back = content[1] || '';
    const extras = content.slice(2).filter(Boolean);

    if (/\{\{c\d+::/.test(front)) {
      const full = front.replace(CLOZE, '$1');
      front = front.replace(CLOZE, (_, answer, hint) => (hint ? `[${hint}]` : '[ … ]'));
      back = [full, back].filter(Boolean).join('\n\n');
    }
    if (extras.length) back = [back, ...extras].filter(Boolean).join('\n\n');
    if (!front || !back) { skipped++; continue; }

    const deck = (entry.deck || fallbackDeck).replace(/::|\x1f/g, ' › ');
    const id = entry.guid ? 'g:' + entry.guid : 'h:' + hash(deck + '|' + front);
    if (seenIds.has(id)) { skipped++; continue; }
    seenIds.add(id);
    cards.push({ id, front, back, deck, tags: entry.tags || '' });
  }
  const images = new Set();
  for (const c of cards) for (const m of (c.front + c.back).matchAll(IMG_RE)) images.add(m[1]);
  return { cards, skipped, images, decks: [...new Set(cards.map((c) => c.deck))] };
}

export function parseAnki(raw, fallbackDeck = 'Importiert') {
  let text = raw.replace(/^﻿/, '');
  const meta = {};
  while (text.startsWith('#')) {
    const end = text.indexOf('\n');
    const line = (end === -1 ? text : text.slice(0, end)).trim();
    const m = line.match(/^#([^:]+):(.*)$/);
    if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
    text = end === -1 ? '' : text.slice(end + 1);
  }

  let sep = SEPARATORS[(meta.separator || '').toLowerCase()] || (meta.separator && meta.separator.length === 1 ? meta.separator : null);
  if (!sep) {
    const first = text.split('\n', 1)[0];
    sep = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
  }

  const col = (name) => (meta[name + ' column'] ? parseInt(meta[name + ' column'], 10) - 1 : -1);
  const guidCol = col('guid');
  const deckCol = col('deck');
  const tagsCol = col('tags');
  const special = new Set([guidCol, col('notetype'), deckCol, tagsCol].filter((i) => i >= 0));
  const isHtml = meta.html ? meta.html === 'true' : /<[a-z][^>]*>/i.test(text);
  const plainTable = deckCol < 0 && !Object.keys(meta).length;

  const entries = parseRows(text, sep).map((row) => {
    let fields = row.filter((_, i) => !special.has(i));
    let deck = deckCol >= 0 ? (row[deckCol] || '').trim() : '';
    // Tabelle ohne Anki-Kopfzeilen: dritte Spalte als Fach interpretieren
    if (plainTable && fields.length >= 3 && fields[2].trim().length <= 60) {
      deck = fields[2].trim();
      fields = fields.slice(0, 2);
    }
    return {
      fields,
      deck,
      guid: guidCol >= 0 ? (row[guidCol] || '').trim() : '',
      tags: tagsCol >= 0 ? (row[tagsCol] || '').trim() : '',
    };
  });
  return makeCards(entries, isHtml, fallbackDeck);
}

// ---------- Anki-Pakete (.apkg / .colpkg) ----------

let sqlPromise;
function loadSql() {
  return (sqlPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/sql-wasm.js';
    script.onload = () => window.initSqlJs({ locateFile: (f) => 'vendor/' + f }).then(resolve, reject);
    script.onerror = () => reject(new Error('Die Import-Bibliothek konnte nicht geladen werden. Bist du online?'));
    document.head.append(script);
  }));
}

export async function isPackage(file) {
  const b = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b; // ZIP-Signatur "PK"
}

// Liest ein ZIP stückweise aus der Datei, damit große Pakete mit vielen Bildern
// nicht komplett in den Arbeitsspeicher geladen werden müssen.
async function openZip(file, inflateSync) {
  const bytes = async (from, to) => new Uint8Array(await file.slice(from, to).arrayBuffer());
  const tail = await bytes(Math.max(0, file.size - 65557), file.size);
  let p = tail.length - 22;
  while (p >= 0 && !(tail[p] === 0x50 && tail[p + 1] === 0x4b && tail[p + 2] === 5 && tail[p + 3] === 6)) p--;
  if (p < 0) throw new Error('Die Datei ließ sich nicht entpacken. Ist es ein Anki-Paket (.apkg)?');
  const end = new DataView(tail.buffer, tail.byteOffset);
  let cdSize = end.getUint32(p + 12, true);
  let cdOffset = end.getUint32(p + 16, true);
  if (cdOffset === 0xffffffff || end.getUint16(p + 10, true) === 0xffff) {
    // ZIP64: Verweis steht direkt vor dem Endeintrag
    const loc = p - 20;
    if (loc < 0 || end.getUint32(loc, true) !== 0x07064b50) throw new Error('Dieses Paket ist zu groß für den Import.');
    const at = Number(end.getBigUint64(loc + 8, true));
    const e64 = new DataView((await bytes(at, at + 56)).buffer);
    cdSize = Number(e64.getBigUint64(40, true));
    cdOffset = Number(e64.getBigUint64(48, true));
  }
  const cd = await bytes(cdOffset, cdOffset + cdSize);
  const dv = new DataView(cd.buffer);
  const utf8 = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i + 46 <= cd.length && dv.getUint32(i, true) === 0x02014b50;) {
    const nameLen = dv.getUint16(i + 28, true);
    const extraLen = dv.getUint16(i + 30, true);
    let size = dv.getUint32(i + 20, true);
    let offset = dv.getUint32(i + 42, true);
    // ZIP64-Zusatzfeld für sehr große Einträge oder Positionen
    for (let x = i + 46 + nameLen; x + 4 <= i + 46 + nameLen + extraLen;) {
      const id = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (dv.getUint32(i + 24, true) === 0xffffffff) q += 8;
        if (size === 0xffffffff) { size = Number(dv.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) offset = Number(dv.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    entries.set(utf8.decode(cd.subarray(i + 46, i + 46 + nameLen)), { method: dv.getUint16(i + 10, true), size, offset });
    i += 46 + nameLen + extraLen + dv.getUint16(i + 32, true);
  }
  return {
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const head = new DataView((await bytes(e.offset, e.offset + 30)).buffer);
      const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
      const data = await bytes(start, start + e.size);
      return e.method === 0 ? data : inflateSync(data);
    },
  };
}

const isZstd = (b) => b && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

// Liest die Medienliste: altes Format JSON { "0": "bild.png" }, neues Format Protobuf.
function parseMediaMap(raw) {
  const map = new Map(); // Dateiname -> Name des Eintrags im ZIP
  if (!raw || !raw.length) return map;
  if (raw[0] === 0x7b) {
    for (const [zipName, name] of Object.entries(JSON.parse(new TextDecoder().decode(raw)))) map.set(String(name).normalize('NFC'), zipName);
    return map;
  }
  const utf8 = new TextDecoder();
  const varint = (buf, pos) => { let v = 0, shift = 0, b; do { b = buf[pos.i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return v; };
  const skip = (buf, pos, wire) => { if (wire === 0) varint(buf, pos); else if (wire === 2) pos.i += varint(buf, pos); else if (wire === 5) pos.i += 4; else if (wire === 1) pos.i += 8; else pos.i = buf.length; };
  const pos = { i: 0 };
  let index = 0;
  while (pos.i < raw.length) {
    const tag = varint(raw, pos);
    if (tag >> 3 !== 1 || (tag & 7) !== 2) { skip(raw, pos, tag & 7); continue; }
    const len = varint(raw, pos);
    const sub = raw.subarray(pos.i, pos.i + len);
    pos.i += len;
    const sp = { i: 0 };
    let name = '';
    let zipName = String(index);
    while (sp.i < sub.length) {
      const t = varint(sub, sp);
      if (t >> 3 === 1 && (t & 7) === 2) { const l = varint(sub, sp); name = utf8.decode(sub.subarray(sp.i, sp.i + l)); sp.i += l; }
      else if (t >> 3 === 255 && (t & 7) === 0) zipName = String(varint(sub, sp));
      else skip(sub, sp, t & 7);
    }
    if (name) map.set(name.normalize('NFC'), zipName);
    index++;
  }
  return map;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };

export async function parseApkg(file, fallbackDeck = 'Importiert') {
  const [{ inflateSync, unzstd }, SQL] = await Promise.all([import('../vendor/unpack.js'), loadSql()]);
  const zip = await openZip(file, inflateSync);
  const plain = (b) => (isZstd(b) ? unzstd(b) : b);
  // Neuere Anki-Versionen legen die echte Sammlung zstd-komprimiert in collection.anki21b ab.
  const data = plain(await zip.read('collection.anki21b') || await zip.read('collection.anki21') || await zip.read('collection.anki2'));
  if (!data) throw new Error('In der Datei wurde keine Anki-Sammlung gefunden.');

  let result;
  const db = new SQL.Database(data);
  try {
    const rows = (sql) => { const r = db.exec(sql)[0]; return r ? r.values : []; };

    const deckNames = new Map();
    try {
      for (const [id, name] of rows('SELECT id, name FROM decks')) deckNames.set(String(id), name);
    } catch { /* älteres Format: Stapel stehen als JSON in der Tabelle col */ }
    if (!deckNames.size) {
      try {
        const json = JSON.parse(rows('SELECT decks FROM col')[0][0]);
        for (const d of Object.values(json)) deckNames.set(String(d.id), d.name);
      } catch { /* ohne Stapelnamen weiter */ }
    }

    const deckOfNote = new Map();
    for (const [nid, did] of rows('SELECT nid, did FROM cards ORDER BY ord DESC')) deckOfNote.set(String(nid), String(did));

    const entries = rows('SELECT id, guid, flds, tags FROM notes').map(([id, guid, flds, tags]) => ({
      fields: String(flds).split('\x1f'),
      deck: deckNames.get(deckOfNote.get(String(id))) || '',
      guid: String(guid),
      tags: String(tags || '').trim(),
    }));
    result = makeCards(entries, true, fallbackDeck);
  } finally {
    db.close();
  }

  let mediaMap = new Map();
  try { mediaMap = parseMediaMap(plain(await zip.read('media'))); } catch { /* ohne Bilder weiter */ }
  const available = [...result.images].filter((name) => mediaMap.has(name) && zip.has(mediaMap.get(name)));
  result.imagesAvailable = available.length;
  // Lädt die Bilder nacheinander und übergibt sie an `put(name, type, buffer)`.
  result.loadImages = async (put, skip, onProgress) => {
    let done = 0;
    for (const name of available) {
      if (!skip.has(name)) {
        const raw = plain(await zip.read(mediaMap.get(name)));
        const type = MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
        await put(name, type, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      }
      onProgress(++done, available.length);
    }
  };
  return result;
}
