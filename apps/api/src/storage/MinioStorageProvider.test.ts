import { Readable } from 'node:stream';
import type { Client } from 'minio';
import { MinioStorageProvider } from './MinioStorageProvider';

const BUCKET = 'test-bucket';

// A stream that yields some data, then fails instead of ending cleanly —
// simulates a connection drop or a truncated read partway through the body.
function erroringStream(): Readable {
  const stream = new Readable({ read() {} });
  process.nextTick(() => {
    stream.push(Buffer.from('partial data'));
    process.nextTick(() => stream.destroy(new Error('stream boom')));
  });
  return stream;
}

describe('MinioStorageProvider against a fake client (hermetic)', () => {
  it('rejects when the underlying stream errors mid-read, rather than hanging', async () => {
    const client = {
      getObject: jest.fn().mockResolvedValue(erroringStream()),
    } as unknown as Client;
    const provider = new MinioStorageProvider(client, BUCKET);

    await expect(provider.get('some/key')).rejects.toThrow('stream boom');
  }, 2000);

  it('passes the exact bucket, key, and TTL through to presignedGetObject', async () => {
    const presignedGetObject = jest.fn().mockResolvedValue('https://example.com/signed');
    const client = { presignedGetObject } as unknown as Client;
    const provider = new MinioStorageProvider(client, BUCKET);

    await provider.signUrl('some/key', 1234);

    expect(presignedGetObject).toHaveBeenCalledWith(BUCKET, 'some/key', 1234);
  });

  it('propagates a real removeObject failure rather than swallowing it', async () => {
    const removeObject = jest.fn().mockRejectedValue(new Error('access denied'));
    const client = { removeObject } as unknown as Client;
    const provider = new MinioStorageProvider(client, BUCKET);

    await expect(provider.delete('some/key')).rejects.toThrow('access denied');
  });
});
