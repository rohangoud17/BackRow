import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";

export interface BackrowFunctionProps {
  environment: string;
  /** Short name; becomes `backrow-<env>-<name>` for the function and its logs. */
  name: string;
  /** Absolute path to the handler's .ts file. */
  entry: string;
  env: Record<string, string>;
  memoryMb?: number;
  timeoutSec?: number;
  reservedConcurrency?: number;
}

/**
 * Every Backrow Lambda, built the same way: Node 22, a named log group with
 * one-week retention, and the SDK bundled rather than taken from the runtime.
 *
 * Shared by the realtime stack and the RAG construct so a convention changed in
 * one place applies everywhere.
 */
export function backrowFunction(
  scope: Construct,
  id: string,
  props: BackrowFunctionProps
): NodejsFunction {
  const { environment, name } = props;

  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/lambda/backrow-${environment}-${name}`,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  return new NodejsFunction(scope, id, {
    functionName: `backrow-${environment}-${name}`,
    runtime: Runtime.NODEJS_22_X,
    entry: props.entry,
    handler: "handler",
    timeout: Duration.seconds(props.timeoutSec ?? 10),
    memorySize: props.memoryMb ?? 256,
    reservedConcurrentExecutions: props.reservedConcurrency,
    logGroup,
    environment: {
      ENVIRONMENT: environment,
      // Trims ~100ms of cold start; we don't need the SDK's own tracing.
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      ...props.env,
    },
    bundling: {
      // Bundle the SDK instead of trusting whatever the runtime ships, so
      // the version is pinned and reproducible.
      externalModules: [],
      minify: true,
      sourceMap: true,
    },
  });
}
