import { createDatabase, sanitizeDatabase } from './database.js';

const DATABASE_NAME = 'audit-gaji-db';
const STORE_NAME = 'state';
const LEGACY_SCOPE = 'legacy';
const LEGACY_INDEXEDDB_KEY = 'database';
const FALLBACK_PREFIX = 'audit-gaji-database-v3:';
const LEGACY_FALLBACK_KEY = 'audit-gaji-database-v1';

function normalizeScope(scope) {
  const value = String(scope || LEGACY_SCOPE).trim();
  return value || LEGACY_SCOPE;
}

function indexedDbKey(scope) {
  const normalized = normalizeScope(scope);
  return normalized === LEGACY_SCOPE ? LEGACY_INDEXEDDB_KEY : `database:${normalized}`;
}

function fallbackKey(scope) {
  const normalized = normalizeScope(scope);
  return normalized === LEGACY_SCOPE ? LEGACY_FALLBACK_KEY : `${FALLBACK_PREFIX}${normalized}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened.'));
  });
}

async function readIndexedDb(scope) {
  if (!('indexedDB' in window)) return null;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(indexedDbKey(scope));
    request.onsuccess = () => resolve(request.result ? sanitizeDatabase(request.result) : null);
    request.onerror = () => {
      database.close();
      reject(request.error || new Error('IndexedDB data could not be read.'));
    };
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => database.close();
  });
}

async function writeIndexedDb(value, scope) {
  if (!('indexedDB' in window)) throw new Error('IndexedDB is not available.');
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, indexedDbKey(scope));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error('Data could not be saved to IndexedDB.'));
    };
    transaction.onabort = () => database.close();
  });
}

async function deleteIndexedDb(scope) {
  if (!('indexedDB' in window)) return;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(indexedDbKey(scope));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error('IndexedDB data could not be cleared.'));
    };
    transaction.onabort = () => database.close();
  });
}

export async function loadDatabaseOrNull(scope = LEGACY_SCOPE) {
  try {
    const value = await readIndexedDb(scope);
    if (value) return value;
  } catch {
    // The fallback is used when the browser restricts IndexedDB.
  }
  try {
    const raw = localStorage.getItem(fallbackKey(scope));
    return raw ? sanitizeDatabase(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function loadDatabase(scope = LEGACY_SCOPE) {
  return (await loadDatabaseOrNull(scope)) || createDatabase();
}

export async function saveDatabase(database, scope = LEGACY_SCOPE) {
  const safe = sanitizeDatabase(database);
  try {
    await writeIndexedDb(safe, scope);
    try {
      localStorage.removeItem(fallbackKey(scope));
    } catch {}
  } catch {
    localStorage.setItem(fallbackKey(scope), JSON.stringify(safe));
  }
}

export async function clearDatabase(scope = LEGACY_SCOPE) {
  try {
    await deleteIndexedDb(scope);
  } catch {
    // The fallback storage is still cleared below.
  }
  try {
    localStorage.removeItem(fallbackKey(scope));
  } catch {}
}
