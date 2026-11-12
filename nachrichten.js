// Deine persönlichen Nachrichten an sie. Einfach die Texte hier anpassen.
// Weitere Nachrichten lassen sich auch direkt in der App unter "Mehr" hinzufügen.

export const NACHRICHTEN = {
  // Von wem die Nachrichten sind (lässt sich in der App überschreiben)
  absender: 'Alvin',

  // Begrüßung je nach Tageszeit; {name} wird durch ihren Namen ersetzt
  tageszeit: {
    morgen: { gruss: 'Guten Morgen{name}! ☀️', saetze: ['Erst Kaffee, dann Karten. Du schaffst das.', 'Neuer Tag, neues Wissen. Los geht’s!', 'Guten Start in den Tag, meine Lieblingsärztin.'] },
    mittag: { gruss: 'Hallo{name}! 👋', saetze: ['Schön, dass du da bist.', 'Kurz ein paar Karten? Jede zählt.', 'Halbzeit am Tag. Du liegst gut im Rennen.'] },
    abend: { gruss: 'Guten Abend{name}! 🌙', saetze: ['Noch eine kleine Runde, dann Feierabend.', 'Der Tag war lang. Du bist trotzdem hier. Stark!', 'Gleich geschafft für heute.'] },
    nacht: { gruss: 'Noch wach{name}? 🦉', saetze: ['Schlaf ist auch Prüfungsvorbereitung. Mach nicht mehr zu lang.', 'Eine Runde noch, dann ab ins Bett.'] },
  },

  // Erscheint, wenn eine Runde, ein Prüfungsgespräch oder ein Fall geschafft ist
  lob: [
    'Dein Schatz ist stolz auf dich!',
    'Dein Schatz ist so stolz auf dich. Weiter so!',
    'Alvin ist stolz auf dich!',
    'Wieder etwas geschafft. Du bist großartig!',
    'Das war stark. Dein Schatz feiert dich!',
  ],

  // Eine davon erscheint jeden Tag auf der Startseite
  taeglich: [
    'Alvin ist unglaublich stolz auf dich. Jeden Tag ein Stück näher!',
    'Du hast schon so viel geschafft. Den Rest schaffst du auch.',
    'Heute nur das Tagesziel. Mehr musst du nicht, weniger gilt nicht. 😉',
    'Bald steht „Dr.“ vor deinem Namen. Ich übe schon mal die Anrede.',
    'Wenn du fertig bist, kocht Alvin. Versprochen.',
    'Karte für Karte. Du machst das großartig.',
    'Pause machen ist auch Lernen. Trink was!',
    'Egal wie der Tag läuft: Alvin glaubt an dich.',
    'Dein Schatz denkt an dich. Du packst das!',
    'Jeden Tag ein bisschen. Genau so wird man Ärztin.',
    'Ich hab dich lieb. Und jetzt: ran an die Karten! 😘',
  ],

  // Erscheint, wenn das Tagesziel geschafft ist
  zielErreicht: [
    'Tagesziel geschafft! Dein Schatz ist stolz auf dich. 💛',
    'Tagesziel geschafft! Feierabend hast du dir verdient. 🎉',
    'Stark! Wieder ein Tag abgehakt. Alvin feiert dich!',
    'Geschafft! Jetzt Laptop zu und raus mit dir.',
  ],

  // Erscheint bei einer Lernserie von genau so vielen Tagen
  serie: {
    3: 'Drei Tage am Stück. Läuft bei dir!',
    7: 'Eine ganze Woche durchgezogen. Alvin ist baff!',
    14: 'Zwei Wochen Serie. Du bist nicht aufzuhalten.',
    30: '30 Tage! Dafür lädt Alvin dich richtig gut zum Essen ein.',
  },
};
