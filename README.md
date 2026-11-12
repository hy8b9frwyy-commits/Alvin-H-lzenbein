# M3 Coach

Kleine Lern-App fürs M3 (mündlich-praktische Prüfung): fragt Anki-Karten ab, zeigt Tagesziel und Fortschritt und motiviert mit Serien, Erfolgen und persönlichen Nachrichten.

Reine Web-App ohne Server und ohne Build-Schritt. Alle Daten bleiben auf dem Gerät.

## Funktionen

- **Import aus Anki** (Text-Export, inkl. Lückentext-Karten) oder per Einfügen
- **Mündliche Prüfung**: Frage lesen, laut antworten, Musterantwort vergleichen, selbst bewerten
- **Multiple Choice**: Optionen aus den eigenen Karten, mit API-Schlüssel von der KI erzeugt
- **KI-Prüfer**: Antwort tippen oder diktieren, die KI bewertet anhand der Karte und stellt eine Nachfrage
- **Heute-Seite**: Countdown, Tagesziel, Serie, Fortschritt pro Stapel, Erfolge
- Schwierige Karten kommen häufiger wieder (Stufen mit 1, 3, 7, 14, 30 Tagen Abstand)

## Persönliche Nachrichten anpassen

Texte in [`nachrichten.js`](nachrichten.js) ändern. Zusätzliche Nachrichten gehen auch in der App unter „Mehr“.

## Online stellen (GitHub Pages)

1. Im Repository: **Settings → Pages → Deploy from a branch**, Branch auswählen, Ordner `/ (root)`.
2. Die angezeigte Adresse auf dem Handy öffnen.
3. iPhone: **Teilen → Zum Home-Bildschirm**. Android: **Menü → App installieren**.

Wichtig: Als installierte App bleiben die Daten zuverlässig erhalten. Trotzdem ab und zu unter „Mehr“ ein Backup ziehen.

## KI-Prüfer einrichten

1. Auf https://console.anthropic.com einen API-Schlüssel anlegen und Guthaben aufladen.
2. In der App unter **Mehr → KI-Prüfer** eintragen und „Schlüssel testen“ drücken.

Der Schlüssel liegt nur auf dem Gerät. Am besten in der Konsole ein Ausgabenlimit setzen.

## Lokal ausprobieren

```
python3 -m http.server 8000
```

Dann http://localhost:8000 öffnen. Unter „Karten“ gibt es Beispielkarten zum Testen.

## Aufbau

- `index.html`, `css/style.css`: Oberfläche
- `js/app.js`: Ansichten und Lernlogik
- `js/anki.js`: Import
- `js/ai.js`: Anbindung an die Claude-API
- `vendor/anthropic-sdk.js`: gebündeltes offizielles Anthropic-SDK
