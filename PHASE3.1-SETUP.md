# Phase 3.1 — RAG ingestion: setup and verification

This gets course-document ingestion running in your own AWS account and proves
it works end to end. It assumes the stack from the main README already deploys.
Allow about 15 minutes.

## What this phase adds

```
presenter ── POST /courses ─────────────▶ courses Lambda ── creates the course's vector index
          ◀─ {courseId, courseToken}
          ── POST /courses/{id}/documents ─▶ courses Lambda ── records the document (uploading)
          ◀─ presigned S3 POST
          ── browser POSTs the file straight to S3 (raw/<org>/<course>/<doc>.pdf)
                        │ S3 ObjectCreated
                        ▼
                     ingest Lambda: extract (unpdf) → scanned check → chunk
                                    → embed (Titan v2, 512) → S3 Vectors → ready
```

Accepted uploads: PDF up to 25 MB and 300 pages, `.txt`/`.md` up to 2 MB.
PowerPoint and Word files are refused with "export to PDF and re-upload".

## 1. Enable Bedrock model access

Titan Text Embeddings v2 must be enabled in us-east-1. In the
[Bedrock console](https://console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess)
→ Model access, enable **Titan Text Embeddings V2**. Check it from the CLI:

```bash
aws bedrock list-foundation-models --by-provider amazon \
  --query "modelSummaries[?modelId=='amazon.titan-embed-text-v2:0'].modelLifecycle.status"
# -> ["ACTIVE"]
```

## 2. Create the course creator key

CloudFormation can't create SecureStrings, so this one is by hand, once per
environment:

```bash
aws ssm put-parameter --name /backrow/dev/course-creator-key --type SecureString \
  --value "$(openssl rand -hex 48)"
```

Rotation and the per-key course cap are in the README under "The course
creator key".

## 3. Deploy

```bash
npm install
npm run deploy:dev
```

New outputs: `DocsBucketName`, `VectorBucketName`, `CreatorKeyParamName`.

**Reserved concurrency for ingest is off by default.** It keeps a bulk upload
from starving the realtime handlers, but Lambda refuses any reservation that
leaves fewer than 100 unreserved executions, so on a new account still at the
default limit of 10 the deploy would fail. Check yours, and opt in once it's
raised:

```bash
aws lambda get-account-settings --query "AccountLimit.ConcurrentExecutions"
cd infra && npx cdk deploy Backrow-dev --context env=dev --context ingestConcurrency=5
```

## 4. Run the end-to-end check

Any text-based PDF works; a lecture deck exported to PDF is the realistic case.

```bash
export BACKROW_CREATOR_KEY="$(aws ssm get-parameter --name /backrow/dev/course-creator-key \
  --with-decryption --query Parameter.Value --output text)"

node scripts/ingest-smoke.mjs --http "<HttpUrl>" --file path/to/lecture.pdf
```

It creates a course, checks the upload rules (slides told to export, oversize
refused, wrong token refused), uploads through the presigned POST exactly as a
browser would, waits for ingest, then checks that a session attaches to the
course only with the right token. Every line should read `ok`.

The course token is printed **once**. Keep it if you want to upload more to the
same course: rerun with `--course <id> --token <token>`.

## 5. Look at what was stored

```bash
# The document record: status, page count, chunk count.
aws dynamodb query --table-name backrow-dev \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"ORG#default#COURSE#<courseId>"}}'

# A couple of the stored vectors, with their metadata (chunk text and pages).
aws s3vectors list-vectors --vector-bucket-name backrow-dev-vectors \
  --index-name chunks-default-<courseId> --return-metadata --max-results 2

# The ingest log: ids, counts and timings only — never document text.
aws logs tail /aws/lambda/backrow-dev-ingest --since 15m
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `POST /courses` → `503 NOT_CONFIGURED` | Step 2 not done, or the key is shorter than 32 characters. |
| Document `failed` with `SCANNED_PDF` | More than half the pages have no text layer. Export the source as a text PDF, or OCR it first. |
| Document `failed` with `INTERNAL` | Usually Bedrock access (step 1). The ingest log shows the error class. |
| Document stuck in `uploading` | The browser never completed the S3 POST. The row expires on its own after a day. |
| Document stuck in `processing` | The ingest Lambda timed out; its one automatic retry takes over after 5 minutes. Check the `backrow-dev-ingest-dlq` queue if it never settles. |
| S3 POST returns 403 `Policy Condition failed` | The file is larger than the limit for its type, or the Content-Type field was changed. |
| Deploy fails on `ReservedConcurrentExecutions` | `ingestConcurrency` set on an account at the default limit of 10. Leave it unset. |

## Tearing down

`cdk destroy` leaves the DynamoDB table, the documents bucket and the vector
bucket behind on purpose: they hold course material. Delete them by hand if
that's what you want.
