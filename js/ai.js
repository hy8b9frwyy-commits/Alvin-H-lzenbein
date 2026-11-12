// KI-Prüfer: ruft die Claude-API direkt aus dem Browser auf.
// Der API-Schlüssel liegt nur lokal auf dem Gerät (App-Einstellungen).

// Bildmarken im Kartentext: ohne mitgeschicktes Bild steht an ihrer Stelle [Bild].
const IMG = /⟦img:([^⟧]+)⟧/g;
const plain = (t) => t.replace(IMG, '[Bild]');

// Zerlegt einen Text mit Bildmarken in Text- und Bildblöcke für die API.
// `images`: Map von Dateiname auf { media_type, data (Base64) }.
function withImages(text, images) {
  if (!images || !images.size) return plain(text);
  const blocks = [];
  const addText = (t) => {
    if (!t) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') last.text += t; else blocks.push({ type: 'text', text: t });
  };
  let pos = 0;
  for (const m of text.matchAll(IMG)) {
    addText(text.slice(pos, m.index));
    const img = images.get(m[1]);
    if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    else addText('[Bild]');
    pos = m.index + m[0].length;
  }
  addText(text.slice(pos));
  return blocks;
}

let sdkPromise;
const loadSdk = () => (sdkPromise ||= import('../vendor/anthropic-sdk.js').then((m) => m.default));

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (empfohlen, gründlich)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (schneller, günstiger)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (am günstigsten)' },
];
export const DEFAULT_MODEL = MODELS[0].id;

// Wie streng bewertet wird (Einstellung unter „Mehr“): 1 gnädig, 2 ausgewogen, 3 streng.
const DICTATED = `Die Antworten werden meist eingesprochen und von einer allgemeinen Spracherkennung in Text umgewandelt, die medizinische Fachsprache schlecht kennt. Sie macht aus Fachbegriffen, Eigennamen, Medikamenten und Abkürzungen oft ähnlich klingende Alltagswörter, zerlegt lange Wörter in mehrere kurze oder lässt Silben weg. Lies die Antwort deshalb nie Wort für Wort, sondern als Ganzes: Rekonstruiere aus Klang, Satzzusammenhang, Frage und Thema, was sie tatsächlich gesagt hat. Klingt ein Wort oder eine Wortfolge wie ein Fachbegriff, der an dieser Stelle fachlich passt, dann hat sie diesen Begriff gesagt, und er zählt als genannt. Erfinde dabei nichts hinzu: Was in der Antwort auch klanglich nirgends vorkommt, gilt als nicht gesagt. In "verstanden" gibst du ihre Antwort so wieder, wie du sie nach dieser Rekonstruktion verstanden hast, in ihren Worten und ohne inhaltliche Ergänzungen; darauf beziehen sich Bewertung, Prozentwert und fehlende Punkte.`;
const STRICTNESS = {
  1: `Bewerte großzügig. Es zählt, ob sie den Kern verstanden hat: Sinngemäß richtige, knappe oder umgangssprachlich formulierte Antworten gelten als "richtig", auch wenn Details oder einzelne Punkte fehlen, solange nichts Wesentliches falsch ist. "teilweise" vergibst du erst, wenn ein zentraler Teil fehlt, und "falsch" nur, wenn der Kern verfehlt oder etwas klinisch Gefährliches gesagt wurde. Fehlende Details nennst du freundlich in der Rückmeldung, ohne die Bewertung abzustufen. ${DICTATED}`,
  2: `Bewerte ausgewogen: "richtig", wenn die wesentlichen Punkte genannt sind; "teilweise", wenn wichtige Punkte fehlen oder etwas ungenau ist; "falsch", wenn der Kern verfehlt wurde. ${DICTATED}`,
  3: `Bewerte streng wie ein anspruchsvoller Prüfer: "richtig" nur, wenn alle wesentlichen Punkte genannt und fachlich präzise sind; fehlen wichtige Punkte oder ist etwas ungenau, ist es "teilweise". ${DICTATED}`,
};
const withStrictness = (system, settings) => `${system}\n\n${STRICTNESS[settings.strict] || STRICTNESS[1]}`;

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

Du bekommst eine Prüfungsfrage, die Referenzantwort von ihrer eigenen Lernkarte und ihre Antwort. Bewerte, ob ihre Antwort den Kern der Referenzantwort inhaltlich trifft. Bilder der Karte sind an der passenden Stelle beigefügt; beziehe sie in die Bewertung ein. Steht stattdessen die Marke [Bild], konnte das Bild nicht mitgeschickt werden; bewerte dann nur anhand des Textes und werte fehlende Bildinhalte nicht als Fehler. Wortlaut, Reihenfolge und Tippfehler spielen keine Rolle, und fachlich korrekte Ergänzungen über die Karte hinaus sind willkommen. Die Referenzantwort ist der Maßstab; falls sie dir fachlich veraltet oder falsch erscheint, sag das im Feedback ausdrücklich, statt stillschweigend davon abzuweichen.

Dein Feedback ist konkret und kurz (zwei bis vier Sätze): was gut war, was fachlich nicht stimmt. In "fehlt" stehen die wichtigen Punkte der Referenzantwort, die sie nicht genannt hat, als kurze Stichpunkte (leer, wenn nichts fehlt). In "prozent" gibst du als ganze Zahl von 0 bis 100 an, wie viel der erwarteten Antwort sie inhaltlich richtig abgedeckt hat; die Zahl passt zu deiner Bewertung und zu dem, was du unter "fehlt" aufführst. In "nachfrage" stellst du genau eine weiterführende Frage, wie sie ein Prüfer im M3 als Nächstes stellen würde (zum Beispiel zu Differenzialdiagnosen, nächstem diagnostischen Schritt, Therapie oder Komplikationen), passend zum Thema der Karte.

Wenn sie später auf deine Nachfrage antwortet, gibt es dafür keine Referenzantwort: Bewerte dann nach gesichertem Lehrbuchwissen, sei bei Unsicherheit zurückhaltend und sag offen, wenn etwas nachgeschlagen werden sollte.`;

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    bewertung: { type: 'string', enum: ['richtig', 'teilweise', 'falsch'] },
    verstanden: { type: 'string' },
    prozent: { type: 'integer' },
    feedback: { type: 'string' },
    fehlt: { type: 'array', items: { type: 'string' } },
    nachfrage: { type: 'string' },
  },
  required: ['verstanden', 'bewertung', 'prozent', 'feedback', 'fehlt', 'nachfrage'],
  additionalProperties: false,
};

// Bewertet eine Antwort. `history` enthält den bisherigen Gesprächsverlauf zu dieser Karte
// (leer bei der ersten Antwort) und wird um die neue Runde ergänzt.
export async function grade(settings, card, answer, history, images) {
  const userText = history.length
    ? `Meine Antwort auf deine Nachfrage:\n${answer}`
    : `Fach/Stapel: ${card.deck}\n\nPrüfungsfrage:\n${card.front}\n\nReferenzantwort (Lernkarte):\n${card.back}\n\nMeine Antwort:\n${plain(answer)}`;
  const userContent = history.length ? userText : withImages(userText, images);
  const messages = [...history, { role: 'user', content: userContent }];
  const { data, content } = await request(settings, { system: withStrictness(EXAMINER_SYSTEM, settings), messages, schema: GRADE_SCHEMA });
  // Antwortblöcke unverändert zurückgeben, damit der Verlauf fortgesetzt werden kann.
  history.push({ role: 'user', content: userContent }, { role: 'assistant', content });
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

// ---------- Prüfungsgespräch: mehrere aufeinander aufbauende Fragen ----------

const EXAM_SYSTEM = `Du bist ein erfahrener, fairer und freundlicher Prüfer in der mündlich-praktischen Prüfung des Dritten Abschnitts der Ärztlichen Prüfung (M3) in Deutschland. Du führst mit einer Medizinstudentin kurz vor dem Examen ein zusammenhängendes Prüfungsgespräch und sprichst sie mit "du" an.

Das Gespräch beginnt mit einer Einstiegsfrage von einer ihrer Lernkarten; die Referenzantwort der Karte ist dafür der Maßstab. Danach führst du das Gespräch wie ein echter Prüfer weiter: Jede deiner Fragen baut auf ihrer letzten Antwort und dem bisherigen Verlauf auf. Typische Richtungen sind Pathophysiologie, Leitsymptome, Differenzialdiagnosen, der nächste diagnostische Schritt, Therapie, Komplikationen, Notfallmanagement oder ein kurzer Patientenfall zum Thema. War eine Antwort lückenhaft, hakst du dort gezielt nach; war sie sicher, gehst du eine Stufe tiefer oder wechselst zu einem angrenzenden Aspekt. Die weiteren Lernkarten aus ihrem Stapel zeigen dir, welcher Stoff für sie relevant ist; du darfst dich daran orientieren, musst es aber nicht.

Pro Runde gibst du zurück: in "reaktion" eine kurze, konkrete Rückmeldung zu ihrer Antwort (ein bis drei Sätze: was stimmt, was fehlt oder falsch ist, mit der richtigen Information, damit sie daraus lernt), in "bewertung" deine Einschätzung dieser einen Antwort, in "fehlt" die wichtigen Punkte, die in ihrer Antwort gefehlt haben, als kurze Stichpunkte (leer, wenn nichts fehlt), in "prozent" als ganze Zahl von 0 bis 100, wie viel der erwarteten Antwort sie inhaltlich richtig abgedeckt hat, und in "frage" genau eine neue Frage. Stelle immer nur eine Frage auf einmal und formuliere sie so, wie man sie mündlich stellen würde.

Für deine eigenen Anschlussfragen gibt es keine Referenzantwort: Bewerte nach gesichertem Lehrbuch- und Leitlinienwissen, sei bei Unsicherheit zurückhaltend und sag offen, wenn etwas nachgeschlagen werden sollte. Bilder der Einstiegskarte sind an der passenden Stelle beigefügt; du darfst dich in deinen Fragen darauf beziehen, sie sieht dasselbe Bild. Steht stattdessen die Marke [Bild], konnte das Bild nicht mitgeschickt werden; stelle dazu keine Fragen. Wortlaut und Tippfehler spielen keine Rolle, die Antworten können diktiert sein.

Am Ende der Prüfung gibst du ein Gesamturteil: eine Note nach der M3-Skala, die Stärken, die wichtigsten Lücken zum Nacharbeiten und ein kurzes, ehrliches und ermutigendes Fazit.`;

// Gilt für Prüfungsgespräch und Fälle: bei unvollständigen Antworten erst nachhaken.
const NACHHAKEN = `Nachhaken: Ist eine Antwort im Kern richtig, aber unvollständig, weil wichtige Punkte fehlen, gehst du noch nicht zur nächsten Frage weiter, und zwar unabhängig davon, wie großzügig du bewertest. Du setzt "nachhaken" auf true, bestätigst in "reaktion" nur kurz, was stimmt, verrätst die fehlenden Punkte noch nicht ("fehlt" bleibt leer) und fragst in "frage" offen nach, so wie ein Prüfer es tut: etwa "Da fehlt noch etwas Wichtiges, was noch?" oder mit einem kleinen Hinweis auf die Richtung, ohne die Lösung zu nennen. Auf dieselbe Frage hakst du höchstens einmal nach. Nach ihrer Ergänzung bewertest du Erstantwort und Ergänzung zusammen, nennst in "fehlt", was dann immer noch fehlt, erklärst es kurz in "reaktion", setzt "nachhaken" auf false und stellst die nächste Frage. War eine Antwort vollständig oder im Kern falsch, hakst du nicht nach, sondern korrigierst und gehst weiter. Runden, in denen du nur nachhakst, zählen nicht zur angekündigten Anzahl der Fragen.`;

const BEWERTUNG = { type: 'string', enum: ['richtig', 'teilweise', 'falsch'] };
const EXAM_TURN_SCHEMA = {
  type: 'object',
  properties: { verstanden: { type: 'string' }, reaktion: { type: 'string' }, bewertung: BEWERTUNG, prozent: { type: 'integer' }, fehlt: { type: 'array', items: { type: 'string' } }, nachhaken: { type: 'boolean' }, frage: { type: 'string' } },
  required: ['verstanden', 'reaktion', 'bewertung', 'prozent', 'fehlt', 'nachhaken', 'frage'],
  additionalProperties: false,
};
const EXAM_FINAL_SCHEMA = {
  type: 'object',
  properties: {
    verstanden: { type: 'string' },
    reaktion: { type: 'string' },
    bewertung: BEWERTUNG,
    prozent: { type: 'integer' },
    fehlt: { type: 'array', items: { type: 'string' } },
    note: { type: 'string', enum: ['sehr gut', 'gut', 'befriedigend', 'ausreichend', 'nicht ausreichend'] },
    staerken: { type: 'array', items: { type: 'string' } },
    luecken: { type: 'array', items: { type: 'string' } },
    fazit: { type: 'string' },
  },
  required: ['verstanden', 'reaktion', 'bewertung', 'prozent', 'fehlt', 'note', 'staerken', 'luecken', 'fazit'],
  additionalProperties: false,
};

// Eine Runde im Prüfungsgespräch. `mode`: 'weiter' (neue Frage), 'letzte' (Antwort bewerten
// und Gesamturteil) oder 'abbruch' (Gesamturteil ohne neue Antwort).
export async function examTurn(settings, exam, answer, mode) {
  let userText;
  if (mode === 'abbruch') {
    userText = 'Ich beende die Prüfung an dieser Stelle, ohne die letzte Frage zu beantworten. Gib dein Gesamturteil über das bisherige Gespräch. Lass "reaktion" leer und wiederhole in "bewertung" die Einschätzung meiner letzten Antwort.';
  } else if (!exam.history.length) {
    const others = exam.context.map((c) => `Frage: ${plain(c.front)}\nAntwort: ${plain(c.back)}`).join('\n\n');
    userText = `Fach/Stapel: ${exam.card.deck}\n\nEinstiegsfrage (Lernkarte):\n${exam.card.front}\n\nReferenzantwort (Lernkarte):\n${exam.card.back}`
      + (others ? `\n\nWeitere Lernkarten aus demselben Stapel zur Orientierung:\n\n${others}` : '')
      + `\n\nMeine Antwort auf die Einstiegsfrage:\n${plain(answer)}`;
  } else {
    userText = `Meine Antwort:\n${answer}`;
  }
  if (mode === 'letzte') userText += '\n\n(Das war die letzte Frage dieser Prüfung. Bewerte diese Antwort und gib dann dein Gesamturteil.)';

  const userContent = exam.history.length ? userText : withImages(userText, exam.images);
  const messages = [...exam.history, { role: 'user', content: userContent }];
  const { data, content } = await request(settings, { system: withStrictness(`${EXAM_SYSTEM}\n\n${NACHHAKEN}`, settings), messages, schema: mode === 'weiter' ? EXAM_TURN_SCHEMA : EXAM_FINAL_SCHEMA });
  exam.history.push({ role: 'user', content: userContent }, { role: 'assistant', content });
  return data;
}

// ---------- Fallbeispiele: die KI erfindet einen Patientenfall und führt durch ihn ----------

const CASE_SYSTEM = `Du bist ein erfahrener, fairer und freundlicher Prüfer in der mündlich-praktischen Prüfung des Dritten Abschnitts der Ärztlichen Prüfung (M3) in Deutschland. Du prüfst eine Medizinstudentin kurz vor dem Examen anhand eines Patientenfalls und sprichst sie mit "du" an.

Zu Beginn denkst du dir einen realistischen, prüfungstypischen Fall aus dem genannten Fach aus: ein häufiges oder klinisch wichtiges Krankheitsbild, wie es im M3 in Deutschland gefragt wird, mit Name, Alter, Situation (zum Beispiel Hausarztpraxis, Notaufnahme, Station, OP, Intensivstation, Rettungsdienst) und Leitsymptom. In "vorstellung" beschreibst du die Ausgangssituation in zwei bis vier Sätzen, ohne die Diagnose zu verraten, und in "titel" gibst du dem Fall eine kurze Überschrift, die die Diagnose ebenfalls nicht verrät (zum Beispiel "Frau Müller, 54, Bauchschmerzen"). Die erste Frage ist offen, etwa nach dem ersten Schritt oder dem weiteren Vorgehen.

Danach führst du sie Schritt für Schritt durch den Fall, wie ein echter Prüfer: Anamnese, körperliche Untersuchung, Verdachts- und Differenzialdiagnosen, Diagnostik, Therapie, Komplikationen, Aufklärung und weiteres Vorgehen. Jede Frage baut auf ihrer letzten Antwort auf. Fordert sie Anamnese, Untersuchung oder Diagnostik an, lieferst du in deiner nächsten Frage die passenden Befunde (zum Beispiel Vitalparameter, Laborwerte, EKG- oder Bildgebungsbefund in Worten) und fragst nach deren Einordnung oder dem nächsten Schritt. So entwickelt sich der Fall weiter, bis Diagnose und Behandlung geklärt sind. Verteile die Fragen so, dass der Fall mit der angekündigten Zahl an Fragen sinnvoll abgeschlossen ist.

Pro Runde gibst du zurück: in "reaktion" eine kurze, konkrete Rückmeldung zu ihrer Antwort (ein bis drei Sätze: was stimmt, was fehlt oder falsch ist, mit der richtigen Information, damit sie daraus lernt), in "bewertung" deine Einschätzung dieser einen Antwort, in "fehlt" die wichtigen Punkte, die in ihrer Antwort gefehlt haben, als kurze Stichpunkte (leer, wenn nichts fehlt), in "prozent" als ganze Zahl von 0 bis 100, wie viel der erwarteten Antwort sie inhaltlich richtig abgedeckt hat, und in "frage" die neuen Informationen zum Fall und genau eine neue Frage. Formuliere so, wie man im Mündlichen spricht.

Es gibt keine Referenzantworten: Bewerte nach gesichertem Lehrbuch- und aktuellem Leitlinienwissen für Deutschland, sei bei Unsicherheit zurückhaltend und sag offen, wenn etwas nachgeschlagen werden sollte. Wortlaut und Tippfehler spielen keine Rolle, die Antworten können diktiert sein.

Am Ende gibst du ein Gesamturteil: eine Note nach der M3-Skala, die Stärken, die wichtigsten Lücken zum Nacharbeiten und ein kurzes, ehrliches und ermutigendes Fazit, in dem du auch die Diagnose und den roten Faden des Falls in ein, zwei Sätzen zusammenfasst.`;

const CASE_START_SCHEMA = {
  type: 'object',
  properties: { titel: { type: 'string' }, vorstellung: { type: 'string' }, frage: { type: 'string' } },
  required: ['titel', 'vorstellung', 'frage'],
  additionalProperties: false,
};

// Eine Runde im Fallbeispiel. `mode`: 'start' (Fall erzeugen), 'weiter', 'letzte' oder 'abbruch'.
export async function caseTurn(settings, cs, answer, mode) {
  let userText;
  if (mode === 'start') {
    userText = `Fach: ${cs.fach}`
      + (cs.thema ? `\nGewünschtes Thema: ${cs.thema}` : '')
      + `\nAnzahl der Fragen in dieser Prüfung: ${cs.total}`
      + (cs.avoid.length ? `\n\nDiese Fälle hatte ich zuletzt schon, bitte ein anderes Krankheitsbild wählen:\n${cs.avoid.map((t) => `- ${t}`).join('\n')}` : '')
      + '\n\nStelle mir den Fall vor und stelle die erste Frage.';
  } else if (mode === 'abbruch') {
    userText = 'Ich beende die Prüfung an dieser Stelle, ohne die letzte Frage zu beantworten. Gib dein Gesamturteil über das bisherige Gespräch. Lass "reaktion" leer und wiederhole in "bewertung" die Einschätzung meiner letzten Antwort.';
  } else {
    userText = `Meine Antwort:\n${answer}`;
    if (mode === 'letzte') userText += '\n\n(Das war die letzte Frage dieser Prüfung. Bewerte diese Antwort und gib dann dein Gesamturteil.)';
  }
  const schema = mode === 'start' ? CASE_START_SCHEMA : mode === 'weiter' ? EXAM_TURN_SCHEMA : EXAM_FINAL_SCHEMA;
  const messages = [...cs.history, { role: 'user', content: userText }];
  const { data, content } = await request(settings, { system: withStrictness(`${CASE_SYSTEM}\n\n${NACHHAKEN}`, settings), messages, schema });
  cs.history.push({ role: 'user', content: userText }, { role: 'assistant', content });
  return data;
}

export async function testKey(settings) {
  const { data } = await request(settings, {
    system: 'Antworte knapp.',
    messages: [{ role: 'user', content: 'Antworte mit ok=true.' }],
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  });
  return data.ok === true;
}
