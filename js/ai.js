// KI-Prüfer: ruft die Claude-API direkt aus dem Browser auf.
// Der API-Schlüssel liegt nur lokal auf dem Gerät (App-Einstellungen).

// Bilder werden nicht mitgeschickt; im Text steht an ihrer Stelle [Bild].
const plain = (t) => t.replace(/⟦img:[^⟧]+⟧/g, '[Bild]');

let sdkPromise;
const loadSdk = () => (sdkPromise ||= import('../vendor/anthropic-sdk.js').then((m) => m.default));

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (empfohlen, gründlich)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (schneller, günstiger)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (am günstigsten)' },
];
export const DEFAULT_MODEL = MODELS[0].id;

async function request(settings, { system, messages, schema }) {
  const Anthropic = await loadSdk();
  const client = new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true,
    timeout: 120_000,
    maxRetries: 2,
  });
  const model = settings.model || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
  };

  let res;
  try {
    if (model === 'claude-haiku-5-5') {
      res = await client.messages.create(params);
    } else {
      // Lehnt das Modell eine Anfrage ab, übernimmt serverseitig ein Ersatzmodell.
      res = await client.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Der API-Schlüssel ist ungültig. Bitte in den Einstellungen prüfen.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('Der API-Schlüssel hat keine Berechtigung für dieses Modell.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Zu viele Anfragen oder Guthaben aufgebraucht. Bitte kurz warten.');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('Keine Verbindung zur KI. Bist du online?');
    if (err instanceof Anthropic.APIError) throw new Error(`KI-Fehler (${err.status ?? '?'}): ${err.message}`);
    throw err;
  }

  if (res.stop_reason === 'refusal') throw new Error('Die KI hat diese Anfrage abgelehnt. Versuch es mit einer anderen Karte.');
  if (res.stop_reason === 'max_tokens') throw new Error('Die KI-Antwort wurde abgeschnitten. Bitte noch einmal versuchen.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Die KI-Antwort war nicht lesbar. Bitte noch einmal versuchen.'); }
  return { data, content: res.content };
}

const EXAMINER_SYSTEM = `Du bist ein erfahrener, fairer und freundlicher Prüfer in der mündlich-praktischen Prüfung des Dritten Abschnitts der Ärztlichen Prüfung (M3) in Deutschland. Du prüfst eine Medizinstudentin kurz vor dem Examen und sprichst sie mit "du" an.

Du bekommst eine Prüfungsfrage, die Referenzantwort von ihrer eigenen Lernkarte und ihre Antwort. Bewerte, ob ihre Antwort den Kern der Referenzantwort inhaltlich trifft. Steht in Frage oder Referenzantwort die Marke [Bild], gehört dort ein Bild hin, das du nicht sehen kannst; bewerte dann nur anhand des Textes und werte fehlende Bildinhalte nicht als Fehler. Wortlaut, Reihenfolge und Tippfehler spielen keine Rolle, und fachlich korrekte Ergänzungen über die Karte hinaus sind willkommen. Die Referenzantwort ist der Maßstab; falls sie dir fachlich veraltet oder falsch erscheint, sag das im Feedback ausdrücklich, statt stillschweigend davon abzuweichen.

Dein Feedback ist konkret und kurz (zwei bis vier Sätze): was gut war, was fachlich nicht stimmt. In "fehlt" stehen die wichtigen Punkte der Referenzantwort, die sie nicht genannt hat, als kurze Stichpunkte (leer, wenn nichts fehlt). In "nachfrage" stellst du genau eine weiterführende Frage, wie sie ein Prüfer im M3 als Nächstes stellen würde (zum Beispiel zu Differenzialdiagnosen, nächstem diagnostischen Schritt, Therapie oder Komplikationen), passend zum Thema der Karte.

Wenn sie später auf deine Nachfrage antwortet, gibt es dafür keine Referenzantwort: Bewerte dann nach gesichertem Lehrbuchwissen, sei bei Unsicherheit zurückhaltend und sag offen, wenn etwas nachgeschlagen werden sollte.`;

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    bewertung: { type: 'string', enum: ['richtig', 'teilweise', 'falsch'] },
    feedback: { type: 'string' },
    fehlt: { type: 'array', items: { type: 'string' } },
    nachfrage: { type: 'string' },
  },
  required: ['bewertung', 'feedback', 'fehlt', 'nachfrage'],
  additionalProperties: false,
};

// Bewertet eine Antwort. `history` enthält den bisherigen Gesprächsverlauf zu dieser Karte
// (leer bei der ersten Antwort) und wird um die neue Runde ergänzt.
export async function grade(settings, card, answer, history) {
  const userText = history.length
    ? `Meine Antwort auf deine Nachfrage:\n${answer}`
    : `Fach/Stapel: ${card.deck}\n\nPrüfungsfrage:\n${plain(card.front)}\n\nReferenzantwort (Lernkarte):\n${plain(card.back)}\n\nMeine Antwort:\n${answer}`;
  const messages = [...history, { role: 'user', content: userText }];
  const { data, content } = await request(settings, { system: EXAMINER_SYSTEM, messages, schema: GRADE_SCHEMA });
  // Antwortblöcke unverändert zurückgeben, damit der Verlauf fortgesetzt werden kann.
  history.push({ role: 'user', content: userText }, { role: 'assistant', content });
  return data;
}

const MC_SYSTEM = `Du erstellst Multiple-Choice-Aufgaben aus Lernkarten einer Medizinstudentin, die sich auf das M3 vorbereitet. Für jede Karte formulierst du die richtige Antwort als eine knappe Antwortoption (höchstens etwa 15 Wörter, inhaltlich streng nach der Karte) und drei falsche Optionen. Die falschen Optionen sind fachlich plausibel, gehören zum selben Themengebiet, ähneln der richtigen in Länge und Stil und sind eindeutig falsch, sodass genau eine Option korrekt ist. Gib jede Karte mit ihrer id zurück.`;

const MC_SCHEMA = {
  type: 'object',
  properties: {
    aufgaben: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          richtig: { type: 'string' },
          falsch: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'richtig', 'falsch'],
        additionalProperties: false,
      },
    },
  },
  required: ['aufgaben'],
  additionalProperties: false,
};

// Erzeugt Antwortoptionen für mehrere Karten in einer Anfrage.
export async function makeChoices(settings, cards) {
  const list = cards.map((c) => `id: ${c.id}\nFach: ${c.deck}\nFrage: ${plain(c.front)}\nAntwort: ${plain(c.back)}`).join('\n\n---\n\n');
  const { data } = await request(settings, {
    system: MC_SYSTEM,
    messages: [{ role: 'user', content: `Erstelle für jede dieser ${cards.length} Karten eine Aufgabe:\n\n${list}` }],
    schema: MC_SCHEMA,
  });
  return data.aufgaben.filter((a) => a.falsch.length >= 3);
}

export async function testKey(settings) {
  const { data } = await request(settings, {
    system: 'Antworte knapp.',
    messages: [{ role: 'user', content: 'Antworte mit ok=true.' }],
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  });
  return data.ok === true;
}
