import { Client } from 'minio';
import type { Config } from '../config';
import type { StorageProvider, StoredObject } from './StorageProvider';

export class MinioStorageProvider implements StorageProvider {
  constructor(
    private readonly client: Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.putObject(this.bucket, key, body, body.length, {
      'Content-Type': contentType,
    });
    return { key, size: body.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    // MinIO's removeObject already succeeds for a missing key (S3 semantics),
    // so no special-casing is needed here. A genuine failure (e.g. auth,
    // network) still propagates to the caller rather than being swallowed.
    await this.client.removeObject(this.bucket, key);
  }

  async signUrl(key: string, expiresInSeconds: number): Promise<string> {
    return this.client.presignedGetObject(this.bucket, key, expiresInSeconds);
  }
}

export function createStorageProvider(config: Config): StorageProvider {
  const client = new Client({
    endPoint: config.minioEndpoint,
    port: config.minioPort,
    useSSL: false,
    accessKey: config.minioAccessKey,
    secretKey: config.minioSecretKey,
  });
  return new MinioStorageProvider(client, config.minioBucket);
}
