/**
 * Nearest-chunk search, behind an interface: S3 Vectors in production, a fake
 * in tests.
 *
 * The chunk text, title and pages come back as metadata on the match itself
 * (see ChunkMetadata), so retrieval is one call with no follow-up reads.
 */
import { S3VectorsClient, QueryVectorsCommand } from "@aws-sdk/client-s3vectors";

export interface RetrievedChunk {
  key: string;
  /** Cosine similarity, 1 - distance. Higher is closer; ~0.3 is weakly related. */
  score: number;
  docId: string;
  title: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
}

export interface Retriever {
  search(indexName: string, embedding: number[], topK: number): Promise<RetrievedChunk[]>;
}

export class S3VectorsRetriever implements Retriever {
  constructor(
    private readonly vectorBucketName: string,
    private readonly client = new S3VectorsClient({ maxAttempts: 4 })
  ) {}

  async search(indexName: string, embedding: number[], topK: number): Promise<RetrievedChunk[]> {
    const res = await this.client.send(
      new QueryVectorsCommand({
        vectorBucketName: this.vectorBucketName,
        indexName,
        queryVector: { float32: embedding },
        topK,
        returnMetadata: true,
        returnDistance: true,
      })
    );
    return (res.vectors ?? []).flatMap((v): RetrievedChunk[] => {
      const m = (v.metadata ?? {}) as Record<string, unknown>;
      // A vector without text can't ground anything; skip rather than prompt with it.
      if (typeof m.text !== "string" || typeof m.docId !== "string") return [];
      return [
        {
          key: v.key ?? "",
          score: 1 - (v.distance ?? 1),
          docId: m.docId,
          title: typeof m.title === "string" ? m.title : "",
          text: m.text,
          pageStart: typeof m.pageStart === "number" ? m.pageStart : undefined,
          pageEnd: typeof m.pageEnd === "number" ? m.pageEnd : undefined,
        },
      ];
    });
  }
}
