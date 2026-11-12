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

function toText(value, isHtml) {
  let out = value;
  if (isHtml) {
    const doc = new DOMParser().parseFromString(value, 'text/html');
    doc.querySelectorAll('style,script').forEach((el) => el.remove());
    // Export "Karten als Text": Rückseite enthält Vorderseite + <hr id=answer>
    const hr = doc.querySelector('hr#answer');
    if (hr) { while (hr.previousSibling) hr.previousSibling.remove(); hr.remove(); }
    doc.querySelectorAll('img').forEach((el) => el.replaceWith('[Bild]'));
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
  let hadImages = false;

  for (const entry of entries) {
    const content = entry.fields.map((f) => {
      if (/<img/i.test(f)) hadImages = true;
      return toText(f, isHtml);
    });
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
  return { cards, skipped, hadImages, decks: [...new Set(cards.map((c) => c.deck))] };
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

export const isPackage = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b; // ZIP-Signatur "PK"

export async function parseApkg(bytes, fallbackDeck = 'Importiert') {
  const [{ unzipSync, unzstd }, SQL] = await Promise.all([import('../vendor/unpack.js'), loadSql()]);
  let files;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name.startsWith('collection.') });
  } catch {
    throw new Error('Die Datei ließ sich nicht entpacken. Ist es ein Anki-Paket (.apkg)?');
  }
  // Neuere Anki-Versionen legen die echte Sammlung zstd-komprimiert in collection.anki21b ab.
  const data = files['collection.anki21b'] ? unzstd(files['collection.anki21b']) : files['collection.anki21'] || files['collection.anki2'];
  if (!data) throw new Error('In der Datei wurde keine Anki-Sammlung gefunden.');

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
    return makeCards(entries, true, fallbackDeck);
  } finally {
    db.close();
  }
}
