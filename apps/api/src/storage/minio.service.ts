import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

export interface StoredObject {
  key: string;
  etag?: string;
  versionId?: string;
}

/**
 * Object storage backed by MinIO (any S3-compatible endpoint works).
 * Keys are tenant-scoped: `{orgId}/{resource}/{uuid}.{ext}` — see Security.md.
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger('Minio');
  private client!: Minio.Client;
  /** Client against the public-facing endpoint, used for browser links. */
  private publicClient?: Minio.Client;

  constructor(private readonly config: ConfigService) {
    this.client = this.buildClient(
      this.config.get<string>('s3.endpoint') ?? 'http://localhost:9000',
    );
    // Presigned URLs signed against the internal endpoint (e.g. minio:9000)
    // are unreachable from browsers, so when a public origin is configured the
    // signing client is pointed at it instead. Bucket, credentials and region
    // are identical — only the host differs (usually via the reverse proxy).
    const publicEndpoint = this.config.get<string>('s3.publicEndpoint');
    if (publicEndpoint && publicEndpoint !== (this.config.get<string>('s3.endpoint') ?? '')) {
      this.publicClient = this.buildClient(publicEndpoint);
    }
  }

  private buildClient(endpoint: string): Minio.Client {
    const endpointUrl = new URL(endpoint);
    return new Minio.Client({
      endPoint: endpointUrl.hostname,
      port: endpointUrl.port ? Number(endpointUrl.port) : endpointUrl.protocol === 'https:' ? 443 : 80,
      useSSL: endpointUrl.protocol === 'https:',
      accessKey: this.config.get<string>('s3.accessKey') ?? '',
      secretKey: this.config.get<string>('s3.secretKey') ?? '',
      region: this.config.get<string>('s3.region') ?? 'us-east-1',
      pathStyle: this.config.get<boolean>('s3.forcePathStyle') ?? true,
    });
  }

  /**
   * What to say about a storage failure.
   *
   * The S3 SDKs reject with plain objects, not `Error`s, so `error.message` is
   * often empty — which produced a startup error reading "Could not reach the
   * object store: ." and named nothing. `code` is where the status lands.
   */
  private static describe(error: unknown): string {
    const any = error as { message?: string; code?: string; name?: string } | undefined;
    return any?.message || any?.code || any?.name || String(error);
  }

  async onModuleInit(): Promise<void> {
    const bucket = this.config.get<string>('s3.bucket') ?? 'signara-documents';
    const endpoint = this.config.get<string>('s3.endpoint') ?? '';

    let exists = false;
    try {
      exists = await this.client.bucketExists(bucket);
    } catch (error) {
      // `bucketExists` answering "no" and failing outright are different faults,
      // and the second one used to be swallowed into the first: the catch made a
      // connection or credential problem look like a missing bucket, so the next
      // call was a `makeBucket` that could only fail too — and the operator saw
      // that second error, which named the wrong cause.
      throw new Error(
        `Cannot reach the object store at ${endpoint} for bucket '${bucket}': ` +
          `${MinioService.describe(error)}. ` +
          'Check S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY — an endpoint that only ' +
          'accepts a different signing scheme (or HTTP Basic) rejects SigV4 requests here.',
      );
    }

    if (exists) return;

    // Creating the bucket is a convenience for a fresh local MinIO, not a
    // requirement of the protocol: an endpoint may refuse it (a gateway that
    // only serves pre-provisioned buckets, or a store that implements the S3
    // data plane but not the bucket API). Say which bucket is missing and how
    // to create it rather than crashing on an opaque `AccessDenied`.
    try {
      await this.client.makeBucket(bucket, this.config.get<string>('s3.region') ?? '');
      this.logger.log(`Created bucket ${bucket}`);
    } catch (error) {
      throw new Error(
        `Bucket '${bucket}' does not exist at ${endpoint} and creating it failed: ` +
          `${MinioService.describe(error)}. Create it with your storage's own tooling ` +
          '(e.g. `mc mb`), or point S3_BUCKET at an existing bucket.',
      );
    }
  }

  private get bucket(): string {
    return this.config.get<string>('s3.bucket') ?? 'signara-documents';
  }

  async put(key: string, buffer: Buffer, contentType: string, checksumSha256?: string): Promise<StoredObject> {
    const meta: Record<string, string> = {};
    if (checksumSha256) meta['x-amz-meta-sha256'] = checksumSha256;
    const etag = await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
      ...meta,
    });
    return { key, etag: etag.etag };
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async getPresignedUrl(key: string, expiresSeconds = 900): Promise<string> {
    return (this.publicClient ?? this.client).presignedGetObject(
      this.bucket,
      key,
      expiresSeconds,
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async stat(key: string): Promise<Minio.BucketItemStat> {
    return this.client.statObject(this.bucket, key);
  }
}