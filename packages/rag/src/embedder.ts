/**
 * Text -> vector, behind an interface so the provider can be swapped (and so
 * tests never call Bedrock).
 *
 * Titan Text Embeddings v2 at 512 dimensions: half the 1024 default, which
 * halves storage and query scan cost in S3 Vectors for a retrieval-quality loss
 * that is small at course-corpus scale. `normalize: true` returns unit vectors,
 * so cosine distance in the index is well-defined and comparable across chunks.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const EMBEDDING_DIMENSIONS = 512;
export const TITAN_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0";

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export class TitanEmbedder implements Embedder {
  constructor(
    // Generous retries with the SDK's adaptive backoff: a large upload sends a
    // few hundred requests in a burst, and a throttle should slow ingest down,
    // not fail the document.
    private readonly client = new BedrockRuntimeClient({
      maxAttempts: 8,
      retryMode: "adaptive",
    }),
    private readonly modelId = TITAN_EMBED_MODEL_ID,
    private readonly dimensions = EMBEDDING_DIMENSIONS
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: text,
          dimensions: this.dimensions,
          normalize: true,
        }),
      })
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
      embedding?: number[];
    };
    if (parsed.embedding?.length !== this.dimensions) {
      // Would otherwise surface later as an opaque PutVectors validation error.
      throw new Error(
        `embedding has ${parsed.embedding?.length} dims, expected ${this.dimensions}`
      );
    }
    return parsed.embedding;
  }
}

/**
 * Map with bounded concurrency, preserving order.
 *
 * Titan has no batch request, so a document is one call per chunk. Unbounded
 * Promise.all over a 300-page deck would fire hundreds of calls at once and
 * trip the account's per-model throughput quota; strictly serial would take
 * minutes. A small fixed pool sits between the two.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
