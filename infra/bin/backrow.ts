#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { BackrowStack } from "../lib/backrow-stack";

const app = new App();

// Environment name comes from `cdk --context env=dev`; defaults to "dev".
const environment = (app.node.tryGetContext("env") as string) ?? "dev";

new BackrowStack(app, `Backrow-${environment}`, {
  environment,
  env: {
    // Falls back to the CLI's resolved account/region when these are unset.
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: `Backrow ${environment} — Phase 0 skeleton stack.`,
  tags: {
    project: "backrow",
    environment,
    managedBy: "cdk",
  },
});
