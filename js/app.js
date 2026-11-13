import * as store from './store.js';
import { parseAnki, parseApkg, isPackage, IMG_RE } from './anki.js';
import * as ai from './ai.js';
import { transcribe } from './speech.js';
import { NACHRICHTEN } from '../nachrichten.js';

// ---------- Zustand ----------

const INTERVALS = [0, 1, 3, 7, 14, 30]; // Tage bis zur nächsten Wiederholung je Stufe
const VERSION = 19; // bei jeder Änderung hochzählen, wird unter „Mehr“ angezeigt
const EXAM_QUESTIONS = 5; // Fragen pro Prüfungsgespräch (Einstieg + Anschlussfragen)
const CASE_QUESTIONS = 7; // Fragen pro Fallbeispiel
const CASE_GOAL = 10; // angepeilte Fälle pro Fach für den Gesamtfortschritt
const CASE_SUBJECTS = [
  { id: 'ains', icon: '💉', name: 'Anästhesie, Intensiv-, Notfall- und Schmerzmedizin' },
  { id: 'innere', icon: '🫀', name: 'Innere Medizin' },
  { id: 'chirurgie', icon: '🔪', name: 'Chirurgie' },
];
const SICHER_AB = 3; // ab dieser Stufe gilt eine Karte als "sitzt"

const fresh = () => ({
  settings: { name: '', sender: '', examDate: '', newPerDay: 0, messages: '', apiKey: '', openaiKey: '', model: ai.DEFAULT_MODEL, strict: 1 },
  cards: [],
  days: {},
  achievements: {},
  stats: { total: 0, aiRight: 0, mcRight: 0 },
  cases: [],
  exams: [],
  feedback: [],
});

let S = fresh();
let tab = 'heute';
let session = null;
let pendingImport = null;
let saveTimer;

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(S).catch(() => toast('Speichern fehlgeschlagen')), 150);
}

// ---------- Datum (Tageswechsel erst um 4 Uhr, für Nachteulen) ----------

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date(Date.now() - 4 * 3600e3));
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const daysBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 864e5);
const daysLeft = () => (S.settings.examDate ? daysBetween(todayKey(), S.settings.examDate) : null);

// ---------- Tagesziel ----------

function today() {
  const k = todayKey();
  let d = S.days[k];
  if (!d) d = S.days[k] = { done: 0, right: 0, newSeen: 0, bonus: 0, target: 0, quota: 0, goalHit: false };
  if (d.done === 0) {
    const due = S.cards.filter((c) => c.seen && c.due <= k).length;
    const unseen = S.cards.filter((c) => !c.seen).length;
    const left = daysLeft();
    let quota = S.settings.newPerDay > 0 ? S.settings.newPerDay : left === null ? 20 : Math.ceil(unseen / Math.max(1, left - 3));
    quota = Math.min(quota, unseen);
    d.quota = quota;
    d.target = due + quota;
  }
  return d;
}

const isActive = (d) => d && d.done >= Math.min(10, Math.max(1, d.target));

function streak() {
  let k = todayKey();
  if (!isActive(S.days[k])) k = addDays(k, -1);
  let n = 0;
  while (isActive(S.days[k])) { n++; k = addDays(k, -1); }
  return n;
}

// ---------- Erfolge ----------

const sicherCount = () => S.cards.filter((c) => c.box >= SICHER_AB).length;
const goalDays = () => Object.values(S.days).filter((d) => d.goalHit).length;

const ACHIEVEMENTS = [
  { id: 'first', icon: '🌱', name: 'Erster Schritt', desc: 'Erste Karte beantwortet', ok: () => S.stats.total >= 1 },
  { id: 'c100', icon: '💯', name: '100 Karten', desc: '100 Karten beantwortet', ok: () => S.stats.total >= 100 },
  { id: 'c500', icon: '📚', name: '500 Karten', desc: '500 Karten beantwortet', ok: () => S.stats.total >= 500 },
  { id: 'c1000', icon: '🏔️', name: '1000 Karten', desc: '1000 Karten beantwortet', ok: () => S.stats.total >= 1000 },
  { id: 'goal1', icon: '🎯', name: 'Volltreffer', desc: 'Erstes Tagesziel erreicht', ok: () => goalDays() >= 1 },
  { id: 'goal10', icon: '🏅', name: 'Zuverlässig', desc: '10 Tagesziele erreicht', ok: () => goalDays() >= 10 },
  { id: 's3', icon: '🔥', name: '3 Tage Serie', desc: '3 Tage am Stück gelernt', ok: () => streak() >= 3 },
  { id: 's7', icon: '⚡', name: 'Eine Woche', desc: '7 Tage am Stück gelernt', ok: () => streak() >= 7 },
  { id: 's14', icon: '🚀', name: 'Zwei Wochen', desc: '14 Tage am Stück gelernt', ok: () => streak() >= 14 },
  { id: 's30', icon: '👑', name: 'Ein Monat', desc: '30 Tage am Stück gelernt', ok: () => streak() >= 30 },
  { id: 'seen', icon: '👀', name: 'Alles gesehen', desc: 'Jede Karte mindestens einmal gelernt', ok: () => S.cards.length > 0 && S.cards.every((c) => c.seen) },
  { id: 'half', icon: '🌗', name: 'Halbzeit', desc: 'Die Hälfte der Karten sitzt', ok: () => S.cards.length > 0 && sicherCount() >= S.cards.length / 2 },
  { id: 'all', icon: '🩺', name: 'Examensreif', desc: 'Alle Karten sitzen', ok: () => S.cards.length > 0 && sicherCount() === S.cards.length },
  { id: 'case5', icon: '🏥', name: 'Fallprofi', desc: '5 Fallbeispiele abgeschlossen', ok: () => S.cases.length >= 5 },
  { id: 'ai10', icon: '🎓', name: 'Prüfer überzeugt', desc: '10 KI-Prüfungsfragen richtig', ok: () => S.stats.aiRight >= 10 },
];

function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (!S.achievements[a.id] && a.ok()) {
      S.achievements[a.id] = todayKey();
      toast(`${a.icon} Erfolg: ${a.name}`);
    }
  }
  const s = streak();
  const d = today();
  if (NACHRICHTEN.serie[s] && d.streakMsg !== s) {
    d.streakMsg = s;
    toast(`🔥 ${NACHRICHTEN.serie[s]}`, 5000);
  }
}

// ---------- Nachrichten ----------

function messagePool() {
  const own = (S.settings.messages || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return [...own, ...NACHRICHTEN.taeglich];
}
function dailyMessage() {
  const pool = messagePool();
  if (!pool.length) return '';
  const n = Math.abs(daysBetween('2024-01-01', todayKey()));
  return pool[n % pool.length];
}
function greeting() {
  const h = new Date().getHours();
  const t = NACHRICHTEN.tageszeit[h >= 5 && h < 11 ? 'morgen' : h >= 11 && h < 17 ? 'mittag' : h >= 17 && h < 23 ? 'abend' : 'nacht'];
  const n = Math.abs(daysBetween('2024-01-01', todayKey()));
  return { gruss: t.gruss.replace('{name}', S.settings.name ? ' ' + S.settings.name : ''), satz: t.saetze[n % t.saetze.length] };
}
const praise = () => `<p class="praise">💛 ${esc(pick(NACHRICHTEN.lob))}</p>`;
const sender = () => S.settings.sender || NACHRICHTEN.absender;

// ---------- Hilfen ----------

// Kartentext sicher ausgeben und Bildmarken durch Bilder ersetzen
const rich = (s) => esc(s).replace(IMG_RE, (_, name) => `<img class="cardimg" data-media="${name}" data-act="zoom" alt="Bild">`);
const hasImage = (s) => s.includes('⟦img:');
const imageUrls = new Map();

function setHtml(html) {
  stopMic();
  $app.innerHTML = html;
  for (const img of $app.querySelectorAll('img[data-media]')) {
    const name = img.dataset.media;
    if (!imageUrls.has(name)) {
      imageUrls.set(name, store.getMedia(name).then((m) => (m ? URL.createObjectURL(new Blob([m.data], { type: m.type })) : ''), () => ''));
    }
    imageUrls.get(name).then((url) => {
      if (url) img.src = url;
      else img.replaceWith(Object.assign(document.createElement('span'), { className: 'noimg', textContent: '[Bild fehlt]' }));
    });
  }
}

// ---------- Einsprechen (Spracherkennung des Browsers) ----------

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
const MIC_IDLE = 'Tippen und sprechen';
const micButton = (sendAct) => `<button class="micbig" data-act="mic" data-send="${sendAct}"><span>🎤</span><b>${MIC_IDLE}</b></button>`;
// Gezählt werden nur eigentliche Fragen, nicht die Runden, in denen der Prüfer nachhakt
const countedTurns = (ex) => ex.turns.filter((t) => !t.followup).length;
const percent = (p) => (Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : null);

let recorder = null; // laufende Aufnahme für die bessere Spracherkennung

function stopMic() {
  if (rec) { rec.onend = null; rec.abort(); rec = null; }
  if (recorder) { recorder.cancelled = true; recorder.stop(); }
}

// Stichworte zur aktuellen Frage, damit die Spracherkennung die Fachbegriffe richtig schreibt
function speechHint() {
  const ex = session && session.exam;
  const card = ex ? ex.card : session && cardById(session.queue[session.idx]?.id);
  const parts = ['Mündliche Medizinprüfung (M3) auf Deutsch, eine Studentin beantwortet eine Prüfungsfrage.'];
  if (ex) parts.push(`Frage: ${ex.question}`);
  if (card) parts.push(`Thema: ${card.deck}. ${card.front} ${card.back}`);
  return parts.join(' ').replace(IMG_RE, ' ').replace(/\s+/g, ' ').slice(0, 900);
}

async function recordAndTranscribe(btn) {
  if (recorder) { recorder.stop(); return; } // zweiter Tipp: fertig
  const label = btn.lastElementChild;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Kein Zugriff auf das Mikrofon. Bitte in den iPhone-Einstellungen erlauben.', 6000);
    return;
  }
  const chunks = [];
  const r = recorder = new MediaRecorder(stream);
  r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  r.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    if (r.cancelled || !document.contains(btn)) return;
    btn.classList.remove('rec');
    btn.disabled = true;
    label.textContent = 'Wird verstanden …';
    try {
      const text = await transcribe(S.settings.openaiKey, new Blob(chunks, { type: r.mimeType || 'audio/mp4' }), speechHint());
      if (!document.contains(btn)) return;
      const box = document.getElementById('answer');
      if (text) {
        box.value = (box.value.trim() ? box.value.trim() + ' ' : '') + text;
        actions[btn.dataset.send]();
        return;
      }
      toast('Es wurde nichts verstanden. Versuch es noch einmal.');
    } catch (err) {
      toast(err.message, 6000);
    }
    if (document.contains(btn)) { btn.disabled = false; label.textContent = MIC_IDLE; }
  };
  r.start();
  btn.classList.add('rec');
  label.textContent = 'Fertig? Tippen zum Prüfen';
}

function toggleMic(btn) {
  if (S.settings.openaiKey && navigator.mediaDevices && window.MediaRecorder) { recordAndTranscribe(btn); return; }
  if (rec) { rec.stop(); return; } // zweiter Tipp: fertig, Antwort wird geprüft
  if (!SpeechRec) {
    toast('Dieses Gerät stellt der App keine Spracherkennung bereit. Tippe ins Textfeld und nutze das Mikrofon auf der Tastatur.', 7000);
    document.getElementById('answer')?.focus();
    return;
  }
  const box = document.getElementById('answer');
  const base = box.value.trim() ? box.value.trim() + ' ' : '';
  let heard = false;
  let failed = false;
  const r = rec = new SpeechRec();
  r.lang = 'de-DE';
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (e) => {
    if (!document.contains(box)) { stopMic(); return; }
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    heard = true;
    box.value = base + text.trim();
  };
  r.onerror = (e) => {
    failed = true;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Mikrofon oder Spracherkennung ist nicht erlaubt. Nutze sonst das Mikrofon auf der Tastatur.', 6000);
    else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Die Spracherkennung hat nicht funktioniert. Nutze das Mikrofon auf der Tastatur.', 6000);
  };
  r.onend = () => {
    if (rec === r) rec = null;
    if (!document.contains(btn)) return;
    btn.classList.remove('rec');
    btn.lastElementChild.textContent = MIC_IDLE;
    if (heard && !failed && box.value.trim()) actions[btn.dataset.send]();
  };
  try { r.start(); } catch { rec = null; toast('Die Spracherkennung ließ sich nicht starten.'); return; }
  btn.classList.add('rec');
  btn.lastElementChild.textContent = 'Fertig? Tippen zum Prüfen';
}

// Bereitet die Bilder einer Karte für die KI auf: verkleinert und als JPEG (Base64).
async function aiImages(card) {
  const names = [...new Set([...(card.front + card.back).matchAll(IMG_RE)].map((m) => m[1]))].slice(0, 6);
  const out = new Map();
  for (const name of names) {
    try {
      const m = await store.getMedia(name);
      if (!m) continue;
      const url = URL.createObjectURL(new Blob([m.data], { type: m.type }));
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
      URL.revokeObjectURL(url);
      const w = img.naturalWidth || 800;
      const h = img.naturalHeight || 600;
      const scale = Math.min(1, 1568 / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      out.set(name, { media_type: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] });
    } catch { /* Bild nicht lesbar: die KI bekommt an der Stelle [Bild] */ }
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cardById = (id) => S.cards.find((c) => c.id === id);
const decks = () => [...new Set(S.cards.map((c) => c.deck))].sort((a, b) => a.localeCompare(b, 'de'));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function toast(text, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function confetti() {
  const c = document.createElement('canvas');
  c.className = 'confetti';
  c.width = innerWidth; c.height = innerHeight;
  document.body.append(c);
  const ctx = c.getContext('2d');
  const colors = ['#0f9d8a', '#ff7a59', '#ffc857', '#6c8cff', '#e85d9a'];
  const parts = Array.from({ length: 120 }, () => ({
    x: c.width / 2, y: c.height * 0.35, vx: (Math.random() - 0.5) * 14, vy: Math.random() * -13 - 3,
    s: Math.random() * 7 + 4, r: Math.random() * 6, color: pick(colors),
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.vy += 0.32; p.x += p.vx; p.y += p.vy; p.r += 0.2;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.color; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
    }
    if (++frame < 150) requestAnimationFrame(tick); else c.remove();
  })();
}

// ---------- Lernlogik ----------

function applyRating(item, rating) {
  const card = cardById(item.id);
  const k = todayKey();
  const d = today();
  if (!item.retry && !item.free) {
    if (rating === 'good') card.box = card.seen ? Math.min(5, Math.max(1, card.box) + 1) : 2;
    else if (rating === 'mid') card.box = Math.max(1, card.box);
    else { card.box = 1; card.lapses = (card.lapses || 0) + 1; }
    card.due = addDays(k, rating === 'good' ? INTERVALS[card.box] : 1);
    if (card.lastDay !== k) {
      d.done++;
      if (rating === 'good') d.right++;
      if (!card.seen) d.newSeen++;
      S.stats.total++;
    }
    card.seen = true;
    card.lastDay = k;
  }
  session.answered++;
  if (rating === 'good') session.right++;
  if (rating === 'bad' && !item.again) session.queue.push({ id: item.id, retry: true, again: true, free: item.free });

  if (!d.goalHit && d.target > 0 && d.done >= d.target) {
    d.goalHit = true;
    confetti();
    toast(`💌 ${pick(NACHRICHTEN.zielErreicht)}`, 5000);
  }
  checkAchievements();
  persist();
}

function buildQueue(deck, kind) {
  const k = todayKey();
  const d = today();
  const pool = S.cards.filter((c) => !deck || c.deck === deck);
  if (kind === 'free') return shuffle(pool.filter((c) => c.seen)).slice(0, 20).map((c) => ({ id: c.id, free: true }));
  const due = shuffle(pool.filter((c) => c.seen && c.due <= k));
  const room = Math.max(0, d.quota + d.bonus - d.newSeen);
  const fresh = pool.filter((c) => !c.seen).slice(0, room);
  return [...due, ...fresh].map((c) => ({ id: c.id }));
}

const shortEnough = (c) => c.back.length <= 140 && !c.back.includes('\n') && !hasImage(c.back);

function fallbackOptions(card) {
  const others = S.cards.filter((c) => c.id !== card.id && shortEnough(c) && c.back !== card.back);
  const sameDeck = others.filter((c) => c.deck === card.deck);
  const source = sameDeck.length >= 3 ? sameDeck : others;
  const wrong = [...new Set(shuffle(source).map((c) => c.back))].slice(0, 3);
  return wrong.length === 3 ? { richtig: card.back, falsch: wrong } : null;
}

function prepareCurrent() {
  const item = session.queue[session.idx];
  session.stage = 'q';
  session.picked = null;
  session.ki = { history: [], results: [], loading: false, error: '', rated: false };
  if (item && session.mode === 'mc') {
    const card = cardById(item.id);
    const mc = card.mc || fallbackOptions(card);
    session.options = shuffle([{ text: mc.richtig, ok: true }, ...mc.falsch.slice(0, 3).map((t) => ({ text: t, ok: false }))]);
  }
}

async function startSession(mode, deck, kind) {
  let queue = buildQueue(deck, kind);
  const useAi = !!S.settings.apiKey;
  if (mode === 'mc') {
    if (!useAi) queue = queue.filter((it) => { const c = cardById(it.id); return shortEnough(c) && fallbackOptions(c); });
    queue = queue.slice(0, 10);
  }
  if (!queue.length) {
    toast(mode === 'mc' && !useAi ? 'Für Multiple Choice ohne KI braucht es mindestens vier Karten mit kurzen Antworten.' : 'Dafür gibt es gerade keine Karten.');
    return;
  }
  session = { mode, queue, idx: 0, total: queue.length, right: 0, answered: 0, loading: false, done: false };

  if (mode === 'mc' && useAi) {
    const missing = queue.map((it) => cardById(it.id)).filter((c) => !c.mc);
    if (missing.length) {
      session.loading = true;
      render();
      try {
        const made = await ai.makeChoices(S.settings, missing);
        for (const m of made) { const c = cardById(m.id); if (c) c.mc = { richtig: m.richtig, falsch: m.falsch }; }
        persist();
      } catch (err) {
        toast(err.message, 5000);
      }
      if (!session) return;
      session.loading = false;
      session.queue = session.queue.filter((it) => { const c = cardById(it.id); return c.mc || fallbackOptions(c); });
      session.total = session.queue.length;
      if (!session.queue.length) { session = null; render(); return; }
    }
  }
  prepareCurrent();
  render();
}

function startExam(deck) {
  const pool = S.cards.filter((c) => !deck || c.deck === deck);
  if (!pool.length) { toast('Dafür gibt es gerade keine Karten.'); return; }
  const queue = buildQueue(deck, 'due');
  const card = queue.length ? cardById(pick(queue.slice(0, 15)).id) : pick(pool);
  const context = shuffle(S.cards.filter((c) => c.deck === card.deck && c.id !== card.id)).slice(0, 6);
  session = {
    mode: 'exam', queue: [{ id: card.id }], idx: 0, total: 1, right: 0, answered: 0, deck,
    exam: { card, context, total: EXAM_QUESTIONS, history: [], turns: [], question: card.front, loading: false, error: '', final: null },
  };
  render();
  scrollTo(0, 0);
}

async function startCase(fach, thema) {
  const ex = {
    card: null, fach, thema, total: CASE_QUESTIONS, avoid: S.cases.filter((c) => c.fach === fach).slice(0, 12).map((c) => c.titel),
    history: [], turns: [], question: '', title: '', loading: true, error: '', final: null,
  };
  const current = session = { mode: 'exam', queue: [], idx: 0, total: 1, right: 0, answered: 0, exam: ex };
  render();
  scrollTo(0, 0);
  try {
    const res = await ai.caseTurn(S.settings, ex, '', 'start');
    if (session !== current) return;
    ex.title = res.titel;
    ex.question = `${res.vorstellung}\n\n${res.frage}`;
    ex.loading = false;
    render();
  } catch (err) {
    if (session !== current) return;
    session = null; tab = 'faelle';
    render();
    toast(err.message, 6000);
  }
}

function viewFaelle() {
  const hasKey = !!S.settings.apiKey;
  const past = S.cases.slice(0, 15).map((c) => `<div class="row deckline"><span>${esc(c.titel)}<br><small class="muted">${esc(c.fach)} · ${fromKey(c.date).toLocaleDateString('de-DE')}</small></span><b class="nowrap">${esc(c.note)}</b></div>`).join('');
  return `
    <header class="hero"><h1>Fälle</h1><span class="chip">${S.cases.length} ${S.cases.length === 1 ? 'Fall' : 'Fälle'} gelöst</span></header>
    <section class="card">
      <p>Ein Patientenfall wie im M3: Der Prüfer stellt dir eine Situation vor und führt dich in ${CASE_QUESTIONS} Fragen durch Anamnese, Diagnostik und Therapie. Am Ende gibt es eine Note.</p>
      ${hasKey ? `<label class="field"><span>Thema (optional)</span><input id="casetopic" placeholder="z. B. akutes Abdomen, Sepsis, Polytrauma"></label>`
        : `<p class="error">Dafür braucht es einen API-Schlüssel.</p><button class="btn" data-act="tab" data-tab="mehr">Schlüssel eintragen</button>`}
    </section>
    ${CASE_SUBJECTS.map((f) => `
      <button class="mode ${hasKey ? '' : 'off'}" data-act="startcase" data-fach="${esc(f.name)}" ${hasKey ? '' : 'disabled'}>
        <span class="mode-icon">${f.icon}</span><span><b>${esc(f.name)}</b><small>Neuen Fall starten</small></span>
      </button>`).join('')}
    ${past ? `<section class="card"><h2>Bisherige Fälle</h2>${past}</section>` : ''}
    <p class="muted small center">Die Fälle erfindet die KI. Sie kann sich irren; im Zweifel gilt das Lehrbuch.</p>`;
}

async function examSend(mode) {
  const ex = session.exam;
  const current = session;
  const box = document.getElementById('answer');
  const text = box ? box.value.trim() : '';
  if (mode !== 'abbruch' && !text) { toast('Schreib erst deine Antwort.'); return; }
  if (mode !== 'abbruch' && countedTurns(ex) + (ex.followup ? 0 : 1) >= ex.total) mode = 'letzte';
  ex.loading = true; ex.error = ''; ex.draft = text;
  render();
  scrollTo(0, document.body.scrollHeight);
  try {
    if (ex.card && !ex.history.length) ex.images = await aiImages(ex.card);
    const res = await (ex.card ? ai.examTurn : ai.caseTurn)(S.settings, ex, text, mode);
    if (session !== current) return;
    if (mode !== 'abbruch') {
      ex.turns.push({ q: ex.question, a: (res.verstanden || '').trim() || text, reaktion: res.reaktion, bewertung: res.bewertung, prozent: percent(res.prozent), fehlt: res.fehlt || [], followup: !!ex.followup, probing: mode === 'weiter' && !!res.nachhaken && !ex.followup });
      ex.draft = '';
      if (res.bewertung === 'richtig') S.stats.aiRight++;
      // Die Einstiegsfrage stammt von der Karte und zählt für deren Lernstand
      if (ex.card && ex.turns.length === 1) applyRating(session.queue[0], { richtig: 'good', teilweise: 'mid', falsch: 'bad' }[res.bewertung]);
      else { checkAchievements(); persist(); }
    }
    if (mode === 'weiter') { ex.followup = !!res.nachhaken && !ex.followup; ex.question = res.frage; }
    else {
      ex.final = res; ex.question = '';
      if (!ex.card) {
        S.cases.unshift({ date: todayKey(), ts: Date.now(), fach: ex.fach, titel: ex.title, note: res.note });
        S.cases = S.cases.slice(0, 40);
      } else {
        const titel = ex.card.front.replace(IMG_RE, ' ').replace(/\s+/g, ' ').trim();
        S.exams.unshift({ date: todayKey(), ts: Date.now(), fach: ex.card.deck, titel: titel.length > 70 ? titel.slice(0, 70) + ' …' : titel, note: res.note });
        S.exams = S.exams.slice(0, 60);
      }
      checkAchievements(); persist();
    }
  } catch (err) {
    if (session !== current) return;
    ex.error = err.message;
  }
  ex.loading = false;
  render();
  if (ex.error && document.getElementById('answer')) document.getElementById('answer').value = ex.draft;
  scrollTo(0, ex.final ? 0 : document.body.scrollHeight);
}

function viewExam() {
  const ex = session.exam;
  const label = { richtig: ['good', 'Richtig'], teilweise: ['mid', 'Teilweise'], falsch: ['bad', 'Nicht richtig'] };
  const asked = Math.min(ex.total, countedTurns(ex) + (ex.final || ex.followup ? 0 : 1));
  const head = `<div class="sess-head"><button class="icon-btn" data-act="quit" aria-label="Beenden">✕</button>
    <div class="progress slim"><i style="width:${pct(countedTurns(ex), ex.total)}%"></i></div>
    <span class="muted">${ex.final ? 'fertig' : `Frage ${asked}/${ex.total}`}</span></div>
    <div class="deck-label">${ex.card ? `Prüfungsgespräch · ${esc(ex.card.deck)}` : `Fall · ${esc(ex.title || ex.fach)}`}</div>`;
  if (!ex.card && !ex.question && !ex.final) return head + '<section class="card center tall"><div class="spinner"></div><h2>Dein Fall wird vorbereitet …</h2><p class="muted">Das dauert einen Moment.</p></section>';

  const turns = ex.turns.map((t, i) => `
    <div class="bubble examiner"><small>Prüfer</small><p class="pre">${i === 0 ? rich(t.q) : esc(t.q)}</p></div>
    <div class="bubble me"><p class="pre">${esc(t.a)}</p></div>
    <div class="bubble examiner verdict ${t.probing ? 'mid' : label[t.bewertung][0]}"><small>${t.probing ? 'Noch nicht vollständig' : label[t.bewertung][1]}${t.prozent != null ? ` · ${t.prozent} % richtig` : ''}</small><p class="pre">${esc(t.reaktion)}</p>
      ${t.fehlt && t.fehlt.length ? `<p class="muted small">Das hat gefehlt:</p><ul>${t.fehlt.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div>`).join('');

  if (ex.final) {
    const f = ex.final;
    const list = (items) => (items.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">–</p>');
    return head + `
      <section class="card center"><small class="muted">Gesamtnote</small><div class="grade">${esc(f.note)}</div><p class="pre">${esc(f.fazit)}</p>${praise()}</section>
      <section class="card feedback good"><h3>Das lief gut</h3>${list(f.staerken)}</section>
      <section class="card feedback mid"><h3>Das solltest du nacharbeiten</h3>${list(f.luecken)}</section>
      <details class="card"><summary>Gesprächsverlauf</summary><div class="chat">${turns}</div></details>
      ${ex.card ? `<details class="card"><summary>Musterantwort zur Einstiegsfrage</summary><p class="pre">${rich(ex.card.back)}</p></details>` : ''}
      <button class="btn primary" data-act="examagain">${ex.card ? 'Neues Prüfungsgespräch' : 'Neuer Fall'}</button>
      <button class="btn" data-act="quit">Fertig</button>
      <p class="muted small center">Die KI kann sich irren. Im Zweifel gilt deine Karte bzw. das Lehrbuch.</p>`;
  }

  const current = `<div class="bubble examiner"><small>Prüfer</small><p class="pre">${ex.turns.length ? esc(ex.question) : rich(ex.question)}</p></div>`;
  const input = ex.loading
    ? `${ex.draft ? `<div class="bubble me"><p class="pre">${esc(ex.draft)}</p></div>` : ''}<section class="card center"><div class="spinner"></div><p class="muted">Der Prüfer überlegt …</p></section>`
    : `${ex.error ? `<p class="error">${esc(ex.error)}</p>` : ''}
       ${micButton('examsend')}
       <textarea id="answer" rows="3" placeholder="… oder hier tippen"></textarea>
       <button class="btn primary" data-act="examsend">Antworten</button>
       ${ex.turns.length ? `<button class="btn ghost" data-act="examstop">Prüfung jetzt beenden und bewerten</button>` : ''}`;
  return head + `<div class="chat">${turns}${current}</div>` + input;
}

function next() {
  session.idx++;
  if (session.idx >= session.queue.length) session.done = true;
  else prepareCurrent();
  render();
  scrollTo(0, 0);
}

// ---------- Ansichten ----------

function viewHeute() {
  if (!S.cards.length) {
    return `
      <header class="hero"><h1>${esc(greeting().gruss)}</h1>
      <p>Dein Lernbegleiter fürs M3.</p></header>
      <section class="card center">
        <div class="big-emoji">🩺</div>
        <h2>Noch keine Karten</h2>
        <p class="muted">Importiere deine Anki-Karten, dann geht es los.</p>
        <button class="btn primary" data-act="tab" data-tab="karten">Karten importieren</button>
      </section>`;
  }
  const d = today();
  const left = daysLeft();
  const total = S.cards.length;
  const sicher = sicherCount();
  const seen = S.cards.filter((c) => c.seen).length;
  const open = Math.max(0, d.target - d.done);
  const p = d.target ? Math.min(100, pct(d.done, d.target)) : 100;
  const msg = dailyMessage();

  const countdown = left === null
    ? `<button class="chip" data-act="tab" data-tab="mehr">Prüfungstermin eintragen</button>`
    : left > 0 ? `<span class="chip strong">Noch ${left} ${left === 1 ? 'Tag' : 'Tage'} bis zum M3</span>`
    : left === 0 ? `<span class="chip strong">Heute ist dein Tag. Du schaffst das! 🍀</span>`
    : `<span class="chip strong">Geschafft! 🎓</span>`;

  const week = Array.from({ length: 7 }, (_, i) => {
    const k = addDays(todayKey(), i - 6);
    const day = S.days[k];
    const h = day && day.target ? Math.min(100, pct(day.done, day.target)) : day && day.done ? 100 : 0;
    const label = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][fromKey(k).getDay()];
    return `<div class="wd ${day && day.goalHit ? 'hit' : ''}"><div class="bar"><i style="height:${Math.max(h, 4)}%"></i></div><span>${label}</span></div>`;
  }).join('');

  const deckRows = decks().map((name) => {
    const cs = S.cards.filter((c) => c.deck === name);
    const s = cs.filter((c) => c.box >= SICHER_AB).length;
    const w = cs.filter((c) => c.seen && c.box < SICHER_AB).length;
    return `<div class="deckrow"><div class="row"><span>${esc(name)}</span><span class="muted">${s}/${cs.length}</span></div>
      <div class="seg"><i class="ok" style="width:${(s / cs.length) * 100}%"></i><i class="work" style="width:${(w / cs.length) * 100}%"></i></div></div>`;
  }).join('');

  const badges = ACHIEVEMENTS.map((a) => `<div class="badge ${S.achievements[a.id] ? 'on' : ''}" title="${esc(a.desc)}"><span>${a.icon}</span><small>${esc(a.name)}</small></div>`).join('');

  return `
    <header class="hero"><h1>${esc(greeting().gruss)}</h1><p class="muted">${esc(greeting().satz)}</p>${countdown}<button class="chip" data-act="tab" data-tab="feedback">💬 Feedback an ${esc(sender())}</button></header>

    ${msg ? `<section class="card note"><p>${esc(msg)}</p><small>— ${esc(sender())}</small></section>` : ''}

    <section class="card">
      <div class="row"><h2>Heute</h2><span class="muted">${d.done} / ${d.target} Karten</span></div>
      <div class="progress"><i style="width:${p}%"></i></div>
      <p class="muted">${d.goalHit || (d.target === 0) ? 'Tagesziel erreicht. Stark! 🎉' : `Noch ${open} ${open === 1 ? 'Karte' : 'Karten'} bis zum Tagesziel.`}</p>
      <button class="btn primary" data-act="tab" data-tab="lernen">${d.goalHit ? 'Weiterlernen' : d.done ? 'Weiter geht’s' : 'Jetzt lernen'}</button>
    </section>

    <section class="card">
      <div class="row"><h2>Gesamtfortschritt</h2><span class="muted">${seen} von ${total} Karten gelernt</span></div>
      <div class="row sub first"><h2>Karten</h2></div>
      <div class="bigpct">${pct(seen, total)} %</div>
      <div class="seg tall"><i class="ok" style="width:${(sicher / total) * 100}%"></i><i class="work" style="width:${((seen - sicher) / total) * 100}%"></i></div>
      <div class="legend"><span><i class="dot ok"></i>${sicher} sitzen</span><span><i class="dot work"></i>${seen - sicher} in Arbeit</span><span><i class="dot"></i>${total - seen} neu</span></div>
      ${caseProgress()}
    </section>

    <section class="stats">
      <div class="stat"><b>🔥 ${streak()}</b><span>Tage Serie</span></div>
      <div class="stat"><b>${pct(sicher, total)} %</b><span>sitzt</span></div>
      <div class="stat"><b>${S.stats.total}</b><span>Antworten</span></div>
    </section>

    <section class="card">
      <h2>Letzte 7 Tage</h2>
      <div class="week">${week}</div>
    </section>

    <section class="card">
      <div class="row"><h2>Fortschritt pro Fach</h2><span class="muted">${sicher} von ${total} sitzen</span></div>
      <div class="legend"><span><i class="dot ok"></i>sitzt</span><span><i class="dot work"></i>in Arbeit</span><span><i class="dot"></i>neu</span></div>
      ${deckRows}
    </section>

    ${examProgress()}

    <section class="card">
      <h2>Erfolge</h2>
      <div class="badges">${badges}</div>
    </section>`;
}

const GRADE_VALUE = { 'sehr gut': 1, gut: 2, befriedigend: 3, ausreichend: 4, 'nicht ausreichend': 5 };

// Fälle pro Fach als Teil des Gesamtfortschritts
function caseProgress() {
  const rows = CASE_SUBJECTS.map((f) => {
    const done = S.cases.filter((c) => c.fach === f.name);
    const graded = done.filter((c) => GRADE_VALUE[c.note]);
    const avg = graded.length ? ` · Ø ${(graded.reduce((sum, c) => sum + GRADE_VALUE[c.note], 0) / graded.length).toFixed(1).replace('.', ',')}` : '';
    return `<div class="deckrow"><div class="row"><span>${f.icon} ${esc(f.name)}</span><span class="muted nowrap">${done.length}/${CASE_GOAL}${avg}</span></div>
      <div class="seg"><i class="ok" style="width:${Math.min(100, (done.length / CASE_GOAL) * 100)}%"></i></div></div>`;
  }).join('');
  return `<div class="row sub"><h2>Fälle</h2><span class="muted">${S.cases.length} gelöst</span></div>${rows}`;
}

// Fortschritt in Prüfungsgesprächen und Fällen für die Heute-Seite
function examProgress() {
  const all = [...S.exams.map((e) => ({ ...e, typ: 'Prüfungsgespräch' })), ...S.cases.map((c) => ({ ...c, typ: 'Fall' }))]
    .sort((a, b) => (b.date + String(b.ts || 0).padStart(15, '0')).localeCompare(a.date + String(a.ts || 0).padStart(15, '0')));
  if (!all.length) return '';
  const graded = all.filter((e) => GRADE_VALUE[e.note]);
  const avg = (list) => (list.length ? (list.reduce((sum, e) => sum + GRADE_VALUE[e.note], 0) / list.length).toFixed(1).replace('.', ',') : '–');
  const today = all.filter((e) => e.date === todayKey()).length;
  const rows = all.slice(0, 6).map((e) => `<div class="row deckline"><span>${esc(e.titel)}<br><small class="muted">${e.typ} · ${esc(e.fach)} · ${fromKey(e.date).toLocaleDateString('de-DE')}</small></span><b class="nowrap">${esc(e.note)}</b></div>`).join('');
  return `
    <section class="card">
      <div class="row"><h2>Prüfungsgespräche und Fälle</h2><span class="muted">${today} heute</span></div>
      <div class="stats inner">
        <div class="stat"><b>${S.exams.length}</b><span>Gespräche</span></div>
        <div class="stat"><b>${S.cases.length}</b><span>Fälle</span></div>
        <div class="stat"><b>${avg(graded)}</b><span>Ø Note</span></div>
      </div>
      <p class="muted small">Ø Note der letzten fünf: ${avg(graded.slice(0, 5))}</p>
      ${rows}
    </section>`;
}

function viewFeedback() {
  const list = S.feedback.map((f) => `
    <div class="fb ${f.sent ? 'sent' : ''}">
      <div class="row"><small class="muted">${new Date(f.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${f.sent ? 'gesendet' : 'neu'}</small>
        <button class="icon-btn" data-act="fbdel" data-id="${f.ts}" aria-label="Löschen">🗑️</button></div>
      <p class="pre">${esc(f.text)}</p>
    </div>`).join('');
  const fresh = S.feedback.filter((f) => !f.sent).length;
  return `
    <header class="hero"><h1>Feedback</h1><span class="chip">${fresh} neu · ${S.feedback.length} gesamt</span></header>
    <section class="card">
      <p>Was nervt, was fehlt, was wäre schön? Einfach einsprechen oder tippen. ${esc(sender())} bekommt alles gesammelt.</p>
      ${micButton('fbsave')}
      <textarea id="answer" rows="3" placeholder="… oder hier tippen"></textarea>
      <button class="btn primary" data-act="fbsave">Speichern</button>
    </section>
    ${S.feedback.length ? `<section class="card">
      <h2>Gesammeltes Feedback</h2>
      <button class="btn primary" data-act="fbwhatsapp">${fresh ? `${fresh} neue per WhatsApp an ${esc(sender())}` : `Alles nochmal per WhatsApp an ${esc(sender())}`}</button>
      <button class="btn" data-act="fbsend">Anders senden (Nachrichten, Mail …)</button>
      ${list}
    </section>` : ''}`;
}

function feedbackText(items) {
  const lines = items.slice().reverse().map((f, i) => `${i + 1}. [${new Date(f.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}] ${f.text}`);
  return `Feedback zu M3 Coach (Version ${VERSION})${S.settings.name ? ' von ' + S.settings.name : ''}\n\n${lines.join('\n\n')}`;
}

function viewLernen() {
  if (!S.cards.length) return `<header class="hero"><h1>Lernen</h1></header><section class="card center"><p class="muted">Importiere zuerst Karten.</p><button class="btn primary" data-act="tab" data-tab="karten">Zu den Karten</button></section>`;
  const d = today();
  const k = todayKey();
  const deck = viewLernen.deck || '';
  const pool = S.cards.filter((c) => !deck || c.deck === deck);
  const due = pool.filter((c) => c.seen && c.due <= k).length;
  const fresh = Math.min(pool.filter((c) => !c.seen).length, Math.max(0, d.quota + d.bonus - d.newSeen));
  const hasKey = !!S.settings.apiKey;
  const nothing = due + fresh === 0;
  const unseenLeft = pool.filter((c) => !c.seen).length;

  const modes = [
    { id: 'oral', icon: '🗣️', name: 'Mündliche Prüfung', desc: 'Frage lesen, laut antworten, mit der Musterantwort vergleichen.' },
    { id: 'ki', icon: '🎓', name: 'KI-Prüfer', desc: hasKey ? 'Karte für Karte: Antwort tippen oder diktieren, die KI bewertet.' : 'Braucht einen API-Schlüssel (unter „Mehr“).', off: !hasKey },
    { id: 'exam', icon: '👩‍⚕️', name: 'Prüfungsgespräch', desc: hasKey ? `Wie im M3: eine Einstiegsfrage, dann ${EXAM_QUESTIONS - 1} Anschlussfragen, die auf deinen Antworten aufbauen. Am Ende gibt es eine Note.` : 'Braucht einen API-Schlüssel (unter „Mehr“).', off: !hasKey },
  ];

  return `
    <header class="hero"><h1>Lernen</h1>
      <span class="chip">${due} Wiederholungen · ${fresh} neue</span></header>

    <section class="card">
      <label class="field"><span>Fach / Stapel</span>
        <select data-change="deck"><option value="">Alle Karten</option>
        ${decks().map((n) => `<option ${n === deck ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    </section>

    ${nothing ? `<section class="card center"><div class="big-emoji">🎉</div><h2>Für heute alles erledigt</h2>
      <p class="muted">Du kannst trotzdem weitermachen:</p>
      ${unseenLeft ? `<button class="btn" data-act="bonus">10 neue Karten dazu</button>` : ''}
      <p class="muted small">Oder wähle unten einen Modus für freies Üben mit zufälligen Karten.</p></section>` : ''}

    ${modes.map((m) => `
      <button class="mode ${m.off ? 'off' : ''}" data-act="start" data-mode="${m.id}" data-kind="${nothing ? 'free' : 'due'}" ${m.off ? 'disabled' : ''}>
        <span class="mode-icon">${m.icon}</span>
        <span><b>${m.name}</b><small>${m.desc}</small></span>
      </button>`).join('')}`;
}

function sessionHeader() {
  const p = pct(session.idx, session.queue.length);
  return `<div class="sess-head"><button class="icon-btn" data-act="quit" aria-label="Beenden">✕</button>
    <div class="progress slim"><i style="width:${p}%"></i></div>
    <span class="muted">${Math.min(session.idx + 1, session.queue.length)}/${session.queue.length}</span></div>`;
}

function viewSession() {
  if (session.mode === 'exam') return viewExam();
  if (session.loading) return `<section class="card center tall"><div class="spinner"></div><h2>Die KI erstellt Antwortoptionen …</h2><p class="muted">Das dauert einen Moment.</p></section>`;
  if (session.done) {
    const d = today();
    return `<section class="card center tall">
      <div class="big-emoji">${d.goalHit ? '🏆' : '💪'}</div>
      <h2>Runde geschafft!</h2>
      ${praise()}
      <p>${session.right} von ${session.answered} richtig.</p>
      <p class="muted">${d.goalHit ? 'Tagesziel erreicht.' : `Heute: ${d.done} / ${d.target} Karten.`}</p>
      <button class="btn primary" data-act="quit">Fertig</button>
    </section>`;
  }
  const item = session.queue[session.idx];
  const card = cardById(item.id);
  const head = `${sessionHeader()}<div class="deck-label">${esc(card.deck)}${item.retry ? ' · nochmal' : !card.seen ? ' · neu' : ''}</div>`;
  const question = `<section class="card question"><p class="pre">${rich(card.front)}</p></section>`;
  const answer = `<section class="card answer"><small>Musterantwort</small><p class="pre">${rich(card.back)}</p></section>`;

  if (session.mode === 'oral') {
    return head + question + (session.stage === 'q'
      ? `<p class="hint">Antworte laut, so wie in der Prüfung.</p><button class="btn primary" data-act="reveal">Musterantwort zeigen</button>
         ${S.settings.apiKey ? `<button class="btn" data-act="tocheck">🎤 Antwort einsprechen und prüfen lassen</button>` : ''}`
      : `${answer}<p class="hint">Wie lief es?</p><div class="rate">
          <button class="btn bad" data-act="rate" data-r="bad">Nicht gewusst</button>
          <button class="btn mid" data-act="rate" data-r="mid">Unsicher</button>
          <button class="btn good" data-act="rate" data-r="good">Gewusst</button></div>`);
  }

  if (session.mode === 'mc') {
    const opts = session.options.map((o, i) => {
      const cls = session.picked === null ? '' : o.ok ? 'right' : i === session.picked ? 'wrong' : 'dim';
      return `<button class="opt ${cls}" data-act="pick" data-i="${i}" ${session.picked !== null ? 'disabled' : ''}><span class="pre">${rich(o.text)}</span></button>`;
    }).join('');
    return head + question + `<div class="opts">${opts}</div>` + (session.picked !== null ? `${answer}<button class="btn primary" data-act="next">Weiter</button>` : '');
  }

  // KI-Prüfer
  const ki = session.ki;
  const label = { richtig: ['good', 'Richtig'], teilweise: ['mid', 'Teilweise richtig'], falsch: ['bad', 'Noch nicht richtig'] };
  const results = ki.results.map((r, i) => `
    <section class="card feedback ${label[r.bewertung][0]}">
      <small>${i ? 'Nachfrage' : 'Bewertung'}</small>
      <h3>${label[r.bewertung][1]}${percent(r.prozent) != null ? ` · ${percent(r.prozent)} % richtig` : ''}</h3>
      ${percent(r.prozent) != null ? `<div class="progress slim score"><i style="width:${percent(r.prozent)}%"></i></div>` : ''}
      ${r.verstanden ? `<p class="muted small">So habe ich dich verstanden: „${esc(r.verstanden)}“</p>` : ''}
      <p class="pre">${esc(r.feedback)}</p>
      ${r.fehlt.length ? `<p class="muted small">Das hat gefehlt:</p><ul>${r.fehlt.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    </section>`).join('');
  const last = ki.results[ki.results.length - 1];
  const input = ki.loading
    ? `<section class="card center"><div class="spinner"></div><p class="muted">Der Prüfer überlegt …</p></section>`
    : `${last ? `<section class="card question follow"><small>Nachfrage des Prüfers</small><p class="pre">${esc(last.nachfrage)}</p></section>` : ''}
       ${ki.error ? `<p class="error">${esc(ki.error)}</p>` : ''}
       ${micButton('send')}
       <textarea id="answer" rows="3" placeholder="${last ? 'Antwort auf die Nachfrage (optional) … oder hier tippen' : '… oder hier tippen'}"></textarea>
       <button class="btn ${last ? '' : 'primary'}" data-act="send">${last ? 'Nachfrage beantworten' : 'Antwort abschicken'}</button>
       ${last ? `<button class="btn primary" data-act="next">Nächste Karte</button>` : `<button class="btn ghost" data-act="giveup">Weiß ich nicht</button>`}`;
  return head + question + results + (ki.results.length ? `<details class="card"><summary>Musterantwort von deiner Karte</summary><p class="pre">${rich(card.back)}</p></details>` : '') + input
    + (ki.results.length ? `<p class="muted small center">Die KI kann sich irren. Im Zweifel gilt deine Karte bzw. das Lehrbuch.</p>` : '');
}

function viewKarten() {
  const list = decks().map((name) => {
    const n = S.cards.filter((c) => c.deck === name).length;
    return `<div class="row deckline"><span>${esc(name)} <span class="muted">· ${n}</span></span><button class="icon-btn" data-act="deldeck" data-deck="${esc(name)}" aria-label="Stapel löschen">🗑️</button></div>`;
  }).join('');

  const preview = pendingImport ? `
    <section class="card highlight">
      <h2>${pendingImport.cards.length} Karten erkannt</h2>
      <p class="muted">${pendingImport.decks.length} ${pendingImport.decks.length === 1 ? 'Stapel' : 'Stapel'}: ${esc(pendingImport.decks.slice(0, 6).join(', '))}${pendingImport.decks.length > 6 ? ' …' : ''}</p>
      ${pendingImport.skipped ? `<p class="muted small">${pendingImport.skipped} Zeilen übersprungen (leer, doppelt oder ohne Antwort).</p>` : ''}
      ${pendingImport.images.size ? `<p class="muted small">${pendingImport.imagesAvailable
        ? `🖼️ ${pendingImport.imagesAvailable} von ${pendingImport.images.size} Bildern sind in der Datei und werden übernommen.`
        : 'Die Karten enthalten Bilder, in der Datei sind aber keine. Für Bilder ein Stapelpaket (.apkg) mit Haken bei „Einschließlich Medien“ exportieren.'}</p>` : ''}
      ${pendingImport.progress ? `<div class="progress"><i style="width:${pendingImport.progress}%"></i></div><p class="muted small">Bilder werden gespeichert … bitte die App offen lassen.</p>` : ''}
      ${pendingImport.cards[0] ? `<div class="sample"><small>Beispiel</small><p class="pre"><b>${esc(pendingImport.cards[0].front.replace(IMG_RE, '[Bild]'))}</b></p><p class="pre">${esc(pendingImport.cards[0].back.replace(IMG_RE, '[Bild]'))}</p></div>` : ''}
      ${pendingImport.progress ? '' : `<div class="rate"><button class="btn ghost" data-act="cancelimport">Abbrechen</button><button class="btn primary" data-act="confirmimport">Importieren</button></div>`}
    </section>` : '';

  return `
    <header class="hero"><h1>Karten</h1><span class="chip">${S.cards.length} Karten</span></header>
    ${preview}
    <section class="card">
      <h2>Aus Anki importieren</h2>
      <p class="muted small"><b>Direkt am Handy</b> (AnkiMobile oder AnkiDroid):</p>
      <ol class="steps">
        <li>In der Anki-App den Stapel exportieren bzw. teilen, Format <b>Stapelpaket (.apkg)</b>, mit Medien, damit die Bilder dabei sind.</li>
        <li><b>„In Dateien sichern“</b> wählen</li>
        <li>Hier auf „Datei auswählen“ tippen und die .apkg-Datei öffnen</li>
      </ol>
      <label class="btn primary filebtn">Datei auswählen<input type="file" data-change="file" hidden></label>
      <details><summary class="muted small">Vom Computer aus</summary>
        <p class="muted small">In Anki <b>Datei → Exportieren</b>, am besten als <b>Stapelpaket (.apkg)</b> mit Haken bei „Einschließlich Medien“ (nur so kommen Bilder mit). Alternativ <b>Notizen als Text (.txt)</b> mit Stapelname und eindeutiger Kennung, dann ohne Bilder. Datei aufs Handy schicken und hier auswählen.</p></details>
      <p class="muted small">Ein erneuter Import aktualisiert die Karten, der Lernstand bleibt erhalten.</p>
    </section>
    <section class="card">
      <h2>Oder einfügen</h2>
      <p class="muted small">Eine Karte pro Zeile: Frage; Antwort; Fach (Semikolon oder Tab als Trenner).</p>
      <textarea id="paste" rows="4" placeholder="Was ist …?; Die Antwort; Innere"></textarea>
      <button class="btn" data-act="paste">Übernehmen</button>
    </section>
    <section class="card">
      <h2>Deine Stapel</h2>
      ${list || '<p class="muted">Noch keine Karten.</p>'}
      ${S.cards.length ? '' : `<button class="btn ghost" data-act="demo">Beispielkarten zum Ausprobieren laden</button>`}
    </section>`;
}

function viewMehr() {
  const s = S.settings;
  return `
    <header class="hero"><h1>Mehr</h1></header>
    <section class="card">
      <h2>Persönliches</h2>
      <label class="field"><span>Dein Name</span><input data-set="name" value="${esc(s.name)}" placeholder="Wie soll die App dich nennen?"></label>
      <label class="field"><span>Prüfungstermin (M3)</span><input type="date" data-set="examDate" value="${esc(s.examDate)}"></label>
      <label class="field"><span>Neue Karten pro Tag</span><input type="number" min="0" inputmode="numeric" data-set="newPerDay" value="${s.newPerDay || ''}" placeholder="automatisch aus dem Termin"></label>
      <p class="muted small">Leer lassen: Die App verteilt alle neuen Karten gleichmäßig bis drei Tage vor der Prüfung.</p>
    </section>
    <section class="card">
      <h2>Nachrichten 💌</h2>
      <label class="field"><span>Von</span><input data-set="sender" value="${esc(s.sender)}" placeholder="${esc(NACHRICHTEN.absender)}"></label>
      <label class="field"><span>Eigene Nachrichten (eine pro Zeile)</span><textarea data-set="messages" rows="4" placeholder="Du schaffst das!">${esc(s.messages)}</textarea></label>
    </section>
    <section class="card">
      <h2>KI-Prüfer</h2>
      <label class="field"><span>Anthropic-API-Schlüssel</span><input type="password" data-set="apiKey" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
      <label class="field"><span>Modell</span><select data-set="model">${ai.MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
      <label class="field"><span>OpenAI-Schlüssel für bessere Spracherkennung (optional)</span><input type="password" data-set="openaiKey" value="${esc(s.openaiKey)}" placeholder="sk-…" autocomplete="off"></label>
      <p class="muted small">Ohne diesen Schlüssel nutzt der Sprech-Knopf die Erkennung des Geräts. Mit Schlüssel wird die Aufnahme an OpenAI gesendet und dort in Text umgewandelt; das versteht Fachbegriffe deutlich besser.</p>
      <label class="field"><span>Strenge der Bewertung</span>
        <input type="range" min="1" max="3" step="1" data-set="strict" value="${s.strict || 1}">
        <span class="scale"><span>gnädig</span><span>ausgewogen</span><span>streng</span></span></label>
      <button class="btn" data-act="testkey">Schlüssel testen</button>
      <p class="muted small">Der Schlüssel wird nur auf diesem Gerät gespeichert und ist nicht im Backup enthalten. Jede KI-Frage kostet einen kleinen Betrag. Die Texte und Bilder deiner Karten werden dafür an Anthropic gesendet.</p>
    </section>
    <section class="card">
      <h2>Backup</h2>
      <p class="muted small">Alle Daten liegen nur auf diesem Gerät. Ab und zu sichern lohnt sich. Bilder sind nicht im Backup; dafür das Anki-Paket erneut importieren.</p>
      <button class="btn" data-act="export">Backup herunterladen</button>
      <label class="btn filebtn">Backup einspielen<input type="file" accept="application/json,.json" data-change="restore" hidden></label>
      <button class="btn ghost danger" data-act="reset">Lernstand zurücksetzen</button>
    </section>
    <section class="card">
      <h2>Feedback 💬</h2>
      <p class="muted small">Wünsche und Probleme sammeln und an ${esc(sender())} schicken.</p>
      <button class="btn" data-act="tab" data-tab="feedback">Feedback geben${S.feedback.filter((f) => !f.sent).length ? ` (${S.feedback.filter((f) => !f.sent).length} neu)` : ''}</button>
    </section>
    <section class="card">
      <h2>App</h2>
      <p class="muted small">Version ${VERSION}. Fehlt eine neue Funktion, hier aktualisieren. Karten und Lernstand bleiben erhalten.</p>
      <button class="btn" data-act="update">App aktualisieren</button>
    </section>`;
}

function render() {
  $tabs.hidden = !!session;
  document.body.classList.toggle('in-session', !!session);
  if (session) { setHtml(viewSession()); return; }
  setHtml({ heute: viewHeute, lernen: viewLernen, faelle: viewFaelle, karten: viewKarten, mehr: viewMehr, feedback: viewFeedback }[tab]());
  for (const b of $tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === tab);
}

// ---------- Import ----------

function stageImport(text, name) {
  showImport(parseAnki(text, name));
}

async function stageFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  if (!(await isPackage(file))) { showImport(parseAnki(await file.text(), name)); return; }
  toast('Paket wird gelesen …');
  try { showImport(await parseApkg(file, name)); }
  catch (err) { toast(err.message || 'Das Paket konnte nicht gelesen werden.', 6000); }
}

function showImport(result) {
  if (!result.cards.length) { toast('Keine Karten erkannt. Ist es ein Anki-Paket oder der Text-Export aus Anki?', 5000); return; }
  pendingImport = result;
  render();
  scrollTo(0, 0);
}

async function pruneMedia() {
  const used = new Set();
  for (const c of S.cards) for (const m of (c.front + c.back).matchAll(IMG_RE)) used.add(m[1]);
  const unused = (await store.mediaNames()).filter((n) => !used.has(n));
  if (unused.length) await store.deleteMedia(unused);
  for (const n of unused) imageUrls.delete(n);
}

async function commitImport() {
  const imp = pendingImport;
  if (imp.loadImages && imp.imagesAvailable) {
    imp.progress = 1;
    render();
    try {
      const have = new Set(await store.mediaNames());
      let shown = 0;
      await imp.loadImages(store.putMedia, have, (done, total) => {
        const p = Math.max(1, Math.round((done / total) * 100));
        if (p !== shown) { shown = p; imp.progress = p; if (pendingImport === imp && tab === 'karten' && !session) render(); }
      });
      for (const n of imp.images) imageUrls.delete(n);
    } catch (err) {
      imp.progress = 0;
      toast(err && err.name === 'QuotaExceededError' ? 'Der Speicher des Geräts reicht nicht für alle Bilder.' : 'Die Bilder konnten nicht gespeichert werden.', 6000);
      render();
      return;
    }
  }
  if (pendingImport !== imp) return;
  let added = 0;
  let updated = 0;
  for (const c of pendingImport.cards) {
    const old = cardById(c.id);
    if (old) {
      if (old.back !== c.back || old.front !== c.front) delete old.mc;
      Object.assign(old, c);
      updated++;
    } else {
      S.cards.push({ ...c, box: 0, due: '', seen: false, lapses: 0 });
      added++;
    }
  }
  pendingImport = null;
  persist();
  toast(`${added} neue Karten${updated ? `, ${updated} aktualisiert` : ''}`);
  tab = 'heute';
  render();
}

const DEMO = `#separator:semicolon
#deck column:3
Was beschreibt die Virchow-Trias?;Endothelschaden, verlangsamter Blutfluss (Stase), erhöhte Gerinnungsneigung (Hyperkoagulabilität);Beispielkarten
Welche Symptome bilden die klassische Trias der Meningitis?;Fieber, Kopfschmerzen, Nackensteifigkeit (Meningismus);Beispielkarten
Was ist das Murphy-Zeichen?;Schmerzbedingter Stopp der Einatmung bei Palpation unter dem rechten Rippenbogen, Hinweis auf eine akute Cholezystitis;Beispielkarten
Welche Symptome umfasst die Charcot-Trias der Cholangitis?;Fieber, Ikterus, rechtsseitiger Oberbauchschmerz;Beispielkarten
Wofür steht das ABCDE-Schema?;Airway, Breathing, Circulation, Disability, Exposure;Beispielkarten
Welche drei Bereiche bewertet die Glasgow Coma Scale?;Augenöffnen, verbale Reaktion, motorische Reaktion (3 bis 15 Punkte);Beispielkarten
Welche Befunde bilden die Beck-Trias der Perikardtamponade?;Hypotonie, gestaute Halsvenen, abgeschwächte Herztöne;Beispielkarten
Wo liegt der McBurney-Punkt?;Zwischen äußerem und mittlerem Drittel der Linie von der rechten Spina iliaca anterior superior zum Nabel;Beispielkarten`;

// ---------- Ereignisse ----------

const actions = {
  tab: (el) => { tab = el.dataset.tab; render(); scrollTo(0, 0); },
  start: (el) => (el.dataset.mode === 'exam' ? startExam(viewLernen.deck || '') : startSession(el.dataset.mode, viewLernen.deck || '', el.dataset.kind)),
  examsend: () => examSend('weiter'),
  examstop: () => examSend('abbruch'),
  examagain: () => (session.exam.card ? startExam(session.deck) : startCase(session.exam.fach, session.exam.thema)),
  startcase: (el) => startCase(el.dataset.fach, (document.getElementById('casetopic')?.value || '').trim()),
  bonus: () => { today().bonus += 10; persist(); render(); },
  quit: () => { tab = session.exam && !session.exam.card ? 'faelle' : 'heute'; session = null; render(); scrollTo(0, 0); },
  reveal: () => { session.stage = 'a'; render(); },
  // Von der Selbstbewertung zur KI-Prüfung wechseln (gilt für den Rest der Runde)
  tocheck: () => {
    session.mode = 'ki';
    render();
    const btn = $app.querySelector('[data-act="mic"]');
    if (btn) toggleMic(btn); else document.getElementById('answer')?.focus();
  },
  mic: (el) => toggleMic(el),
  rate: (el) => { applyRating(session.queue[session.idx], el.dataset.r); next(); },
  pick: (el) => {
    const i = Number(el.dataset.i);
    session.picked = i;
    const ok = session.options[i].ok;
    if (ok) S.stats.mcRight++;
    applyRating(session.queue[session.idx], ok ? 'good' : 'bad');
    render();
  },
  next: () => next(),
  zoom: (el) => {
    if (!el.src) return;
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.append(Object.assign(document.createElement('img'), { src: el.src, alt: 'Bild' }));
    box.addEventListener('click', () => box.remove());
    document.body.append(box);
  },
  giveup: () => {
    const card = cardById(session.queue[session.idx].id);
    applyRating(session.queue[session.idx], 'bad');
    session.mode = 'oral-shown';
    setHtml(`${sessionHeader()}<section class="card question"><p class="pre">${rich(card.front)}</p></section>
      <section class="card answer"><small>Musterantwort</small><p class="pre">${rich(card.back)}</p></section>
      <button class="btn primary" data-act="resume">Weiter</button>`);
  },
  resume: () => { session.mode = 'ki'; next(); },
  send: async () => {
    const ki = session.ki;
    const text = document.getElementById('answer').value.trim();
    if (!text) { toast('Schreib erst deine Antwort.'); return; }
    const item = session.queue[session.idx];
    const current = session;
    ki.loading = true; ki.error = '';
    render();
    try {
      const card = cardById(item.id);
      const result = await ai.grade(S.settings, card, text, ki.history, ki.history.length ? null : await aiImages(card));
      if (session !== current || session.ki !== ki) return;
      ki.results.push(result);
      if (!ki.rated) {
        ki.rated = true;
        if (result.bewertung === 'richtig') S.stats.aiRight++;
        applyRating(item, { richtig: 'good', teilweise: 'mid', falsch: 'bad' }[result.bewertung]);
      }
    } catch (err) {
      if (session !== current || session.ki !== ki) return;
      ki.error = err.message;
    }
    ki.loading = false;
    render();
    if (ki.error) document.getElementById('answer').value = text;
  },
  paste: () => {
    const text = document.getElementById('paste').value;
    if (text.trim()) stageImport(text, 'Eigene Karten');
  },
  demo: () => stageImport(DEMO, 'Beispielkarten'),
  confirmimport: () => commitImport(),
  cancelimport: () => { pendingImport = null; render(); },
  deldeck: (el) => {
    const name = el.dataset.deck;
    if (!confirm(`Stapel „${name}“ mit allen Karten und Lernstand löschen?`)) return;
    S.cards = S.cards.filter((c) => c.deck !== name);
    persist(); render();
    pruneMedia().catch(() => {});
  },
  testkey: async (el) => {
    if (!S.settings.apiKey) { toast('Trag erst einen Schlüssel ein.'); return; }
    el.disabled = true; el.textContent = 'Teste …';
    try { await ai.testKey(S.settings); toast('✅ Schlüssel funktioniert'); }
    catch (err) { toast(err.message, 6000); }
    el.disabled = false; el.textContent = 'Schlüssel testen';
  },
  export: () => {
    const copy = { ...S, settings: { ...S.settings, apiKey: '', openaiKey: '' } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(copy)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `m3-coach-backup-${todayKey()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  fbsave: () => {
    const text = (document.getElementById('answer')?.value || '').trim();
    if (!text) { toast('Sag oder schreib erst etwas.'); return; }
    S.feedback.unshift({ ts: Date.now(), text, sent: false });
    persist(); render();
    toast('Gespeichert. Danke! 💛');
  },
  fbdel: (el) => { S.feedback = S.feedback.filter((f) => String(f.ts) !== el.dataset.id); persist(); render(); },
  fbwhatsapp: () => {
    const fresh = S.feedback.filter((f) => !f.sent);
    const items = fresh.length ? fresh : S.feedback;
    // Öffnet WhatsApp mit fertigem Text; dort nur noch den Chat auswählen
    location.href = `https://wa.me/?text=${encodeURIComponent(feedbackText(items))}`;
    for (const f of items) f.sent = true;
    persist(); render();
  },
  fbsend: async () => {
    const fresh = S.feedback.filter((f) => !f.sent);
    const items = fresh.length ? fresh : S.feedback;
    const text = feedbackText(items);
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert. Jetzt in eine Nachricht einfügen.', 5000); }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // Teilen abgebrochen
      toast('Teilen hat nicht geklappt.');
      return;
    }
    for (const f of items) f.sent = true;
    persist(); render();
  },
  update: async (el) => {
    el.disabled = true; el.textContent = 'Aktualisiere …';
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.update();
      for (const k of await caches.keys()) await caches.delete(k);
      // Dateien am Browser-Zwischenspeicher vorbei frisch laden
      await Promise.all(['./', 'index.html', 'js/app.js', 'js/ai.js', 'js/anki.js', 'js/store.js', 'css/style.css', 'nachrichten.js', 'sw.js'].map((u) => fetch(u, { cache: 'reload' })));
    } catch { /* offline: einfach neu laden */ }
    location.reload();
  },
  reset: () => {
    if (!confirm('Wirklich den gesamten Lernstand zurücksetzen? Die Karten bleiben erhalten.')) return;
    for (const c of S.cards) Object.assign(c, { box: 0, due: '', seen: false, lapses: 0, lastDay: '' });
    S.days = {}; S.achievements = {}; S.stats = fresh().stats;
    persist(); render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) actions[el.dataset.act]?.(el);
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.set) {
    const key = el.dataset.set;
    S.settings[key] = key === 'strict' ? parseInt(el.value, 10) || 1 : key === 'newPerDay' ? Math.max(0, parseInt(el.value, 10) || 0) : key === 'messages' ? el.value : el.value.trim();
    persist();
    return;
  }
  if (el.dataset.change === 'deck') { viewLernen.deck = el.value; render(); }
  if (el.dataset.change === 'file' && el.files[0]) {
    await stageFile(el.files[0]);
    el.value = '';
  }
  if (el.dataset.change === 'restore' && el.files[0]) {
    try {
      const data = JSON.parse(await el.files[0].text());
      if (!Array.isArray(data.cards) || !data.settings) throw new Error();
      if (!confirm(`Backup mit ${data.cards.length} Karten einspielen? Der aktuelle Stand wird ersetzt.`)) return;
      const { apiKey, openaiKey } = S.settings;
      S = { ...fresh(), ...data, settings: { ...fresh().settings, ...data.settings, apiKey, openaiKey } };
      persist(); render(); toast('Backup eingespielt');
    } catch { toast('Das ist kein gültiges Backup.'); }
  }
});

// ---------- Start ----------

(async function init() {
  try {
    const saved = await store.load();
    if (saved) S = { ...fresh(), ...saved, settings: { ...fresh().settings, ...saved.settings }, stats: { ...fresh().stats, ...saved.stats } };
  } catch { toast('Gespeicherte Daten konnten nicht geladen werden.'); }
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
  render();
})();
