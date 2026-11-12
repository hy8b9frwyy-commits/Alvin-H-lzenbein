// Speichert den App-Zustand und die Bilder der Karten lokal auf dem Gerät (IndexedDB).
const DB = 'm3coach';
const STORE = 'kv';
const MEDIA = 'media';

let dbPromise;
function open() {
  return (dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const load = () => run(STORE, 'readonly', (s) => s.get('state'));
export const save = (state) => run(STORE, 'readwrite', (s) => s.put(state, 'state'));

// Bilder: { type, data: ArrayBuffer } unter ihrem Dateinamen
export const putMedia = (name, type, data) => run(MEDIA, 'readwrite', (s) => s.put({ type, data }, name));
export const getMedia = (name) => run(MEDIA, 'readonly', (s) => s.get(name));
export const mediaNames = () => run(MEDIA, 'readonly', (s) => s.getAllKeys());
export const deleteMedia = (names) => run(MEDIA, 'readwrite', (s) => { for (const n of names) s.delete(n); });
