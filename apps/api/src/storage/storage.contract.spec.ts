import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import configuration from '../config/configuration';
import { MinioService } from './minio.service';

/**
 * The storage contract: whatever endpoint `S3_*` names must support the whole
 * round trip Signara depends on — put, stat, presign, fetch by presigned URL,
 * delete — or the cutover to it is not a config change.
 *
 * This is the test that gates W3 of docs/Roadmap.md. Signara stores documents in
 * an S3-shaped endpoint, and the estate's destination is Onyx's object store,
 * which today authenticates with HTTP Basic only: no SigV4, so no presigned URL.
 * A presigned URL is not decoration here — it is how a browser downloads a
 * document without the API proxying every byte — so "Onyx is not ready" shows up
 * as an assertion in this file rather than as a surprise at cutover.
 *
 * It is **opt-in**, because it talks to a real endpoint and writes real objects:
 *
 *     S3_CONTRACT=1 \
 *     S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=… S3_SECRET_KEY=… \
 *       npm test -w @signara/api -- storage.contract
 *
 * With `S3_CONTRACT` unset it is skipped, so `npm test` stays hermetic. The
 * objects it writes live under `_contract/` and are deleted on the way out; a
 * run that fails mid-way can leave one behind, which is stated rather than
 * hidden.
 */
const RUN = process.env.S3_CONTRACT === '1';

const describeContract = RUN ? describe : describe.skip;

describeContract('object storage contract', () => {
  let storage: MinioService;
  let config: ConfigService;
  const key = `_contract/${Date.now()}-${Math.random().toString(16).slice(2)}/probe.bin`;
  const body = Buffer.from('signara storage contract probe\n', 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');

  beforeAll(async () => {
    // The real service and the real configuration, so this exercises the code
    // path a document upload takes rather than a re-implementation of it.
    config = new ConfigService(configuration() as unknown as Record<string, unknown>);
    storage = new MinioService(config);
    await storage.onModuleInit();
  });

  afterAll(async () => {
    // Best effort: a failed assertion above should not also fail the cleanup.
    await storage.delete(key).catch(() => undefined);
  });

  it('reports the endpoint it is configured against', () => {
    // Printed so a failing run says WHICH endpoint was tested — the one thing a
    // bare assertion error would not tell you when the profile is wrong.
    // eslint-disable-next-line no-console
    console.log(
      `[contract] endpoint=${config.get('s3.endpoint')} ` +
        `public=${config.get('s3.publicEndpoint') || '(same as endpoint)'} ` +
        `bucket=${config.get('s3.bucket')} pathStyle=${config.get('s3.forcePathStyle')}`,
    );
    expect(config.get('s3.endpoint')).toBeTruthy();
  });

  it('writes an object and records its checksum', async () => {
    const stored = await storage.put(key, body, 'application/octet-stream', sha256);
    expect(stored.key).toBe(key);
    expect(stored.etag).toBeTruthy();
  });

  it('reports the object it stored', async () => {
    const stat = await storage.stat(key);
    expect(Number(stat.size)).toBe(body.length);

    // User metadata is written with the `x-amz-meta-` prefix and read back
    // **without** it — that is the S3 convention, so the key here is `sha256`.
    // It is asserted rather than ignored because the store is the last copy of
    // the document: if an endpoint drops this, the checksum recorded at upload
    // time has no independent counterpart. Note the database's
    // `DocumentVersion.checksumSha256` is the authoritative one
    // (documents.service.ts); this is the store-side copy.
    expect(stat.metaData?.['sha256']).toBe(sha256);
  });

  it('presigns a URL a browser could use', async () => {
    const url = await storage.getPresignedUrl(key, 300);
    const parsed = new URL(url);

    expect(url).toMatch(/X-Amz-Signature=/);

    // When a public origin is configured the signature must be made against it,
    // not against the internal one a browser cannot resolve.
    const publicEndpoint = config.get<string>('s3.publicEndpoint');
    if (publicEndpoint) {
      expect(parsed.origin).toBe(new URL(publicEndpoint).origin);
    }

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(body)).toBe(true);
  });

  it('reads the object back through the API client', async () => {
    const fetched = await storage.getBuffer(key);
    expect(fetched.equals(body)).toBe(true);
  });

  it('deletes the object, and it is really gone', async () => {
    await storage.delete(key);
    await expect(storage.stat(key)).rejects.toBeDefined();
  });
});
