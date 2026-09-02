import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeiliSearch } from 'meilisearch';

export interface SearchableDocument {
  id: string;
  organizationId: string;
  title: string;
  fileName: string;
  tags: string[];
  status: string;
  updatedAt: string;
}

/**
 * Full-text search backed by Meilisearch. Documents are indexed per tenant;
 * every query is filtered by `organizationId` to preserve tenant isolation.
 */
@Injectable()
export class MeilisearchService implements OnModuleInit {
  private readonly logger = new Logger('Meilisearch');
  private client!: MeiliSearch;
  private readonly indexName = 'documents';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new MeiliSearch({
      host: this.config.get<string>('meilisearch.host') ?? 'http://localhost:7700',
      apiKey: this.config.get<string>('meilisearch.apiKey') ?? '',
    });
  }

  async indexDoc(doc: SearchableDocument): Promise<void> {
    try {
      await this.client.index(this.indexName).addDocuments([doc]);
    } catch (err) {
      this.logger.warn(`Meilisearch indexing failed: ${(err as Error).message}`);
    }
  }

  async search(organizationId: string, query: string, limit = 20): Promise<SearchableDocument[]> {
    const result = await this.client.index(this.indexName).search(query, {
      limit,
      filter: `organizationId = ${JSON.stringify(organizationId)}`,
      attributesToHighlight: ['title'],
    });
    return result.hits as unknown as SearchableDocument[];
  }

  async deleteDoc(id: string): Promise<void> {
    try {
      await this.client.index(this.indexName).deleteDocument(id);
    } catch (err) {
      this.logger.warn(`Meilisearch delete failed: ${(err as Error).message}`);
    }
  }
}