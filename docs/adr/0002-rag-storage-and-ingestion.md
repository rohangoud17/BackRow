# ADR 0002 — RAG storage and ingestion

Status: Accepted
Date: 2026-11-03
Deciders: Rohan + teammate
Supersedes: the "Vector store" row of ADR 0001

## Context

ADR 0001 deferred the vector store to Phase 3 and named pgvector on a small RDS
instance as the cheap option. By the time Phase 3 started, two facts had changed
the arithmetic.

First, RDS is not the whole cost. A database lives in a VPC, and a Lambda inside
a VPC that also needs Bedrock, S3 and DynamoDB reaches them through a NAT
Gateway (~$32/month plus data processing, whether or not anyone uses the
product) or through a set of interface endpoints (~$7/month each, per AZ). On a
project with a $1/month budget tripwire, the always-on networking costs more
than the database.

Second, S3 Vectors exists: a pay-per-request vector store with no instance, no
VPC, and no idle cost, reachable over its public endpoint with IAM auth like
every other service this project uses.

## Decisions

| Decision | Chosen | Why |
|---|---|---|
| Vector store | **S3 Vectors** | Scale-to-zero. No VPC, so no NAT Gateway. |
| Index layout | **One index per course** | Deleting or isolating a course is one index. Tenancy can't leak through a missing filter. 10,000 indexes per bucket is far beyond need. |
| Embeddings | **Titan Text Embeddings v2, 512 dims, normalized** | Pay-per-token, ~$0.02 per million tokens. 512 halves storage and query scan versus 1024 for a small quality cost at course-corpus scale. |
| Chunk text location | **In the vector's non-filterable metadata** | Retrieval returns everything the prompt and citation need in one call, with no second read from DynamoDB. |
| PDF extraction | **unpdf** (serverless PDF.js), in-Lambda | No external service; bundles to ~1.6 MB. |
| Scanned PDFs | **Detected and rejected, not OCR'd** | More than half the pages textless → `SCANNED_PDF`. Textract is per-page cost; add it only if a pilot shows demand. |
| Upload path | **Presigned S3 POST, ingest on `ObjectCreated`** | Bytes never touch Lambda or API Gateway (10 MB / 6 MB caps). POST, not PUT, because only a POST policy can enforce a size limit. |
| Course management auth | **Creator key in SSM + per-course token, hashed** | A stopgap until Cognito (Phase 4). See below. |
| Generation (3.2) | **Claude Haiku 4.5 via a US cross-region inference profile** | See "Region" below. |

## Consequences

**Retention changed.** The table, the documents bucket and the vector bucket are
now `RETAIN`. Course material outlives deployments, and a vector bucket with
runtime-created indexes can't be deleted by CloudFormation anyway. Tearing down a
dev stack now leaves those three behind.

**Indexes are runtime resources.** CloudFormation creates the vector bucket; the
courses handler creates each course's index. That keeps course creation an API
call rather than a deploy, at the cost of indexes not appearing in any template.

**Ingest is at-least-once.** S3 events can be delivered twice and Lambda retries
async invocations. Correctness rests on conditional status transitions in
DynamoDB and deterministic vector keys (`<docId>#<ordinal>`), so a repeat
overwrites rather than duplicates.

**Auth is bearer secrets until Phase 4.** The creator key is compared in
constant time against a hash, cached for five minutes so rotation needs no
redeploy, and capped at 20 courses per key so a leak is bounded. Course tokens
are 256-bit random values stored only as SHA-256 — no salt or slow KDF, which
protect low-entropy passwords and add nothing for a token nobody can guess.

**Region.** Haiku 4.5 is invocable only through an inference profile. The `us.`
profile can serve a request from us-east-1, us-east-2 or us-west-2. Data stays
in the US, but not pinned to us-east-1. That is the posture to state to an
institution, and the reason not to use the `global.` profile. Ingestion itself
(Titan v2) is in-region.

## Revisit when

- A pilot uploads scanned material regularly → add Textract behind `extract.ts`.
- Retrieval quality disappoints on the eval set → try 1024 dims or a reranker
  before changing stores.
- Query latency from S3 Vectors misses the 3.2 budget at classroom concurrency →
  measure before assuming; the answer cache is the first lever.
