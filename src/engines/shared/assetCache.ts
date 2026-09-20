const CACHE_DATABASE = "just-go-engine-assets";
const CACHE_STORE = "assets";
const CACHE_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export interface CachedAssetRecord {
  readonly key: string;
  readonly sha256: string;
  readonly bytes: ArrayBuffer;
}

export interface ChunkedAssetManifest {
  readonly version?: number;
  readonly originalFilename: string;
  readonly size: number;
  readonly chunkBytes?: number;
  readonly chunkSizes: readonly number[];
  readonly sha256: string;
  readonly chunks: readonly string[];
}

export type ChunkFetcher = (url: string, index: number) => Promise<ArrayBuffer>;

export interface LoadChunkedAssetOptions {
  readonly baseUrl?: string | URL;
  readonly cacheKey?: string;
  readonly fetchChunk?: ChunkFetcher;
}

type ChunkedAssetLoadArgument = LoadChunkedAssetOptions | string | URL | ChunkFetcher;

function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

function copyBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  const view = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable; asset verification cannot continue");
  }
  const digest = await cryptoApi.subtle.digest("SHA-256", copyToArrayBuffer(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isCachedAssetRecord(value: unknown): value is CachedAssetRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CachedAssetRecord>;
  return (
    typeof record.key === "string" &&
    typeof record.sha256 === "string" &&
    isSha256(record.sha256) &&
    record.bytes instanceof ArrayBuffer
  );
}


function openDatabase(): Promise<IDBDatabase | null> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(CACHE_DATABASE, CACHE_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) {
        database.createObjectStore(CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the asset cache"));
    request.onblocked = () => reject(new Error("Asset cache database opening was blocked"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Asset cache transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Asset cache transaction was aborted"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Asset cache request failed"));
  });
}

function validateKey(key: string): void {
  if (!key) throw new Error("Asset cache keys must not be empty");
}

/**
 * Returns verified bytes from IndexedDB, or null when the browser has no usable
 * IndexedDB cache, the key is absent, or the stored record fails verification.
 */
export async function getCachedAsset(key: string, expectedSha256: string): Promise<ArrayBuffer | null> {
  validateKey(key);
  if (!isSha256(expectedSha256)) throw new Error("Expected asset SHA-256 must be 64 hexadecimal characters");

  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return null;
    const transaction = database.transaction(CACHE_STORE, "readonly");
    const record = await requestResult<unknown>(transaction.objectStore(CACHE_STORE).get(key));
    await transactionComplete(transaction);
    if (!isCachedAssetRecord(record) || record.key !== key || record.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      return null;
    }
    const bytes = new Uint8Array(record.bytes);
    const actualSha256 = await sha256Hex(bytes);
    return actualSha256 === expectedSha256.toLowerCase() ? copyToArrayBuffer(bytes) : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

/**
 * Stores bytes only after computing and matching the supplied SHA-256 hash.
 * False means IndexedDB is unavailable or rejected the cache operation.
 */
export async function putCachedAsset(
  key: string,
  value: ArrayBuffer | Uint8Array,
  expectedSha256: string,
): Promise<boolean> {
  validateKey(key);
  if (!isSha256(expectedSha256)) throw new Error("Expected asset SHA-256 must be 64 hexadecimal characters");
  const bytes = copyBytes(value);
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Asset SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return false;
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).put({
      key,
      sha256: actualSha256,
      bytes: copyToArrayBuffer(bytes),
    } satisfies CachedAssetRecord);
    await transactionComplete(transaction);
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

/** Deletes an asset cache record. False means no usable IndexedDB was available. */
export async function deleteCachedAsset(key: string): Promise<boolean> {
  validateKey(key);
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return false;
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).delete(key);
    await transactionComplete(transaction);
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function normalizeLoadOptions(argument: ChunkedAssetLoadArgument | undefined): LoadChunkedAssetOptions {
  if (typeof argument === "function") return { fetchChunk: argument };
  if (typeof argument === "string" || argument instanceof URL) return { baseUrl: argument };
  return argument ?? {};
}

function validateManifest(manifest: ChunkedAssetManifest): void {
  if (!manifest || typeof manifest !== "object") throw new Error("Invalid chunk manifest");
  if (manifest.version !== undefined && manifest.version !== 1) throw new Error("Unsupported chunk manifest version");
  if (!manifest.originalFilename || !Number.isSafeInteger(manifest.size) || manifest.size < 0) {
    throw new Error("Invalid chunk manifest size or filename");
  }
  if (!isSha256(manifest.sha256)) throw new Error("Invalid chunk manifest SHA-256");
  if (manifest.chunkSizes.length !== manifest.chunks.length) throw new Error("Chunk metadata length mismatch");
  if (manifest.size === 0 && manifest.chunkSizes.length !== 0) throw new Error("Empty assets cannot have chunks");
  if (manifest.size > 0 && manifest.chunkSizes.length === 0) throw new Error("Non-empty assets need chunks");
  const total = manifest.chunkSizes.reduce((sum, size) => {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid chunk size");
    return sum + size;
  }, 0);
  if (total !== manifest.size) throw new Error("Chunk sizes do not match manifest size");
  for (const chunk of manifest.chunks) {
    if (!chunk || typeof chunk !== "string") throw new Error("Invalid chunk filename");
  }
}

function defaultBaseUrl(): string | undefined {
  return typeof globalThis.location === "object" ? globalThis.location.href : undefined;
}

async function fetchChunkFromNetwork(url: string): Promise<ArrayBuffer> {
  if (typeof globalThis.fetch !== "function") throw new Error("Fetch is unavailable; chunk loading cannot continue");
  const response = await globalThis.fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Unable to load asset chunk (${response.status})`);
  return response.arrayBuffer();
}

/** Fetches, reconstructs, verifies, and optionally caches a chunked asset. */
export async function loadChunkedAsset(
  manifest: ChunkedAssetManifest,
  argument?: ChunkedAssetLoadArgument,
): Promise<ArrayBuffer> {
  validateManifest(manifest);
  const options = normalizeLoadOptions(argument);
  const cacheKey = options.cacheKey ?? `${manifest.originalFilename}:${manifest.size}:${manifest.sha256.toLowerCase()}`;
  const cached = await getCachedAsset(cacheKey, manifest.sha256);
  if (cached) return cached;

  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const fetchChunk = options.fetchChunk;
  const chunks = await Promise.all(
    manifest.chunks.map(async (chunk, index) => {
      const url = baseUrl ? new URL(chunk, baseUrl).href : chunk;
      const bytes = await (fetchChunk ? fetchChunk(url, index) : fetchChunkFromNetwork(url));
      if (bytes.byteLength !== manifest.chunkSizes[index]) {
        throw new Error(`Asset chunk ${index} length mismatch`);
      }
      return new Uint8Array(bytes);
    }),
  );

  const reconstructed = new Uint8Array(manifest.size);
  let offset = 0;
  for (const chunk of chunks) {
    reconstructed.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const actualSha256 = await sha256Hex(reconstructed);
  if (actualSha256 !== manifest.sha256.toLowerCase()) {
    throw new Error(`Reconstructed asset SHA-256 mismatch: expected ${manifest.sha256}, got ${actualSha256}`);
  }
  await putCachedAsset(cacheKey, reconstructed, manifest.sha256);
  return copyToArrayBuffer(reconstructed);
}
