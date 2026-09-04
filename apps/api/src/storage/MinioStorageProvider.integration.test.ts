import { loadConfig } from '../config';
import { createStorageProvider } from './MinioStorageProvider';

const config = loadConfig({ JWT_SECRET: 'storage-test-secret' });
const provider = createStorageProvider(config);
const keys: string[] = [];

function testKey(name: string): string {
  const key = `test/${Date.now()}-${name}`;
  keys.push(key);
  return key;
}

afterAll(async () => {
  await Promise.all(keys.map((k) => provider.delete(k)));
});

describe('MinioStorageProvider against live MinIO', () => {
  it('stores and reads back the exact bytes', async () => {
    const key = testKey('roundtrip.bin');
    const body = Buffer.from('wardrobe test payload');
    const stored = await provider.put(key, body, 'application/octet-stream');

    expect(stored.key).toBe(key);
    expect(stored.size).toBe(body.length);

    const read = await provider.get(key);
    expect(read.equals(body)).toBe(true);
  });

  it('preserves the content type', async () => {
    const key = testKey('typed.jpg');
    await provider.put(key, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    const stored = await provider.put(key, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    expect(stored.contentType).toBe('image/jpeg');
  });

  // `stored.contentType` above is just `put`'s own input echoed back, not proof
  // MinIO actually stored it. A `put` that silently drops the Content-Type
  // metadata still returns the right value there while every object ends up
  // as MinIO's default `binary/octet-stream`. Only a real fetch of the object
  // exposes that, via the response's actual Content-Type header.
  it('actually persists the content type to MinIO, not just to the returned metadata', async () => {
    const key = testKey('contenttype-check.jpg');
    await provider.put(key, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');

    const url = await provider.signUrl(key, 60);
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('handles a payload larger than 5MB', async () => {
    const key = testKey('large.bin');
    const body = Buffer.alloc(6 * 1024 * 1024, 0xab);
    const stored = await provider.put(key, body, 'image/jpeg');
    expect(stored.size).toBe(6 * 1024 * 1024);
    const read = await provider.get(key);
    expect(read.length).toBe(body.length);
  }, 30000);

  it('rejects reading a key that does not exist', async () => {
    await expect(provider.get('test/definitely-not-here')).rejects.toThrow();
  });

  it('deletes a key, after which reading it fails', async () => {
    const key = testKey('deleteme.bin');
    await provider.put(key, Buffer.from('x'), 'text/plain');
    await provider.delete(key);
    await expect(provider.get(key)).rejects.toThrow();
  });

  it('treats deleting a missing key as success', async () => {
    await expect(provider.delete('test/never-existed')).resolves.toBeUndefined();
  });

  it('signs a URL that actually fetches the object', async () => {
    const key = testKey('signed.txt');
    const body = Buffer.from('signed content');
    await provider.put(key, body, 'text/plain');

    const url = await provider.signUrl(key, 60);
    expect(url).toContain(key);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
  }, 20000);
});
