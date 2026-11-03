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

/**
 * Reserved concurrency for the ingest Lambda. Off unless asked for, because
 * Lambda rejects any reservation that would leave fewer than 100 unreserved
 * executions, which fails the deploy outright on a new account still at the
 * default limit of 10. Set it with `--context ingestConcurrency=5` once the
 * account limit has been raised.
 */
const ingestConcurrency = app.node.tryGetContext("ingestConcurrency") as string | undefined;

new BackrowStack(app, `Backrow-${environment}`, {
  environment,
  ingestReservedConcurrency: ingestConcurrency ? Number(ingestConcurrency) : undefined,
  env,
  description: `Backrow ${environment} — realtime core and RAG ingestion.`,
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
  // Repos created after 2026-07-15 emit immutable subject claims embedding
  // these numeric IDs. Override with --context githubOwnerId=... githubRepoId=...
  // Find them: gh api repos/<owner>/<repo> --jq '{owner: .owner.id, repo: .id}'
  githubOwnerId:
    (app.node.tryGetContext("githubOwnerId") as string) ?? "150305286",
  githubRepoId:
    (app.node.tryGetContext("githubRepoId") as string) ?? "1317256096",
  deployEnvironment: environment,
  existingOidcProviderArn: app.node.tryGetContext("oidcProviderArn") as
    | string
    | undefined,
  description: "Backrow CI — GitHub OIDC deploy role.",
  tags: { project: "backrow", managedBy: "cdk" },
});
