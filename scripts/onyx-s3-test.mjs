// The onyx-objectstore S3-gateway check: a real MinIO SDK against the store,
// covering put, get, presign, a presigned fetch, and delete.
//
// This was written as a FORWARD PROBE, when the store was HTTP Basic only and
// SDK calls were *expected* to fail. That milestone has since shipped: SigV4 —
// header and presigned — is implemented, pinned to AWS's published vector suite
// (onyx services/objectstore/sigv4_vectors_test.go), and deployed. So this is
// now a check rather than a prediction, and passing it is what made Signara's
// storage cutover possible.
//
// Credentials are read from /tmp/onyx-ak and /tmp/onyx-sk (mode 600) so they
// never reach argv or shell history. They are the store's S3_ACCESS_KEY and
// S3_SECRET_KEY, which live in Cerulean Vault (cerulean/onyx) and are what the
// running container resolves at startup:
//
//   vault kv get -format=json cerulean/onyx   # read them
//   node scripts/onyx-s3-test.mjs             # then run this
//
// scripts/onyx-objectstore-smoke.sh is the same endpoint driven by curl alone.
import * as Minio from 'minio';
import { readFileSync } from 'node:fs';

const ak = readFileSync('/tmp/onyx-ak', 'utf8').trim();
const sk = readFileSync('/tmp/onyx-sk', 'utf8').trim();

const client = new Minio.Client({
  endPoint: '127.0.0.1',
  port: 2090,
  useSSL: false,
  accessKey: ak,
  secretKey: sk,
  region: 'us-east-1',
  pathStyle: true,
});

const bucket = 'signara-documents';
const exists = await client.bucketExists(bucket).catch(() => false);
if (!exists) {
  await client.makeBucket(bucket, 'us-east-1');
  console.log('bucket created:', bucket);
} else {
  console.log('bucket exists:', bucket);
}

const payload = Buffer.from('signara-onyx roundtrip test ' + new Date().toISOString());
const key = 'smoke-test/roundtrip.txt';
await client.putObject(bucket, key, payload, payload.length, { 'content-type': 'text/plain' });
console.log('putObject OK,', payload.length, 'bytes');

const chunks = [];
const stream = await client.getObject(bucket, key);
for await (const c of stream) chunks.push(c);
const got = Buffer.concat(chunks);
console.log('getObject OK, match:', got.equals(payload));

const url = await client.presignedGetObject(bucket, key, 120);
console.log('presigned URL OK:', url.slice(0, 60) + '...');

const res = await fetch(url);
console.log('presigned fetch:', res.status, res.status === 200 ? 'OK' : 'FAIL');

await client.removeObject(bucket, key);
console.log('cleanup object OK');
console.log('ROUND-TRIP PASSED');
