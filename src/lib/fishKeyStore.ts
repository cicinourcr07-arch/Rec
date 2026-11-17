/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type FishConnectionStatus =
  | 'connected'
  | 'unverified'
  | 'invalid_key'
  | 'connection_error'
  | 'not_configured';

export interface FishIntegrationSnapshot {
  status: FishConnectionStatus;
  integrationConfigured: boolean;
  localKeySaved: boolean;
  localStorageMode: 'indexeddb' | 'session' | 'none';
  keySource: 'indexeddb' | 'session' | 'server_env' | 'none';
  authenticated: boolean;
  serviceReachable: boolean;
  message: string;
  checkedAt: string | null;
}

interface StoredFishCredential {
  id: 'fish_audio_api_key';
  apiKey: string;
  updatedAt: string;
}

const DB_NAME = 'recap_studio_personal_keys_v1';
const DB_VERSION = 1;
const STORE_NAME = 'fish_audio_credentials';
const RECORD_ID = 'fish_audio_api_key';

// Session-only memory holder when "Remember API Key on this device" is unchecked
let sessionOnlyFishApiKey: string | null = null;
let sessionUpdatedAt: string | null = null;

let lastFishSnapshot: FishIntegrationSnapshot = {
  status: 'not_configured',
  integrationConfigured: false,
  localKeySaved: false,
  localStorageMode: 'none',
  keySource: 'none',
  authenticated: false,
  serviceReachable: false,
  message: 'No Fish Audio API key configured.',
  checkedAt: null,
};

const snapshotListeners = new Set<(snapshot: FishIntegrationSnapshot) => void>();

export function getLastFishSnapshot(): FishIntegrationSnapshot {
  return lastFishSnapshot;
}

export function setLastFishSnapshot(next: FishIntegrationSnapshot): FishIntegrationSnapshot {
  lastFishSnapshot = next;
  snapshotListeners.forEach((listener) => {
    try {
      listener(next);
    } catch {
      // ignore subscriber errors
    }
  });
  return next;
}

export function subscribeFishSnapshot(
  listener: (snapshot: FishIntegrationSnapshot) => void
): () => void {
  snapshotListeners.add(listener);
  listener(lastFishSnapshot);
  return () => {
    snapshotListeners.delete(listener);
  };
}

function openPersonalKeyDb(): Promise<IDBDatabase> {
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
          'IndexedDB access was blocked by the browser. Enable site storage permissions to store your personal API key locally.'
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
          'Unable to open IndexedDB for local key storage. Check browser storage permissions or disable strict private-mode blocking.'
        )
      );
  });
}

async function withCredentialStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openPersonalKeyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(new Error('IndexedDB operation failed while accessing local Fish Audio settings.'));
    });
  } finally {
    db.close();
  }
}

export async function checkFishKeyIndexedDbSupport(): Promise<{
  available: boolean;
  reason?: string;
}> {
  try {
    const db = await openPersonalKeyDb();
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

export async function savePersonalFishApiKey(
  rawApiKey: string,
  rememberOnDevice: boolean
): Promise<{ rememberOnDevice: boolean; updatedAt: string }> {
  const cleanKey = rawApiKey.trim();
  if (!cleanKey) {
    throw new Error('Please enter a valid Fish Audio API key before saving.');
  }
  if (/[\r\n\s]/.test(cleanKey)) {
    throw new Error('Fish Audio API key must not contain spaces or line breaks.');
  }

  const now = new Date().toISOString();

  if (rememberOnDevice) {
    const record: StoredFishCredential = {
      id: RECORD_ID,
      apiKey: cleanKey,
      updatedAt: now,
    };
    // Strictly require IndexedDB when remembering; never silently fall back to localStorage
    await withCredentialStore('readwrite', (store) => store.put(record));
    sessionOnlyFishApiKey = cleanKey;
    sessionUpdatedAt = now;
    setLastFishSnapshot({
      ...lastFishSnapshot,
      status: 'unverified',
      localKeySaved: true,
      localStorageMode: 'indexeddb',
      keySource: 'indexeddb',
      authenticated: false,
      message: 'API key saved locally in IndexedDB. Verifying with Fish Audio...',
      checkedAt: null,
    });
    return { rememberOnDevice: true, updatedAt: now };
  }

  // Session-only mode: remove any prior persisted IndexedDB copy if IndexedDB exists
  const support = await checkFishKeyIndexedDbSupport();
  if (support.available) {
    await withCredentialStore('readwrite', (store) => store.delete(RECORD_ID));
  }
  sessionOnlyFishApiKey = cleanKey;
  sessionUpdatedAt = now;
  setLastFishSnapshot({
    ...lastFishSnapshot,
    status: 'unverified',
    localKeySaved: true,
    localStorageMode: 'session',
    keySource: 'session',
    authenticated: false,
    message: 'API key kept for this session. Verifying with Fish Audio...',
    checkedAt: null,
  });
  return { rememberOnDevice: false, updatedAt: now };
}

export async function loadPersonalFishKeyState(): Promise<{
  apiKey: string | null;
  rememberOnDevice: boolean;
  updatedAt: string | null;
  indexedDbAvailable: boolean;
  storageError?: string;
}> {
  const support = await checkFishKeyIndexedDbSupport();

  if (support.available) {
    try {
      const record = await withCredentialStore<StoredFishCredential | undefined>(
        'readonly',
        (store) => store.get(RECORD_ID)
      );
      if (record && typeof record.apiKey === 'string' && record.apiKey.trim()) {
        sessionOnlyFishApiKey = record.apiKey.trim();
        sessionUpdatedAt = record.updatedAt || null;
        return {
          apiKey: sessionOnlyFishApiKey,
          rememberOnDevice: true,
          updatedAt: sessionUpdatedAt,
          indexedDbAvailable: true,
        };
      }
    } catch (err) {
      return {
        apiKey: sessionOnlyFishApiKey,
        rememberOnDevice: false,
        updatedAt: sessionUpdatedAt,
        indexedDbAvailable: false,
        storageError:
          err instanceof Error
            ? err.message
            : 'Unable to read Fish Audio API key from IndexedDB.',
      };
    }
  }

  return {
    apiKey: sessionOnlyFishApiKey,
    rememberOnDevice: false,
    updatedAt: sessionUpdatedAt,
    indexedDbAvailable: support.available,
    storageError: support.available ? undefined : support.reason,
  };
}

export async function getPersonalFishApiKey(): Promise<string | null> {
  if (sessionOnlyFishApiKey) {
    return sessionOnlyFishApiKey;
  }
  const state = await loadPersonalFishKeyState();
  return state.apiKey;
}

export async function hasPersonalFishApiKey(): Promise<boolean> {
  const key = await getPersonalFishApiKey();
  return Boolean(key && key.trim().length > 0);
}

export async function deletePersonalFishApiKey(): Promise<void> {
  sessionOnlyFishApiKey = null;
  sessionUpdatedAt = null;
  const support = await checkFishKeyIndexedDbSupport();
  if (support.available) {
    await withCredentialStore('readwrite', (store) => store.delete(RECORD_ID));
  }
  setLastFishSnapshot({
    ...lastFishSnapshot,
    status: 'not_configured',
    localKeySaved: false,
    localStorageMode: 'none',
    keySource: 'none',
    authenticated: false,
    message: 'Personal Fish Audio API key removed from this device.',
    checkedAt: null,
  });
}
