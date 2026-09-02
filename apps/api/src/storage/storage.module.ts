import { Global, Module } from '@nestjs/common';
import { MinioService } from './minio.service';
import { MeilisearchService } from './meilisearch.service';

@Global()
@Module({
  providers: [MinioService, MeilisearchService],
  exports: [MinioService, MeilisearchService],
})
export class StorageModule {}