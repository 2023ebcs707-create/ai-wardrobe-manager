import { Client } from 'minio';
import type { ServiceStatus } from '@wardrobe/shared';

export function createStorageClient(): Client {
  return new Client({
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'wardrobe',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'wardrobe123',
  });
}

export async function storageStatus(client: Client, bucket: string): Promise<ServiceStatus> {
  try {
    return (await client.bucketExists(bucket)) ? 'ok' : 'degraded';
  } catch {
    return 'down';
  }
}
