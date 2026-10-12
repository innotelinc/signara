import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeiliSearch } from 'meilisearch';
import { searchIndexFailuresTotal } from '../common/metrics';

export interface SearchableDocument {
  id: string;
  organizationId: string;
  title: string;
  fileName: string;
  tags: string[];
  status: string;
  updatedAt: string;
}

/** What a batch of index work actually achieved — `failed` is reported, never swallowed silently. */
export interface IndexReport {
  indexed: number;
  failed: number;
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

  /**
   * The index's primary key, stated explicitly.
   *
   * Meilisearch infers one when it is not given, and it **refuses** a document
   * with more than one field whose name ends in `id`. Every document here has
   * both `id` and `organizationId`, so inference failed on every single write —
   * `The primary key inference failed as the engine found 2 fields ending with
   * 'id'` — and the index held **0 documents** while every search returned no
   * results. The error was caught and logged as a warning, so the deployment
   * looked healthy throughout (issue: search silently empty).
   */
  private readonly primaryKey = 'id';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new MeiliSearch({
      host: this.config.get<string>('meilisearch.host') ?? 'http://localhost:7700',
      apiKey: this.config.get<string>('meilisearch.apiKey') ?? '',
    });
  }

  /** Indexes one document. Never throws: a document write must not fail on search. */
  async indexDoc(doc: SearchableDocument): Promise<IndexReport> {
    return this.indexDocs([doc]);
  }

  /**
   * Indexes a batch. A Meilisearch outage or rejection is reported as `failed`
   * and counted, rather than only logged — a permanent indexing failure used to
   * be indistinguishable from a healthy one in a log tail.
   */
  async indexDocs(docs: SearchableDocument[]): Promise<IndexReport> {
    if (docs.length === 0) return { indexed: 0, failed: 0 };

    try {
      await this.client.index(this.indexName).addDocuments(docs, { primaryKey: this.primaryKey });
      return { indexed: docs.length, failed: 0 };
    } catch (err) {
      searchIndexFailuresTotal.inc({ operation: 'index' }, docs.length);
      this.logger.warn(
        `Meilisearch indexing failed for ${docs.length} document(s): ${(err as Error).message}`,
      );
      return { indexed: 0, failed: docs.length };
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
      searchIndexFailuresTotal.inc({ operation: 'delete' });
      this.logger.warn(`Meilisearch delete failed: ${(err as Error).message}`);
    }
  }

  /** How many documents the index actually holds — the check `indexDoc` cannot make. */
  async documentCount(): Promise<number> {
    const stats = await this.client.index(this.indexName).getStats();
    return stats.numberOfDocuments;
  }
}
