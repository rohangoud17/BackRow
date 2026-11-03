/**
 * Vector storage behind an interface: S3 Vectors in production, an in-memory
 * fake in tests.
 *
 * S3 Vectors rather than pgvector: an RDS instance has to live in a VPC, and a
 * Lambda reaching it plus Bedrock from inside a VPC needs a NAT Gateway (~$32/mo
 * whether or not anyone uploads anything). S3 Vectors is a pay-per-request API
 * with no idle cost, which is what this project optimizes for. See ADR 0002.
 */
import {
  S3VectorsClient,
  CreateIndexCommand,
  PutVectorsCommand,
  DeleteVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { EMBEDDING_DIMENSIONS } from "./embedder";
import { NON_FILTERABLE_METADATA_KEYS, type ChunkVector } from "./types";

export interface VectorStore {
  /** Idempotent: an index that already exists counts as created. */
  createIndex(indexName: string): Promise<void>;
  putVectors(indexName: string, vectors: ChunkVector[]): Promise<void>;
  /** Deleting keys that don't exist is not an error. */
  deleteVectors(indexName: string, keys: string[]): Promise<void>;
}

/**
 * Vectors per PutVectors call. The API allows up to 500, but each vector here
 * carries ~2 KB of chunk text as metadata, and smaller requests keep a single
 * throttled or retried call cheap.
 */
export const PUT_BATCH = 100;

/** DeleteVectors accepts up to 500 keys per call. */
export const DELETE_BATCH = 500;

export class S3VectorStore implements VectorStore {
  constructor(
    private readonly vectorBucketName: string,
    private readonly client = new S3VectorsClient({ maxAttempts: 6 })
  ) {}

  async createIndex(indexName: string): Promise<void> {
    try {
      await this.client.send(
        new CreateIndexCommand({
          vectorBucketName: this.vectorBucketName,
          indexName,
          dataType: "float32",
          dimension: EMBEDDING_DIMENSIONS,
          distanceMetric: "cosine",
          // Fixed at creation and immutable afterwards. Everything except docId
          // is non-filterable, which is what lets `text` exceed the 2 KB
          // filterable-metadata budget.
          metadataConfiguration: {
            nonFilterableMetadataKeys: [...NON_FILTERABLE_METADATA_KEYS],
          },
        })
      );
    } catch (err) {
      if ((err as { name?: string })?.name === "ConflictException") return;
      throw err;
    }
  }

  async putVectors(indexName: string, vectors: ChunkVector[]): Promise<void> {
    for (let i = 0; i < vectors.length; i += PUT_BATCH) {
      await this.client.send(
        new PutVectorsCommand({
          vectorBucketName: this.vectorBucketName,
          indexName,
          vectors: vectors.slice(i, i + PUT_BATCH).map((v) => ({
            key: v.key,
            data: { float32: v.embedding },
            metadata: { ...v.metadata },
          })),
        })
      );
    }
  }

  async deleteVectors(indexName: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      await this.client.send(
        new DeleteVectorsCommand({
          vectorBucketName: this.vectorBucketName,
          indexName,
          keys: keys.slice(i, i + DELETE_BATCH),
        })
      );
    }
  }
}
