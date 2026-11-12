// Optionale, bessere Spracherkennung: Die Aufnahme geht an die Transkriptions-API von OpenAI.
// Der Schlüssel dafür liegt wie der Anthropic-Schlüssel nur lokal auf dem Gerät.

const MODELS = ['gpt-4o-transcribe', 'whisper-1'];

export async function transcribe(key, blob, hint) {
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('wav') ? 'wav' : 'webm';
  let lastError = 'Die Spracherkennung hat nicht geantwortet.';
  for (const model of MODELS) {
    const form = new FormData();
    form.append('file', blob, `antwort.${ext}`);
    form.append('model', model);
    form.append('language', 'de');
    if (hint) form.append('prompt', hint);
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    } catch {
      throw new Error('Keine Verbindung zur Spracherkennung. Bist du online?');
    }
    if (res.ok) return ((await res.json()).text || '').trim();
    if (res.status === 401) throw new Error('Der OpenAI-Schlüssel ist ungültig. Bitte unter „Mehr“ prüfen.');
    if (res.status === 429) throw new Error('Spracherkennung: zu viele Anfragen oder Guthaben aufgebraucht.');
    const body = await res.json().catch(() => null);
    lastError = `Spracherkennung fehlgeschlagen (${res.status}): ${body?.error?.message || 'unbekannter Fehler'}`;
    // Modell nicht verfügbar: nächstes versuchen, sonst abbrechen
    if (res.status !== 404 && !/model/i.test(body?.error?.message || '')) break;
  }
  throw new Error(lastError);
}
