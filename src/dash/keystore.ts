// The intercessor's keys live in this browser's IndexedDB and nowhere else.

import type { StationKeys } from '../shared/crypto';

const DB = 'prayer-station';
const STORE = 'keys';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

export const loadKeys = () => run<StationKeys | undefined>('readonly', (s) => s.get('station'));
export const saveKeys = (keys: StationKeys) => run('readwrite', (s) => s.put(keys, 'station'));
export const clearKeys = () => run('readwrite', (s) => s.delete('station'));
