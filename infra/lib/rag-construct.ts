import * as path from "node:path";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { backrowFunction } from "./lambda";

export interface RagIngestionProps {
  environment: string;
  table: dynamodb.ITable;
  httpApi: HttpApi;
  /**
   * Reserved concurrency for the ingest function, or undefined for none.
   * Reserving keeps a bulk upload from starving the realtime handlers, but
   * Lambda refuses any reservation that would leave the account with fewer than
   * 100 unreserved executions — so on a new account still at the default limit
   * of 10, this must be left unset.
   */
  ingestReservedConcurrency?: number;
}

/** Matches the SDK constant; the Titan model the ingest function may invoke. */
const TITAN_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0";

/** Ingest function timeout. The stale-claim threshold is derived from it. */
const INGEST_TIMEOUT = Duration.minutes(5);

/**
 * Phase 3.1 — course document ingestion.
 *
 * Everything here scales to zero: an S3 bucket for raw uploads, an S3 Vectors
 * bucket (one index per course, created at runtime), two Lambdas, and an SQS
 * queue that only ever holds failed ingest events. No VPC, so no NAT Gateway —
 * every service is reached over its public AWS endpoint with IAM auth.
 *
 *   browser --presigned POST--> docs bucket (raw/) --ObjectCreated--> ingest
 *   ingest --> Bedrock Titan (embed) --> S3 Vectors (store) --> DynamoDB (status)
 */
export class RagIngestion extends Construct {
  readonly docsBucket: s3.Bucket;
  readonly vectorBucketName: string;
  readonly coursesFn: NodejsFunction;
  readonly ingestFn: NodejsFunction;
  readonly creatorKeyParamName: string;

  constructor(scope: Construct, id: string, props: RagIngestionProps) {
    super(scope, id);

    const { environment, table, httpApi } = props;
    const { region } = Stack.of(this);
    const handlersDir = path.join(__dirname, "..", "..", "packages", "rag", "src", "handlers");

    // --- Storage ---------------------------------------------------------------

    // Course material outlives any one deployment, so both buckets are retained
    // on stack deletion. Raw files are kept so a better chunker can re-ingest
    // them later without asking professors to upload again.
    this.docsBucket = new s3.Bucket(this, "DocsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: [
        {
          // Browsers POST straight to S3 with the presigned form. Phase 4
          // narrows the origin to the CloudFront domain.
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
    });

    this.vectorBucketName = `backrow-${environment}-vectors`;
    const vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", {
      vectorBucketName: this.vectorBucketName,
    });
    // Indexes are created at runtime, one per course; CloudFormation can't
    // delete a vector bucket that still has them, and course data shouldn't
    // vanish with a stack teardown anyway.
    vectorBucket.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const vectorBucketArn = vectorBucket.attrVectorBucketArn;
    const indexArns = `${vectorBucketArn}/index/*`;

    // The creator key is a SecureString created by hand (CloudFormation can't
    // create SecureStrings, and a secret shouldn't live in a template anyway).
    // See the README for creating and rotating it.
    this.creatorKeyParamName = `/backrow/${environment}/course-creator-key`;
    const creatorKey = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "CreatorKey",
      { parameterName: this.creatorKeyParamName }
    );

    // --- Courses HTTP handler ---------------------------------------------------

    this.coursesFn = backrowFunction(this, "CoursesFn", {
      environment,
      name: "courses",
      entry: path.join(handlersDir, "courses.ts"),
      timeoutSec: 15,
      env: {
        TABLE_NAME: table.tableName,
        DOCS_BUCKET: this.docsBucket.bucketName,
        VECTOR_BUCKET: this.vectorBucketName,
        CREATOR_KEY_PARAM: this.creatorKeyParamName,
        MAX_COURSES_PER_CREATOR_KEY: "20",
      },
    });
    table.grantReadWriteData(this.coursesFn);
    creatorKey.grantRead(this.coursesFn);
    // PutObject is what makes the presigned POST it signs valid; it never
    // uploads anything itself. Delete is for removing documents.
    this.docsBucket.grantPut(this.coursesFn, "raw/*");
    this.docsBucket.grantDelete(this.coursesFn, "raw/*");
    this.coursesFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:CreateIndex", "s3vectors:GetIndex"],
        resources: [vectorBucketArn, indexArns],
      })
    );
    this.coursesFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:DeleteVectors"],
        resources: [indexArns],
      })
    );

    const coursesIntegration = new HttpLambdaIntegration("CoursesIntegration", this.coursesFn);
    for (const route of [
      { path: "/courses", methods: [HttpMethod.POST] },
      { path: "/courses/{courseId}/documents", methods: [HttpMethod.POST, HttpMethod.GET] },
      { path: "/courses/{courseId}/documents/{docId}", methods: [HttpMethod.DELETE] },
    ]) {
      httpApi.addRoutes({ ...route, integration: coursesIntegration });
    }

    // --- Ingest -----------------------------------------------------------------

    this.ingestFn = backrowFunction(this, "IngestFn", {
      environment,
      name: "ingest",
      entry: path.join(handlersDir, "ingest.ts"),
      // PDF parsing is CPU-bound and Lambda CPU scales with memory.
      memoryMb: 1024,
      timeoutSec: INGEST_TIMEOUT.toSeconds(),
      reservedConcurrency: props.ingestReservedConcurrency,
      env: {
        TABLE_NAME: table.tableName,
        DOCS_BUCKET: this.docsBucket.bucketName,
        VECTOR_BUCKET: this.vectorBucketName,
        // A `processing` claim older than one full timeout belongs to an
        // invocation that is certainly dead, so a retry may take it over.
        INGEST_STALE_MS: String(INGEST_TIMEOUT.toMilliseconds()),
      },
    });
    table.grantReadWriteData(this.ingestFn);
    this.docsBucket.grantRead(this.ingestFn, "raw/*");
    // For removing orphaned uploads whose document row already expired.
    this.docsBucket.grantDelete(this.ingestFn, "raw/*");
    this.ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:PutVectors", "s3vectors:DeleteVectors"],
        resources: [indexArns],
      })
    );
    this.ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:${region}::foundation-model/${TITAN_EMBED_MODEL_ID}`],
      })
    );

    // S3 invokes asynchronously: a throttle is queued and retried rather than
    // dropped. One retry covers a timeout (the stale-claim rule lets it take
    // over); every other failure is already recorded on the document by the
    // handler. Events that exhaust retries land here, holding only bucket and
    // key — no document content — so a short retention is all that's needed.
    const ingestDlq = new sqs.Queue(this, "IngestDlq", {
      queueName: `backrow-${environment}-ingest-dlq`,
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.ingestFn.configureAsyncInvoke({
      retryAttempts: 1,
      maxEventAge: Duration.hours(1),
      onFailure: new SqsDestination(ingestDlq),
    });

    this.docsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.ingestFn),
      { prefix: "raw/" }
    );
  }
}
