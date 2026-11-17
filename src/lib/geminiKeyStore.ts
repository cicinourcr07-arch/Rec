/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type GeminiConnectionStatus =
  | 'connected'
  | 'invalid_key'
  | 'connection_error'
  | 'not_configured';

interface StoredGeminiCredential {
  id: 'gemini_api_key';
  apiKey: string;
  updatedAt: string;
}

const DB_NAME = 'recap_studio_gemini_keys_v1';
const DB_VERSION = 1;
const STORE_NAME = 'gemini_credentials';
const RECORD_ID = 'gemini_api_key';

// Session-only memory holder when "Remember API Key on this device" is unchecked
let sessionOnlyGeminiApiKey: string | null = null;
let sessionUpdatedAt: string | null = null;

function openGeminiKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
      reject(
        new Error(
          'IndexedDB is unavailable in this browser. Local persistent storage cannot be accessed (for example in restricted private browsing or disabled site storage).'
        )
      );
      return;
    }

    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      reject(
        new Error(
          'IndexedDB access was blocked by the browser. Enable site storage permissions to store your personal Gemini API key locally.'
        )
      );
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(
        new Error(
          'Unable to open IndexedDB for local Gemini key storage. Check browser storage permissions or disable strict private-mode blocking.'
        )
      );
  });
}

async function withCredentialStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openGeminiKeyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(new Error('IndexedDB operation failed while accessing local Gemini API settings.'));
    });
  } finally {
    db.close();
  }
}

export async function checkGeminiKeyIndexedDbSupport(): Promise<{
  available: boolean;
  reason?: string;
}> {
  try {
    const db = await openGeminiKeyDb();
    db.close();
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason:
        err instanceof Error
          ? err.message
          : 'IndexedDB is unavailable in this browser environment.',
    };
  }
}

export async function savePersonalGeminiApiKey(
  rawApiKey: string,
  rememberOnDevice: boolean
): Promise<{ rememberOnDevice: boolean; updatedAt: string }> {
  const cleanKey = rawApiKey.trim();
  if (!cleanKey) {
    throw new Error('Please enter a valid Gemini API key before saving.');
  }
  if (/[\r\n\s]/.test(cleanKey)) {
    throw new Error('Gemini API key must not contain spaces or line breaks.');
  }

  const now = new Date().toISOString();

  if (rememberOnDevice) {
    const record: StoredGeminiCredential = {
      id: RECORD_ID,
      apiKey: cleanKey,
      updatedAt: now,
    };
    await withCredentialStore('readwrite', (store) => store.put(record));
    sessionOnlyGeminiApiKey = cleanKey;
    sessionUpdatedAt = now;
    return { rememberOnDevice: true, updatedAt: now };
  }

  const support = await checkGeminiKeyIndexedDbSupport();
  if (support.available) {
    await withCredentialStore('readwrite', (store) => store.delete(RECORD_ID));
  }
  sessionOnlyGeminiApiKey = cleanKey;
  sessionUpdatedAt = now;
  return { rememberOnDevice: false, updatedAt: now };
}

export async function loadPersonalGeminiKeyState(): Promise<{
  apiKey: string | null;
  rememberOnDevice: boolean;
  updatedAt: string | null;
  indexedDbAvailable: boolean;
  storageError?: string;
}> {
  const support = await checkGeminiKeyIndexedDbSupport();

  if (support.available) {
    try {
      const record = await withCredentialStore<StoredGeminiCredential | undefined>(
        'readonly',
        (store) => store.get(RECORD_ID)
      );
      if (record && typeof record.apiKey === 'string' && record.apiKey.trim()) {
        sessionOnlyGeminiApiKey = record.apiKey.trim();
        sessionUpdatedAt = record.updatedAt || null;
        return {
          apiKey: sessionOnlyGeminiApiKey,
          rememberOnDevice: true,
          updatedAt: sessionUpdatedAt,
          indexedDbAvailable: true,
        };
      }
    } catch (err) {
      return {
        apiKey: sessionOnlyGeminiApiKey,
        rememberOnDevice: false,
        updatedAt: sessionUpdatedAt,
        indexedDbAvailable: false,
        storageError:
          err instanceof Error
            ? err.message
            : 'Unable to read Gemini API key from IndexedDB.',
      };
    }
  }

  return {
    apiKey: sessionOnlyGeminiApiKey,
    rememberOnDevice: false,
    updatedAt: sessionUpdatedAt,
    indexedDbAvailable: support.available,
    storageError: support.available ? undefined : support.reason,
  };
}

export async function getPersonalGeminiApiKey(): Promise<string | null> {
  if (sessionOnlyGeminiApiKey) {
    return sessionOnlyGeminiApiKey;
  }
  const state = await loadPersonalGeminiKeyState();
  return state.apiKey;
}

export async function hasPersonalGeminiApiKey(): Promise<boolean> {
  const key = await getPersonalGeminiApiKey();
  return Boolean(key && key.trim().length > 0);
}

export async function deletePersonalGeminiApiKey(): Promise<void> {
  sessionOnlyGeminiApiKey = null;
  sessionUpdatedAt = null;
  const support = await checkGeminiKeyIndexedDbSupport();
  if (support.available) {
    await withCredentialStore('readwrite', (store) => store.delete(RECORD_ID));
  }
}
