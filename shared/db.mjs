// On-device storage (IndexedDB), shared by the main app and the review screen.
// Nothing here talks to the network.
//   projects  — briefs/motions (points, chats, research)
//   cases     — pulled opinions + every saved analysis
//   versions  — every version of a draft brief
//   reviews   — every review round (ReviewBuddy-style marks, notes, ratings)
//   kv        — small settings documents (e.g. the brief-writing manual)

const DB_NAME = 'casereview';
const DB_VERSION = 2;

let opening = null;
export function openDb() {
  return opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('cases')) d.createObjectStore('cases', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('versions')) d.createObjectStore('versions', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      if (!d.objectStoreNames.contains('reviews')) {
        const s = d.createObjectStore('reviews', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('versionId', 'versionId');
      }
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => { d.close(); opening = null; };
      resolve(d);
    };
    r.onerror = () => { opening = null; reject(r.error); };
    r.onblocked = () => reject(new Error('Close other Case Review tabs and try again.'));
  });
}

async function tx(store, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was aborted'));
  });
}

export const db = {
  get: (s, id) => tx(s, 'readonly', (st) => st.get(id)),
  put: (s, o) => tx(s, 'readwrite', (st) => st.put(o)),
  del: (s, id) => tx(s, 'readwrite', (st) => st.delete(id)),
  all: (s) => tx(s, 'readonly', (st) => st.getAll()),
  clear: (s) => tx(s, 'readwrite', (st) => st.clear()),
  byIndex: (s, index, value) => tx(s, 'readonly', (st) => st.index(index).getAll(value)),
};

export const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
