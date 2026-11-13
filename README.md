# Modelmappe

Baukasten für eine Model-Mappe im Editorial-Look: eine Web-Mappe, ein A4-PDF und eine Sedcard (Comp Card) aus denselben Fotos und Angaben.

Fotos und persönliche Angaben liegen **nicht** in diesem Repository. Die Ordner `photos/`, `private/` und `dist/` sind in `.gitignore` ausgeschlossen.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `mappe/build.py` | Bereitet die Fotos auf (Ausrichtung, Farbprofil, Look, Größen) und erzeugt die HTML-Seiten |
| `mappe/render.js` | Erzeugt daraus die PDFs und Kontroll-Screenshots (Playwright/Chromium) |
| `mappe/templates/` | Vorlagen für Web-Mappe, A4-Mappe und Sedcard |
| `mappe/profile.example.json` | Beispiel für Name, Maße und Kontakt |
| `mappe/layout.example.json` | Beispiel für Bildauswahl, Reihenfolge und Look je Foto |

## Benutzen

```bash
# 1. Fotos nach photos/ legen, Angaben nach private/profile.json und private/layout.json kopieren und anpassen
python3 mappe/build.py --profile private/profile.json --layout private/layout.json --photos photos --out dist
# 2. PDFs und Screenshots erzeugen
node mappe/render.js dist --shots
```

Ohne Fotos zeichnet das Skript Platzhalter, so lässt sich das Layout auch ohne Bilder prüfen:

```bash
python3 mappe/build.py --out dist && node mappe/render.js dist --shots
```

Ergebnis in `dist/`: `web/index.html` mit Bildern, `*-Portfolio.pdf`, `*-Portfolio-email.pdf` (klein, zum Verschicken) und `*-Compcard.pdf`.

## Look je Foto

In `layout.json` steuert `look` die Aufbereitung: `natural` (unverändert, für Digitals), `color` (dezenter Kontrast) oder `bw` (Schwarz-Weiß mit feinem Korn). Mit `pos` legst du den Bildausschnitt fest, zum Beispiel `"50% 25%"`.
