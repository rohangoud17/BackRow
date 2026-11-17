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

/**
 * Reserved concurrency for the answer Lambda: how many assistant answers run at
 * once. Defaults to 20, which caps Bedrock spend and protects the realtime
 * handlers. Needs an account limit above the default of 10 — pass
 * `--context answerConcurrency=0` to reserve nothing on such an account.
 */
const answerConcurrency = Number(app.node.tryGetContext("answerConcurrency") ?? 20);

/** Assistant asks per course per UTC day; ~$0.005 each. */
const assistantDailyLimit = Number(app.node.tryGetContext("assistantDailyLimit") ?? 200);

/**
 * Optional Bedrock Guardrail on assistant questions. Off unless both the id
 * and a version are given: `--context assistantGuardrailId=... --context
 * assistantGuardrailVersion=1`.
 */
const guardrailId = app.node.tryGetContext("assistantGuardrailId") as string | undefined;
const guardrailVersion =
  (app.node.tryGetContext("assistantGuardrailVersion") as string | undefined) ?? "DRAFT";

new BackrowStack(app, `Backrow-${environment}`, {
  environment,
  assistantGuardrail: guardrailId ? { id: guardrailId, version: guardrailVersion } : undefined,
  ingestReservedConcurrency: ingestConcurrency ? Number(ingestConcurrency) : undefined,
  answerReservedConcurrency: answerConcurrency > 0 ? answerConcurrency : undefined,
  assistantDailyLimit,
  env,
  description: `Backrow ${environment} — realtime core, RAG ingestion and course assistant.`,
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
