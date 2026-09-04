export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}

export interface StorageProvider {
  /** Store bytes under `key`. Returns the stored object's metadata. */
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  /** Read the bytes stored under `key`. Rejects if absent. */
  get(key: string): Promise<Buffer>;
  /** Remove `key`. Succeeds silently if it does not exist. */
  delete(key: string): Promise<void>;
  /** A time-limited URL a client can fetch `key` from directly. */
  signUrl(key: string, expiresInSeconds: number): Promise<string>;
}
