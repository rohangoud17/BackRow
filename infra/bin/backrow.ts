#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { BackrowStack } from "../lib/backrow-stack";
import { BackrowCiStack } from "../lib/ci-stack";

const app = new App();

// Environment name comes from `cdk --context env=dev`; defaults to "dev".
const environment = (app.node.tryGetContext("env") as string) ?? "dev";

const env = {
  // Falls back to the CLI's resolved account/region when these are unset.
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new BackrowStack(app, `Backrow-${environment}`, {
  environment,
  env,
  description: `Backrow ${environment} — realtime core.`,
  tags: { project: "backrow", environment, managedBy: "cdk" },
});

/**
 * CI identity stack. Deployed once by hand, never by CI itself — it's the
 * trust anchor that lets CI deploy at all, so it can't depend on CI.
 *
 *   npx cdk deploy Backrow-ci --context githubOwner=... --context githubRepo=...
 *
 * If the account already has a GitHub OIDC provider (only one per issuer is
 * allowed), import it with --context oidcProviderArn=arn:aws:iam::...
 */
new BackrowCiStack(app, "Backrow-ci", {
  env,
  githubOwner: (app.node.tryGetContext("githubOwner") as string) ?? "rohangoud17",
  githubRepo: (app.node.tryGetContext("githubRepo") as string) ?? "BackRow",
  deployEnvironment: environment,
  existingOidcProviderArn: app.node.tryGetContext("oidcProviderArn") as
    | string
    | undefined,
  description: "Backrow CI — GitHub OIDC deploy role.",
  tags: { project: "backrow", managedBy: "cdk" },
});
