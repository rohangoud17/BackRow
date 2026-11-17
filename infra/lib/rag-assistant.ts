import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { backrowFunction } from "./lambda";

export interface RagAssistantProps {
  environment: string;
  table: dynamodb.ITable;
  wsStage: WebSocketStage;
  /** The $default handler, which admits questions and invokes the answer Lambda. */
  messageFn: NodejsFunction;
  vectorBucketName: string;
  vectorBucketArn: string;
  /**
   * How many answers may run at once. Caps Bedrock spend and keeps a burst of
   * questions from taking concurrency the realtime handlers need; overflow
   * waits in Lambda's async queue. Undefined reserves nothing (required on an
   * account still at the default concurrency limit of 10).
   */
  answerReservedConcurrency?: number;
  /** Asks per course per UTC day. The cost ceiling. */
  dailyLimit: number;
  /**
   * Optional Bedrock Guardrail applied to each question before retrieval.
   * Unset (the default) means no guardrail and no per-request guardrail charge.
   */
  guardrail?: { id: string; version: string };
}

/** Inference profile for Claude Haiku 4.5. US regions only; see ADR 0002. */
const ANSWER_PROFILE_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const ANSWER_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";
/** The regions the `us.` profile routes to. Each needs its own model ARN in IAM. */
const PROFILE_REGIONS = ["us-east-1", "us-east-2", "us-west-2"];
const TITAN_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0";

/**
 * Phase 3.2 — the course assistant's answer path.
 *
 *   $default (message) --Lambda async invoke, ids only--> answer
 *   answer --> Titan (embed) --> S3 Vectors (retrieve) --> Haiku (stream)
 *          --> PostToConnection to the asker only
 *
 * Scale-to-zero: one Lambda and an SQS queue that only holds failed invokes.
 */
export class RagAssistant extends Construct {
  readonly answerFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: RagAssistantProps) {
    super(scope, id);
    const { environment, table, wsStage, messageFn } = props;
    const { region, account } = Stack.of(this);

    this.answerFn = backrowFunction(this, "AnswerFn", {
      environment,
      name: "answer",
      entry: path.join(__dirname, "..", "..", "packages", "rag", "src", "handlers", "answer.ts"),
      // Mostly waiting on Bedrock; memory buys little here.
      memoryMb: 512,
      timeoutSec: 60,
      reservedConcurrency: props.answerReservedConcurrency,
      env: {
        TABLE_NAME: table.tableName,
        VECTOR_BUCKET: props.vectorBucketName,
        WS_ENDPOINT: wsStage.callbackUrl,
        ANSWER_MODEL_ID: ANSWER_PROFILE_ID,
        // Measured on dev; see DEFAULT_ANSWER_CONFIG.minScore.
        ASSISTANT_MIN_SCORE: "0.2",
        // Measured on dev; see assistant/cache.ts.
        ASSISTANT_CACHE_THRESHOLD: "0.94",
        ...(props.guardrail
          ? {
              ASSISTANT_GUARDRAIL_ID: props.guardrail.id,
              ASSISTANT_GUARDRAIL_VERSION: props.guardrail.version,
            }
          : {}),
      },
    });

    // Reads the ask and course records; updates the ask's status.
    table.grantReadWriteData(this.answerFn);
    // Answers go to one connection at a time, but the permission is per API.
    wsStage.grantManagementApiAccess(this.answerFn);
    this.answerFn.addToRolePolicy(
      new iam.PolicyStatement({
        // QueryVectors with returnMetadata also requires GetVectors.
        actions: ["s3vectors:QueryVectors", "s3vectors:GetVectors"],
        resources: [`${props.vectorBucketArn}/index/*`],
      })
    );
    // The question cache: one `qcache-<org>-<course>` index per course, created
    // on its first cached answer. Write access stops at that name prefix, so
    // this function can never alter course chunks.
    const questionIndexArns = `${props.vectorBucketArn}/index/qcache-*`;
    this.answerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:CreateIndex"],
        resources: [props.vectorBucketArn, questionIndexArns],
      })
    );
    this.answerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:PutVectors"],
        resources: [questionIndexArns],
      })
    );
    if (props.guardrail) {
      this.answerFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:ApplyGuardrail"],
          resources: [`arn:aws:bedrock:${region}:${account}:guardrail/${props.guardrail.id}`],
        })
      );
    }
    this.answerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:${region}::foundation-model/${TITAN_EMBED_MODEL_ID}`],
      })
    );
    this.answerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:${region}:${account}:inference-profile/${ANSWER_PROFILE_ID}`,
          ...PROFILE_REGIONS.map(
            (r) => `arn:aws:bedrock:${r}::foundation-model/${ANSWER_MODEL_ID}`
          ),
        ],
      })
    );

    // No retries: a retry would stream a second copy of the answer. Events older
    // than a minute are dropped, because the student has given up by then. Both
    // failure kinds land here holding only {sessionCode, queryId}.
    const answerDlq = new sqs.Queue(this, "AnswerDlq", {
      queueName: `backrow-${environment}-answer-dlq`,
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.answerFn.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.seconds(60),
      onFailure: new SqsDestination(answerDlq),
    });

    // The message Lambda reaches the answer Lambda by name, not by reference.
    // A reference would make the message Lambda depend on the answer Lambda,
    // which depends on the WebSocket stage, which depends on the message Lambda
    // through its route integration: a CloudFormation cycle.
    const answerFunctionName = `backrow-${environment}-answer`;
    messageFn.addEnvironment("ANSWER_FUNCTION_NAME", answerFunctionName);
    messageFn.addEnvironment("ASSISTANT_DAILY_LIMIT", String(props.dailyLimit));
    messageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [`arn:aws:lambda:${region}:${account}:function:${answerFunctionName}`],
      })
    );
  }
}
