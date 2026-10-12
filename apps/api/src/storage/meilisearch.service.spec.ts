import { ConfigService } from '@nestjs/config';
import { MeilisearchService, SearchableDocument } from './meilisearch.service';

/**
 * Regression coverage for the document search index (apps/api/src/storage).
 *
 * The index held **0 documents** in the live deployment while every search
 * returned no results: Meilisearch infers a primary key when it is not given and
 * refuses a document with two fields ending in `id`, and every document carries
 * `id` *and* `organizationId`. The failure was caught and logged, so the API
 * stayed healthy and nothing surfaced. These tests pin the two halves of the fix
 * — the key is stated explicitly, and a failure is reported rather than only
 * logged.
 */

const DOC: SearchableDocument = {
  id: 'doc-1',
  organizationId: 'org-1',
  title: 'Master services agreement',
  fileName: 'msa.pdf',
  tags: ['legal'],
  status: 'DRAFT',
  updatedAt: '2026-10-12T00:00:00.000Z',
};

interface Stub {
  addDocuments: jest.Mock;
  deleteDocument: jest.Mock;
  search: jest.Mock;
  getStats: jest.Mock;
}

function build(): { service: MeilisearchService; stub: Stub } {
  const stub: Stub = {
    addDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
    deleteDocument: jest.fn().mockResolvedValue({ taskUid: 2 }),
    search: jest.fn().mockResolvedValue({ hits: [] }),
    getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 0 }),
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new MeilisearchService(config);
  service.onModuleInit();
  (service as unknown as { client: unknown }).client = { index: () => stub };
  return { service, stub };
}

describe('MeilisearchService', () => {
  it('states the primary key, so a document with `id` and `organizationId` is accepted', async () => {
    const { service, stub } = build();

    await service.indexDoc(DOC);

    expect(stub.addDocuments).toHaveBeenCalledWith([DOC], { primaryKey: 'id' });
  });

  it('reports a rejected write instead of swallowing it', async () => {
    const { service, stub } = build();
    stub.addDocuments.mockRejectedValue(
      new Error("The primary key inference failed as the engine found 2 fields ending with `id`"),
    );

    await expect(service.indexDoc(DOC)).resolves.toEqual({ indexed: 0, failed: 1 });
  });

  it('reports a whole batch as failed when the store rejects it, and writes nothing', async () => {
    const { service, stub } = build();
    stub.addDocuments.mockRejectedValue(new Error('Meilisearch is unreachable'));

    await expect(service.indexDocs([DOC, { ...DOC, id: 'doc-2' }])).resolves.toEqual({
      indexed: 0,
      failed: 2,
    });
    expect(stub.addDocuments).toHaveBeenCalledTimes(1);
  });

  it('does not call the store for an empty batch', async () => {
    const { service, stub } = build();

    await expect(service.indexDocs([])).resolves.toEqual({ indexed: 0, failed: 0 });
    expect(stub.addDocuments).not.toHaveBeenCalled();
  });

  it('never throws out of a delete', async () => {
    const { service, stub } = build();
    stub.deleteDocument.mockRejectedValue(new Error('Meilisearch is unreachable'));

    await expect(service.deleteDoc(DOC.id)).resolves.toBeUndefined();
  });

  it('reports how many documents the index actually holds', async () => {
    const { service, stub } = build();
    stub.getStats.mockResolvedValue({ numberOfDocuments: 13 });

    await expect(service.documentCount()).resolves.toBe(13);
  });
});
