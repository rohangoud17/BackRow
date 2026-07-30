import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { BackrowCiStack } from "../lib/ci-stack";

/**
 * The trust policy is the entire security boundary here: it decides which
 * GitHub workflow runs can obtain AWS credentials. A wildcard slipped into the
 * `sub` condition would let *any* repository — including a fork opened by a
 * stranger via pull request — deploy into this account. These assertions exist
 * to make that failure impossible to introduce silently.
 */
function synth(
  ctx: Partial<{ oidcArn: string; ownerId?: string; repoId?: string }> = {}
): Template {
  const app = new App();
  const stack = new BackrowCiStack(app, "Backrow-ci", {
    env: { account: "111122223333", region: "us-east-1" },
    githubOwner: "rohangoud17",
    githubRepo: "BackRow",
    githubOwnerId: "ownerId" in ctx ? ctx.ownerId : "150305286",
    githubRepoId: "repoId" in ctx ? ctx.repoId : "1317256096",
    deployEnvironment: "dev",
    existingOidcProviderArn: ctx.oidcArn,
  });
  return Template.fromStack(stack);
}

/** The trust policy of the role that actually matters (not the CR's role). */
function trustDoc(template: Template): string {
  const role = Object.values(template.findResources("AWS::IAM::Role")).find(
    (r) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes(
        "token.actions.githubusercontent.com"
      )
  );
  return JSON.stringify(role!.Properties.AssumeRolePolicyDocument);
}

describe("BackrowCiStack", () => {
  const template = synth();

  test("creates the GitHub OIDC provider with the right audience", () => {
    template.hasResourceProperties("Custom::AWSCDKOpenIdConnectProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIDList: ["sts.amazonaws.com"],
    });
  });

  test("trust is scoped to this repository only", () => {
    const doc = trustDoc(template);

    expect(doc).toContain("repo:rohangoud17/BackRow:environment:dev");
    expect(doc).toContain("repo:rohangoud17/BackRow:ref:refs/heads/main");

    // A bare "repo:*" or a lone "*" would let any repo on GitHub assume this.
    expect(doc).not.toContain('"repo:*"');
    expect(doc).not.toMatch(/"token\.actions\.githubusercontent\.com:sub":\s*"\*"/);
  });

  /**
   * Repositories created after 2026-07-15 emit immutable subject claims that
   * embed numeric owner and repo IDs. A policy written only for the legacy
   * name-only format fails with a bare "Not authorized to perform
   * sts:AssumeRoleWithWebIdentity" and no indication why — which is exactly
   * how this cost us an afternoon.
   */
  test("accepts immutable subject claims with numeric IDs", () => {
    const doc = trustDoc(template);
    expect(doc).toContain(
      "repo:rohangoud17@150305286/BackRow@1317256096:environment:dev"
    );
    expect(doc).toContain(
      "repo:rohangoud17@150305286/BackRow@1317256096:ref:refs/heads/main"
    );
  });

  test("pins the numeric IDs rather than wildcarding them", () => {
    // `repo:rohangoud17@*/BackRow@*` would let a deleted-and-re-registered
    // username inherit this trust — the precise thing immutable IDs prevent.
    const doc = trustDoc(template);
    expect(doc).not.toContain("@*");
  });

  test("omits the immutable form when IDs are not supplied", () => {
    // Repos created before the cutoff still send name-only subjects.
    const legacy = synth({ ownerId: undefined, repoId: undefined });
    const doc = trustDoc(legacy);
    expect(doc).toContain("repo:rohangoud17/BackRow:environment:dev");
    expect(doc).not.toContain("@");
  });

  test("requires the sts.amazonaws.com audience", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: Match.objectLike({
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              },
            }),
          }),
        ]),
      }),
    });
  });

  test("grants no administrative permissions, only bootstrap role assumption", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const doc = JSON.stringify(policies.map((p) => p.Properties.PolicyDocument));

    expect(doc).toContain("sts:AssumeRole");
    expect(doc).toContain("cdk-hnb659fds-deploy-role");

    // The deployment power lives in the bootstrap roles. If someone widens
    // this role instead, that decision should be deliberate and visible.
    expect(doc).not.toContain('"iam:*"');
    expect(doc).not.toContain('"*:*"');
    expect(doc).not.toContain("AdministratorAccess");
  });

  test("no IAM user or access key is created anywhere", () => {
    // The entire point of OIDC is that no long-lived credential exists.
    template.resourceCountIs("AWS::IAM::User", 0);
    template.resourceCountIs("AWS::IAM::AccessKey", 0);
  });

  test("can import an existing OIDC provider instead of creating one", () => {
    // An account allows only one provider per issuer, so a second environment
    // must import rather than create.
    const imported = synth({
      oidcArn:
        "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com",
    });
    imported.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    imported.resourceCountIs("AWS::IAM::Role", 1);
  });

  test("exports the role ARN for the GitHub secret", () => {
    template.hasOutput("DeployRoleArn", {});
  });
});
