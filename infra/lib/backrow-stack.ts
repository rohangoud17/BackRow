import * as path from "node:path";
import {
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, IFunction } from "aws-cdk-lib/aws-lambda";
import {
  WebSocketApi,
  WebSocketStage,
  HttpApi,
  HttpMethod,
  CorsHttpMethod,
} from "aws-cdk-lib/aws-apigatewayv2";
import {
  WebSocketLambdaIntegration,
  HttpLambdaIntegration,
} from "aws-cdk-lib/aws-apigatewayv2-integrations";

export interface BackrowStackProps extends StackProps {
  /** Deployment environment name, e.g. "dev". Drives all resource naming. */
  environment: string;
}

/**
 * Phase 1 — realtime core.
 *
 * Everything here is scale-to-zero (API Gateway, Lambda, DynamoDB on-demand,
 * SSM). No Redis, no vector store: see docs/adr/0001 for the cost posture.
 *
 * One Lambda per WebSocket route rather than a single dispatcher, so each has
 * its own metrics, log group, and least-privilege IAM policy. That's worth the
 * extra cold-start surface — $connect and $default are hit at different times
 * and it's much easier to reason about a handler that does one thing.
 */
export class BackrowStack extends Stack {
  constructor(scope: Construct, id: string, props: BackrowStackProps) {
    super(scope, id, props);

    const { environment } = props;
    const handlersDir = path.join(
      __dirname,
      "..",
      "..",
      "packages",
      "realtime",
      "src",
      "handlers"
    );

    // --- Single-table store. On-demand is cheapest at our volume. ---------
    const table = new dynamodb.Table(this, "Table", {
      tableName: `backrow-${environment}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Dev-friendly teardown. Switch to RETAIN before a real pilot.
      removalPolicy: RemovalPolicy.DESTROY,
      // Expires abandoned sessions and any connection record that outlived its
      // socket — the backstop behind $disconnect and the 410-Gone prune.
      timeToLiveAttribute: "ttl",
    });

    // --- Non-secret config document (see ADR 0001) ------------------------
    const configParam = new ssm.StringParameter(this, "ConfigParam", {
      parameterName: `/backrow/${environment}/config`,
      stringValue: JSON.stringify({
        featureFlags: {},
        note: "Backrow app config document (non-secret).",
      }),
      description: "Backrow app config document (non-secret).",
    });

    /** Build a handler with our conventions applied consistently. */
    const fn = (
      id: string,
      entry: string,
      opts: { memoryMb?: number; timeoutSec?: number } = {}
    ): NodejsFunction => {
      const logGroup = new logs.LogGroup(this, `${id}Logs`, {
        logGroupName: `/aws/lambda/backrow-${environment}-${entry}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      return new NodejsFunction(this, id, {
        functionName: `backrow-${environment}-${entry}`,
        runtime: Runtime.NODEJS_22_X,
        entry: path.join(handlersDir, `${entry}.ts`),
        handler: "handler",
        timeout: Duration.seconds(opts.timeoutSec ?? 10),
        memorySize: opts.memoryMb ?? 256,
        logGroup,
        environment: {
          ENVIRONMENT: environment,
          TABLE_NAME: table.tableName,
          CONFIG_PARAM_NAME: configParam.parameterName,
          // Trims ~100ms of cold start; we don't need the SDK's own tracing.
          AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
        },
        bundling: {
          // Bundle the SDK instead of trusting whatever the runtime ships, so
          // the version is pinned and reproducible.
          externalModules: [],
          minify: true,
          sourceMap: true,
        },
      });
    };

    // --- Handlers ---------------------------------------------------------
    const connectFn = fn("ConnectFn", "connect");
    const disconnectFn = fn("DisconnectFn", "disconnect");
    const messageFn = fn("MessageFn", "message");
    const sessionsFn = fn("SessionsFn", "sessions", { timeoutSec: 15 });

    // Least privilege: $connect only ever writes its own connection record.
    table.grantWriteData(connectFn);
    table.grantReadWriteData(disconnectFn);
    table.grantReadWriteData(messageFn);
    table.grantReadWriteData(sessionsFn);

    // Only the health check reads config.
    configParam.grantRead(sessionsFn);

    // --- WebSocket API ----------------------------------------------------
    // Each route gets its OWN integration instance. A shared instance binds
    // once, so only the first route would get an invoke permission and the
    // others fail with "Internal server error" and no log line at all. That
    // cost us an afternoon in Phase 0 — the stack test now asserts against it.
    const wsApi = new WebSocketApi(this, "WsApi", {
      apiName: `backrow-${environment}-ws`,
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          "ConnectIntegration",
          connectFn
        ),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          "DisconnectIntegration",
          disconnectFn
        ),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          "DefaultIntegration",
          messageFn
        ),
        // No `returnResponse` on purpose: it synthesizes a RouteResponse but no
        // IntegrationResponse, so the handler's return value still never
        // reaches the client. Replies go out via PostToConnection instead.
      },
    });

    const wsStage = new WebSocketStage(this, "WsStage", {
      webSocketApi: wsApi,
      stageName: environment,
      autoDeploy: true,
    });

    // Anything that pushes to a client needs execute-api:ManageConnections.
    // $connect never pushes, so it doesn't get it.
    for (const pusher of [disconnectFn, messageFn] as IFunction[]) {
      wsStage.grantManagementApiAccess(pusher);
    }

    // --- HTTP API ---------------------------------------------------------
    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: `backrow-${environment}-http`,
      corsPreflight: {
        // The SPAs are served from CloudFront, a different origin. Phase 4
        // hardening narrows this to explicit origins.
        allowOrigins: ["*"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ["content-type"],
      },
    });

    const sessionsIntegration = new HttpLambdaIntegration(
      "SessionsIntegration",
      sessionsFn
    );

    for (const route of [
      { path: "/health", methods: [HttpMethod.GET] },
      { path: "/sessions", methods: [HttpMethod.POST] },
      { path: "/sessions/{code}", methods: [HttpMethod.GET] },
    ]) {
      httpApi.addRoutes({ ...route, integration: sessionsIntegration });
    }

    // --- Outputs ----------------------------------------------------------
    new CfnOutput(this, "WebSocketUrl", {
      value: wsStage.url,
      description: "WebSocket connect URL (wss://).",
    });
    new CfnOutput(this, "HttpUrl", {
      value: httpApi.apiEndpoint,
      description: "HTTP API base URL. /health, POST /sessions, GET /sessions/{code}.",
    });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "ConfigParamName", {
      value: configParam.parameterName,
    });
  }
}
