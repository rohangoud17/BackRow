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
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  HttpApi,
  HttpMethod,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

export interface BackrowStackProps extends StackProps {
  /** Deployment environment name, e.g. "dev". Drives resource naming. */
  environment: string;
}

/**
 * Phase 0 skeleton stack. Everything here is scale-to-zero (API Gateway,
 * Lambda, DynamoDB on-demand, SSM) — no always-on cost. See docs/adr/0001
 * for the cost posture and the decisions this stack encodes.
 */
export class BackrowStack extends Stack {
  constructor(scope: Construct, id: string, props: BackrowStackProps) {
    super(scope, id, props);

    const { environment } = props;

    // --- Single-table DynamoDB store (on-demand = cheapest at dev volume) ---
    const table = new dynamodb.Table(this, "Table", {
      tableName: `backrow-${environment}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Dev-friendly: tear down cleanly. Change to RETAIN for prod.
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // --- Config/secrets strategy: SSM Parameter Store (see ADR 0001) ---
    // A plain String param for non-secret config; secrets would use
    // SecureString or Secrets Manager. Seeded with a placeholder document.
    const configParam = new ssm.StringParameter(this, "ConfigParam", {
      parameterName: `/backrow/${environment}/config`,
      stringValue: JSON.stringify({
        featureFlags: {},
        note: "Phase 0 placeholder config document.",
      }),
      description: "Backrow app config document (non-secret).",
    });

    // --- One placeholder Lambda backing every wired route ---
    // Explicit log group (the deprecated `logRetention` prop spawns a custom
    // resource; an owned LogGroup is cheaper and cleaner).
    const placeholderLogGroup = new logs.LogGroup(this, "PlaceholderFnLogs", {
      logGroupName: `/aws/lambda/backrow-${environment}-placeholder`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const placeholderFn = new NodejsFunction(this, "PlaceholderFn", {
      functionName: `backrow-${environment}-placeholder`,
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(
        __dirname,
        "..",
        "..",
        "packages",
        "realtime",
        "src",
        "handlers",
        "placeholder.ts"
      ),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      logGroup: placeholderLogGroup,
      environment: {
        ENVIRONMENT: environment,
        TABLE_NAME: table.tableName,
        CONFIG_PARAM_NAME: configParam.parameterName,
      },
      bundling: {
        // Bundle the AWS SDK rather than relying on whichever version the
        // runtime ships. Slightly larger artifact, but the version is pinned
        // and there's no "is this client present in the runtime?" guesswork.
        externalModules: [],
        minify: true,
        sourceMap: true,
      },
    });

    table.grantReadWriteData(placeholderFn);
    configParam.grantRead(placeholderFn);

    // --- WebSocket API: the realtime channel ($connect/$disconnect/$default) ---
    // IMPORTANT: each route needs its OWN WebSocketLambdaIntegration instance.
    // A single instance binds only once (to the first route it's attached to),
    // so reusing one across routes creates an invoke permission for that route
    // only — the others fail with "Internal server error" and the Lambda is
    // never invoked. See the permission-count assertions in the stack test.
    const wsApi = new WebSocketApi(this, "WsApi", {
      apiName: `backrow-${environment}-ws`,
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          "ConnectIntegration",
          placeholderFn
        ),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          "DisconnectIntegration",
          placeholderFn
        ),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          "DefaultIntegration",
          placeholderFn
        ),
        // NOTE: deliberately NOT using `returnResponse: true`. It synthesizes
        // a RouteResponse but no IntegrationResponse, so the handler's return
        // value still never reaches the client. The handler pushes replies
        // with PostToConnection instead — which is what Phase 1 fan-out needs.
      },
    });
    const wsStage = new WebSocketStage(this, "WsStage", {
      webSocketApi: wsApi,
      stageName: environment,
      autoDeploy: true,
    });
    // Let the Lambda call back to clients via PostToConnection (used in Phase 1).
    wsApi.grantManageConnections(placeholderFn);

    // --- Stub HTTP API: GET /health ---
    const httpIntegration = new HttpLambdaIntegration(
      "PlaceholderHttpIntegration",
      placeholderFn
    );
    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: `backrow-${environment}-http`,
    });
    httpApi.addRoutes({
      path: "/health",
      methods: [HttpMethod.GET],
      integration: httpIntegration,
    });

    // --- Outputs a developer needs after deploy ---
    new CfnOutput(this, "WebSocketUrl", {
      value: wsStage.url,
      description: "WebSocket connect URL (wss://).",
    });
    new CfnOutput(this, "HttpUrl", {
      value: httpApi.apiEndpoint,
      description: "HTTP API base URL. Health check at /health.",
    });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "ConfigParamName", {
      value: configParam.parameterName,
    });
  }
}
