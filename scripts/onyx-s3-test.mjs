// FORWARD PROBE — for the onyx-objectstore S3-gateway milestone (SigV4 +
// presigned URLs). onyx-objectstore v0.1 is Basic-auth only, so MinIO SDK
// calls FAIL against it today (see scripts/onyx-objectstore-smoke.sh for the
// working v0.1 verification). Run this once the milestone ships:
//   node --experimental-vm-modules scripts/onyx-s3-test.mjs
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
