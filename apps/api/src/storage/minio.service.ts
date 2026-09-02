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

  constructor(private readonly config: ConfigService) {
    const endpointUrl = new URL(this.config.get<string>('s3.endpoint') ?? 'http://localhost:9000');
    this.client = new Minio.Client({
      endPoint: endpointUrl.hostname,
      port: endpointUrl.port ? Number(endpointUrl.port) : endpointUrl.protocol === 'https:' ? 443 : 80,
      useSSL: endpointUrl.protocol === 'https:',
      accessKey: this.config.get<string>('s3.accessKey') ?? '',
      secretKey: this.config.get<string>('s3.secretKey') ?? '',
      region: this.config.get<string>('s3.region') ?? 'us-east-1',
      pathStyle: this.config.get<boolean>('s3.forcePathStyle') ?? true,
    });
  }

  async onModuleInit(): Promise<void> {
    const bucket = this.config.get<string>('s3.bucket') ?? 'signara-documents';
    const exists = await this.client.bucketExists(bucket).catch(() => false);
    if (!exists) {
      await this.client.makeBucket(bucket);
      this.logger.log(`Created bucket ${bucket}`);
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
    return this.client.presignedGetObject(this.bucket, key, expiresSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async stat(key: string): Promise<Minio.BucketItemStat> {
    return this.client.statObject(this.bucket, key);
  }
}