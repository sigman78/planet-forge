import type { PlanetData } from '../core/types.ts';
import type { GenParams } from '../gen/params.ts';

// Generated planets cached in IndexedDB (localStorage holds ~5 MB; one 512² planet is ~25 MB).
// The key covers every generator parameter plus a hash of the generator source (injected at build
// time), so any generator change invalidates old entries. Least recently used entries are evicted.

declare const __GEN_HASH__: string;

const DB_NAME = 'planet-forge';
const DATA = 'planets'; // { key, planet }
const META = 'meta'; // { key, used } - small, so eviction never loads planet data
const MAX_ENTRIES = 6;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(DATA, { keyPath: 'key' });
          req.result.createObjectStore(META, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null); // private mode, blocked storage, ...
      }
    });
  }
  return dbPromise;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function cacheKey(params: GenParams): string {
  const p = params as unknown as Record<string, unknown>;
  const body = Object.keys(p).sort().map((k) => `${k}=${JSON.stringify(p[k])}`).join('&');
  return `${typeof __GEN_HASH__ === 'string' ? __GEN_HASH__ : 'dev'}|${body}`;
}

export async function loadCached(params: GenParams): Promise<PlanetData | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const key = cacheKey(params);
    const tx = db.transaction([DATA, META], 'readwrite');
    const e = (await request(tx.objectStore(DATA).get(key))) as { planet: PlanetData } | undefined;
    if (!e) return null;
    tx.objectStore(META).put({ key, used: Date.now() });
    return e.planet;
  } catch {
    return null;
  }
}

export async function storeCached(params: GenParams, planet: PlanetData): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const key = cacheKey(params);
    const tx = db.transaction([DATA, META], 'readwrite');
    tx.objectStore(DATA).put({ key, planet });
    tx.objectStore(META).put({ key, used: Date.now() });
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    // Evict the least recently used entries beyond the limit.
    const meta = (await request(db.transaction(META, 'readonly').objectStore(META).getAll())) as { key: string; used: number }[];
    if (meta.length > MAX_ENTRIES) {
      meta.sort((a, b) => b.used - a.used);
      const del = db.transaction([DATA, META], 'readwrite');
      for (const m of meta.slice(MAX_ENTRIES)) {
        del.objectStore(DATA).delete(m.key);
        del.objectStore(META).delete(m.key);
      }
    }
  } catch {
    // Quota exceeded or storage unavailable: caching is best effort.
  }
}

export async function clearCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([DATA, META], 'readwrite');
    tx.objectStore(DATA).clear();
    tx.objectStore(META).clear();
  } catch {
    /* ignore */
  }
}
