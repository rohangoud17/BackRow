import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { BackrowStack } from "../lib/backrow-stack";

/**
 * Stack assertions. Runs in CI with no AWS account.
 *
 * These lean deliberately toward "is it actually invokable and least
 * privileged", not just "does the resource exist". The Phase 0 bug that cost us
 * an afternoon passed a test asserting routes existed — while the routes had no
 * invoke permission and never reached the Lambda.
 */
function synth(
  props: {
    ingestReservedConcurrency?: number;
    answerReservedConcurrency?: number;
    assistantDailyLimit?: number;
    assistantGuardrail?: { id: string; version: string };
  } = {}
): Template {
  const app = new App();
  const stack = new BackrowStack(app, "Backrow-test", { environment: "test", ...props });
  return Template.fromStack(stack);
}

/** Every IAM policy document in the template, serialized for substring checks. */
const policyDocs = (template: Template): string[] =>
  Object.values(template.findResources("AWS::IAM::Policy")).map((p) =>
    JSON.stringify(p.Properties?.PolicyDocument)
  );

/** The serialized inline policy attached to one function's role. */
function policyFor(template: Template, functionName: string): string {
  const fns = template.findResources("AWS::Lambda::Function", {
    Properties: { FunctionName: functionName },
  });
  const roleId = Object.values(fns)[0].Properties.Role["Fn::GetAtt"][0];
  const policy = Object.values(template.findResources("AWS::IAM::Policy")).find((p) =>
    JSON.stringify(p.Properties?.Roles).includes(`"${roleId}"`)
  );
  return JSON.stringify(policy?.Properties?.PolicyDocument);
}

// Synthesized once and shared: bundling seven functions is the slow part.
const template = synth();

describe("BackrowStack (Phase 1 realtime core)", () => {
  test("one on-demand table with PK/SK and TTL enabled", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      // TTL is the backstop behind $disconnect and the 410-Gone prune. Without
      // it, every missed cleanup leaks a row forever.
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  test("the table is retained on stack deletion", () => {
    // It holds courses and document records since Phase 3.1, which must not
    // disappear with a dev-stack teardown.
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("one Lambda per route concern, all on Node 22", () => {
    // Plus CDK's own bucket-notifications handler, which isn't ours to name.
    const ours = Object.values(template.findResources("AWS::Lambda::Function")).filter((f) =>
      String(f.Properties?.FunctionName ?? "").startsWith("backrow-test-")
    );
    expect(ours).toHaveLength(7);
    for (const name of [
      "backrow-test-connect",
      "backrow-test-disconnect",
      "backrow-test-message",
      "backrow-test-sessions",
      "backrow-test-courses",
      "backrow-test-ingest",
      "backrow-test-answer",
    ]) {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: name,
        Runtime: "nodejs22.x",
      });
    }
  });

  test("WebSocket API exposes connect, disconnect, and default", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "WEBSOCKET",
    });
    for (const routeKey of ["$connect", "$disconnect", "$default"]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
      });
    }
  });

  test("HTTP API exposes health and session routes", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
    });
    for (const routeKey of [
      "GET /health",
      "POST /sessions",
      "GET /sessions/{code}",
    ]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
      });
    }
  });

  /**
   * Regression test for the Phase 0 bug. A shared WebSocketLambdaIntegration
   * binds only once, so only the first route gets an invoke permission and the
   * rest fail with a bare "Internal server error" and no CloudWatch entry.
   * Ten routes must mean ten API Gateway invoke permissions.
   */
  test("every route has an invoke permission", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 10);
    const fromApiGateway = Object.values(
      template.findResources("AWS::Lambda::Permission")
    ).filter((p) => p.Properties?.Principal === "apigateway.amazonaws.com");
    expect(fromApiGateway).toHaveLength(10);

    for (const routeKey of ["$connect", "$disconnect", "$default"]) {
      template.hasResourceProperties("AWS::Lambda::Permission", {
        Action: "lambda:InvokeFunction",
        Principal: "apigateway.amazonaws.com",
        SourceArn: Match.objectLike({
          "Fn::Join": Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp(`\\${routeKey}$`)]),
          ]),
        }),
      });
    }
  });

  test("does not rely on route responses to reply to clients", () => {
    // returnResponse synthesizes a RouteResponse but no IntegrationResponse, so
    // the handler's return value never reaches the client. We push with
    // PostToConnection instead — asserting zero here keeps someone from
    // "fixing" it back to the broken shape.
    template.resourceCountIs("AWS::ApiGatewayV2::RouteResponse", 0);
  });

  test("only the handlers that push to clients get ManageConnections", () => {
    const policies = policyDocs(template).filter((doc) =>
      doc.includes("execute-api:ManageConnections")
    );
    // $disconnect (presence update), $default (replies + fan-out) and the
    // answer Lambda (streams to the asker). Not $connect, which never pushes,
    // not the HTTP handlers, not ingest.
    expect(policies).toHaveLength(3);
  });

  test("$connect gets write-only table access, not read", () => {
    const doc = policyFor(template, "backrow-test-connect");
    expect(doc).toContain("dynamodb:PutItem");
    // It only ever writes its own connection record.
    expect(doc).not.toContain("dynamodb:Query");
    expect(doc).not.toContain("dynamodb:GetItem");
  });

  test("creates the SSM config parameter", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/backrow/test/config",
      Type: "String",
    });
  });

  test("exports the endpoints a developer needs after deploy", () => {
    for (const key of [
      "WebSocketUrl",
      "HttpUrl",
      "TableName",
      "ConfigParamName",
      "DocsBucketName",
      "VectorBucketName",
      "CreatorKeyParamName",
    ]) {
      template.hasOutput(key, {});
    }
  });
});

describe("BackrowStack (Phase 3.1 RAG ingestion)", () => {
  test("HTTP API exposes the course and document routes", () => {
    for (const routeKey of [
      "POST /courses",
      "POST /courses/{courseId}/documents",
      "GET /courses/{courseId}/documents",
      "DELETE /courses/{courseId}/documents/{docId}",
    ]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: routeKey });
    }
  });

  test("CORS allows the headers and method the course routes need", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.arrayWith(["DELETE"]),
        AllowHeaders: Match.arrayWith(["x-creator-key", "x-course-token"]),
      }),
    });
  });

  test("no VPC, so no NAT Gateway and nothing always-on", () => {
    // A NAT Gateway is ~$32/month idle. Nothing here needs a VPC: every
    // service is reached over its public endpoint with IAM auth.
    for (const type of ["AWS::EC2::VPC", "AWS::EC2::NatGateway", "AWS::EC2::EIP"]) {
      template.resourceCountIs(type, 0);
    }
    for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
      expect(fn.Properties?.VpcConfig).toBeUndefined();
    }
  });

  test("the docs bucket is private, encrypted, TLS-only and retained", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: Match.anyValue(),
        CorsConfiguration: {
          CorsRules: [Match.objectLike({ AllowedMethods: ["POST"] })],
        },
      }),
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      }),
    });
  });

  test("one retained vector bucket; indexes are created per course at runtime", () => {
    template.resourceCountIs("AWS::S3Vectors::VectorBucket", 1);
    template.hasResource("AWS::S3Vectors::VectorBucket", {
      DeletionPolicy: "Retain",
      Properties: { VectorBucketName: "backrow-test-vectors" },
    });
    template.resourceCountIs("AWS::S3Vectors::Index", 0);
  });

  test("uploads under raw/ trigger ingest", () => {
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "raw/" }] } },
          }),
        ],
      },
    });
  });

  test("ingest has headroom, one retry, and a failure queue", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-ingest",
      MemorySize: 1024,
      Timeout: 300,
      Environment: { Variables: Match.objectLike({ INGEST_STALE_MS: "300000" }) },
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 1,
      MaximumEventAgeInSeconds: 3600,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "backrow-test-ingest-dlq",
    });
  });

  test("ingest reserves no concurrency unless asked to", () => {
    // A reservation on a new account at the default limit of 10 fails the deploy.
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-ingest",
      ReservedConcurrentExecutions: Match.absent(),
    });
    synth({ ingestReservedConcurrency: 5 }).hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-ingest",
      ReservedConcurrentExecutions: 5,
    });
  });

  test("ingest may embed with Titan v2 only, and store but not create indexes", () => {
    const doc = policyFor(template, "backrow-test-ingest");
    expect(doc).toContain("bedrock:InvokeModel");
    expect(doc).toContain("foundation-model/amazon.titan-embed-text-v2:0");
    expect(doc).toContain("s3vectors:PutVectors");
    expect(doc).not.toContain("s3vectors:CreateIndex");
    expect(doc).not.toContain("ssm:GetParameter");
    expect(doc).not.toContain("ManageConnections");
  });

  test("courses may create indexes and read the creator key, but never call Bedrock", () => {
    const doc = policyFor(template, "backrow-test-courses");
    expect(doc).toContain("s3vectors:CreateIndex");
    expect(doc).toContain("ssm:GetParameter");
    expect(doc).toContain("parameter/backrow/test/course-creator-key");
    expect(doc).not.toContain("bedrock:");
    expect(doc).not.toContain("s3vectors:PutVectors");
  });

  test("no policy grants wildcard S3 Vectors or Bedrock actions", () => {
    for (const doc of policyDocs(template)) {
      expect(doc).not.toContain('"s3vectors:*"');
      expect(doc).not.toContain('"bedrock:*"');
    }
  });

  test("the realtime handlers gained no RAG permissions", () => {
    for (const name of ["connect", "disconnect", "message", "sessions"]) {
      const doc = policyFor(template, `backrow-test-${name}`);
      expect(doc).not.toContain("s3vectors:");
      expect(doc).not.toContain("bedrock:");
    }
  });
});

describe("BackrowStack (Phase 3.2 course assistant)", () => {
  const answerPolicy = () => policyFor(template, "backrow-test-answer");

  test("the answer Lambda has no route; only $default reaches it", () => {
    // Still 10 routes and 10 API Gateway permissions: nothing new is public.
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 10);
    const answerPermissions = Object.values(template.findResources("AWS::Lambda::Permission")).filter(
      (p) => JSON.stringify(p.Properties?.FunctionName).includes("AnswerFn")
    );
    expect(answerPermissions).toHaveLength(0);
  });

  test("no retries, a one-minute event age, and a failure queue", () => {
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      FunctionName: Match.objectLike({ Ref: Match.stringLikeRegexp("AnswerFn") }),
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 60,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties("AWS::SQS::Queue", { QueueName: "backrow-test-answer-dlq" });
  });

  test("streams Haiku 4.5 through the US inference profile only", () => {
    const doc = answerPolicy();
    expect(doc).toContain("bedrock:InvokeModelWithResponseStream");
    expect(doc).toContain("inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0");
    for (const region of ["us-east-1", "us-east-2", "us-west-2"]) {
      expect(doc).toContain(`arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`);
    }
    // The global profile would route outside the US.
    expect(doc).not.toContain("global.");
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-answer",
      Environment: {
        Variables: Match.objectLike({ ANSWER_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }),
      },
    });
  });

  test("may embed with Titan and query vectors, but never delete them", () => {
    const doc = answerPolicy();
    expect(doc).toContain("foundation-model/amazon.titan-embed-text-v2:0");
    expect(doc).toContain("s3vectors:QueryVectors");
    expect(doc).not.toContain("s3vectors:DeleteVectors");
    expect(doc).not.toContain("ssm:");
    expect(doc).not.toContain("lambda:InvokeFunction");
  });

  test("may write only to question-cache indexes, never to course chunks", () => {
    const statements = JSON.parse(answerPolicy()).Statement as {
      Action: string | string[];
      Resource: unknown;
    }[];
    const granting = (action: string) =>
      statements.filter((st) => [st.Action].flat().includes(action));

    const puts = granting("s3vectors:PutVectors");
    expect(puts).toHaveLength(1);
    expect(JSON.stringify(puts[0].Resource)).toContain("/index/qcache-*");
    expect(JSON.stringify(puts[0].Resource)).not.toContain("/index/*");

    const creates = granting("s3vectors:CreateIndex");
    expect(creates).toHaveLength(1);
    expect(JSON.stringify(creates[0].Resource)).toContain("/index/qcache-*");
    expect(JSON.stringify(creates[0].Resource)).not.toContain("/index/*");
  });

  test("no guardrail, and no guardrail permission, unless one is configured", () => {
    expect(answerPolicy()).not.toContain("bedrock:ApplyGuardrail");
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-answer",
      Environment: { Variables: Match.objectLike({ ASSISTANT_GUARDRAIL_ID: Match.absent() }) },
    });

    const t = synth({ assistantGuardrail: { id: "gr123", version: "2" } });
    const doc = policyFor(t, "backrow-test-answer");
    expect(doc).toContain("bedrock:ApplyGuardrail");
    expect(doc).toContain(":guardrail/gr123");
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-answer",
      Environment: {
        Variables: Match.objectLike({
          ASSISTANT_GUARDRAIL_ID: "gr123",
          ASSISTANT_GUARDRAIL_VERSION: "2",
        }),
      },
    });
  });

  test("gets the WebSocket callback URL, not SSM, for config", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-answer",
      Environment: {
        Variables: Match.objectLike({
          WS_ENDPOINT: Match.anyValue(),
          VECTOR_BUCKET: "backrow-test-vectors",
          ASSISTANT_MIN_SCORE: "0.2",
          ASSISTANT_CACHE_THRESHOLD: "0.94",
        }),
      },
    });
  });

  test("$default may invoke exactly the answer Lambda, and nothing else new", () => {
    const doc = policyFor(template, "backrow-test-message");
    expect(doc).toContain("lambda:InvokeFunction");
    expect(doc).toContain(":function:backrow-test-answer");
    expect(doc).not.toContain(":function:*");
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-message",
      Environment: {
        Variables: Match.objectLike({
          ANSWER_FUNCTION_NAME: "backrow-test-answer",
          ASSISTANT_DAILY_LIMIT: "200",
        }),
      },
    });
  });

  test("the daily limit and reserved concurrency are configurable", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-answer",
      ReservedConcurrentExecutions: Match.absent(),
    });
    const t = synth({ answerReservedConcurrency: 20, assistantDailyLimit: 50 });
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-answer",
      ReservedConcurrentExecutions: 20,
    });
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "backrow-test-message",
      Environment: { Variables: Match.objectLike({ ASSISTANT_DAILY_LIMIT: "50" }) },
    });
  });
});
