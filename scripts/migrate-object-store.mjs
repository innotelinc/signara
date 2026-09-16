#!/usr/bin/env node
// Copy every object from one S3-compatible endpoint to another, verifying each
// one byte for byte.
//
// Why this exists: signara/docs/Roadmap.md W3 cuts Signara's document storage
// over from MinIO to the estate's own onyx-objectstore. Getting the store to
// speak SigV4 was the easy half; the cutover is the risky half, and a copy that
// was never read back is a copy you cannot trust. So every object is
// round-tripped — read from the source, written to the target, read *back* from
// the target — and compared on both length and SHA-256 before this will report
// success. The source is never modified or deleted.
//
// Dry-run by default: it prints the plan and writes nothing.
//
//   SOURCE_S3_ENDPOINT=http://127.0.0.1:9002 SOURCE_S3_ACCESS_KEY=… SOURCE_S3_SECRET_KEY=… \
//   TARGET_S3_ENDPOINT=http://127.0.0.1:2090 TARGET_S3_ACCESS_KEY=… TARGET_S3_SECRET_KEY=… \
//     node scripts/migrate-object-store.mjs            # dry run
//     node scripts/migrate-object-store.mjs --apply    # copy for real
//
// Env names follow the SOURCE_S3_* / BACKUP_S3_* convention the `backup`
// service in docker-compose.prod.yml already uses. Exit codes: 0 all good,
// 1 one or more objects failed, 2 misconfiguration.

import * as Minio from 'minio';
import { createHash } from 'node:crypto';

const APPLY = process.argv.includes('--apply');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function endpoint(name) {
  const raw = process.env[name];
  if (!raw) fail(`${name} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} is not a URL: ${JSON.stringify(raw)}`);
  }
  return {
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    useSSL: url.protocol === 'https:',
  };
}

function clientFor(prefix) {
  const accessKey = process.env[`${prefix}_S3_ACCESS_KEY`];
  const secretKey = process.env[`${prefix}_S3_SECRET_KEY`];
  const bucket = process.env[`${prefix}_S3_BUCKET`];
  if (!accessKey || !secretKey) fail(`${prefix}_S3_ACCESS_KEY and ${prefix}_S3_SECRET_KEY are required`);
  if (!bucket) fail(`${prefix}_S3_BUCKET is required`);
  const client = new Minio.Client({
    ...endpoint(`${prefix}_S3_ENDPOINT`),
    accessKey,
    secretKey,
    region: process.env[`${prefix}_S3_REGION`] ?? 'us-east-1',
    pathStyle: true,
  });
  return { client, bucket };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function listAll(client, bucket) {
  const keys = [];
  for await (const obj of client.listObjectsV2(bucket, '', true)) {
    // A bucket listing can surface directory placeholders; they have no bytes.
    if (obj.name && !obj.name.endsWith('/')) keys.push(obj.name);
  }
  return keys.sort();
}

async function ensureBucket({ client, bucket }) {
  if (await client.bucketExists(bucket)) {
    console.log(`target bucket exists: ${bucket}`);
    return;
  }
  if (!APPLY) {
    console.log(`target bucket missing: ${bucket} (dry run — would create it)`);
    return;
  }
  await client.makeBucket(bucket, process.env.TARGET_S3_REGION ?? 'us-east-1');
  console.log(`target bucket created: ${bucket}`);
}

async function main() {
  const source = clientFor('SOURCE');
  const target = clientFor('TARGET');

  console.log(`source: ${process.env.SOURCE_S3_ENDPOINT} / ${source.bucket}`);
  console.log(`target: ${process.env.TARGET_S3_ENDPOINT} / ${target.bucket}`);
  console.log(`mode:   ${APPLY ? 'APPLY — objects will be written to the target' : 'DRY RUN — nothing will be written'}`);

  await ensureBucket(target);

  const keys = await listAll(source.client, source.bucket);
  if (keys.length === 0) {
    console.log('\nno objects in the source bucket — nothing to do');
    return;
  }
  console.log(`\n${keys.length} object(s) to migrate\n`);

  let copied = 0;
  let bytes = 0;
  let failed = 0;

  for (const key of keys) {
    let body;
    try {
      body = await readAll(await source.client.getObject(source.bucket, key));
    } catch (err) {
      console.error(`FAIL  ${key} — could not read from the source: ${err?.message ?? err}`);
      failed++;
      continue;
    }
    const digest = sha256(body);

    if (!APPLY) {
      console.log(`plan  ${key}  ${body.length} bytes  sha256=${digest.slice(0, 12)}`);
      continue;
    }

    try {
      await target.client.putObject(target.bucket, key, body, body.length, {
        // The app records the authoritative content type on the document row
        // (documents.service.ts), so the store-side copy is deliberately
        // generic. Restating it here would invite the two to disagree.
        'content-type': 'application/octet-stream',
      });
      const back = await readAll(await target.client.getObject(target.bucket, key));
      const backDigest = sha256(back);
      if (back.length !== body.length || backDigest !== digest) {
        throw new Error(
          `round-trip mismatch: source ${body.length}B sha256=${digest.slice(0, 12)}, ` +
            `target ${back.length}B sha256=${backDigest.slice(0, 12)}`,
        );
      }
      copied++;
      bytes += body.length;
      console.log(`ok    ${key}  ${body.length} bytes  sha256=${digest.slice(0, 12)}`);
    } catch (err) {
      console.error(`FAIL  ${key} — ${err?.message ?? err}`);
      failed++;
    }
  }

  console.log('');
  if (failed > 0) {
    console.error(`${failed} of ${keys.length} object(s) failed; ${copied} verified`);
    process.exit(1);
  }
  if (!APPLY) {
    console.log(`dry run complete: ${keys.length} object(s) would be copied. Re-run with --apply.`);
    return;
  }
  console.log(`migrated and verified ${copied} object(s), ${bytes} bytes.`);
  console.log('The source still holds its copies — it is the rollback until it is retired deliberately.');
}

await main();
