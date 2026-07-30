import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

export interface CiStackProps extends StackProps {
  /** GitHub owner/org, e.g. "rohangoud17". */
  githubOwner: string;
  /** Repository name, e.g. "BackRow". */
  githubRepo: string;
  /** Environment name the deploy job targets. */
  deployEnvironment: string;
  /**
   * ARN of an existing GitHub OIDC provider, if the account already has one.
   *
   * An account can hold only ONE provider per issuer URL, so a second
   * `cdk deploy` that tries to create it fails with EntityAlreadyExists.
   * Pass the existing ARN via `--context oidcProviderArn=...` to import it.
   */
  existingOidcProviderArn?: string;
}

/**
 * CI deployment identity.
 *
 * Deployed once, by hand, from a developer's own credentials — it is the
 * bootstrap of trust that lets GitHub Actions deploy without any stored
 * credential. Separate from the app stack on purpose: it changes almost never,
 * and it must not be destroyed when tearing down an app environment.
 *
 * How it works: GitHub mints a short-lived OIDC token for a workflow run; AWS
 * verifies it against GitHub's public keys and issues temporary credentials.
 * No long-lived access key ever exists to leak, and revoking access is a
 * matter of deleting this role.
 *
 * The role is deliberately NOT an administrator. CDK bootstrap already created
 * roles that hold the real deployment power, so this role's only privilege is
 * permission to assume those. That means widening what CI can do requires
 * touching bootstrap, not quietly editing a policy here.
 */
export class BackrowCiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const { githubOwner, githubRepo, deployEnvironment } = props;

    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GithubOidc",
          props.existingOidcProviderArn
        )
      : new iam.OpenIdConnectProvider(this, "GithubOidc", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });

    // Which workflow runs may assume this role. Both forms are allowed because
    // the `sub` claim depends on how the job is configured: a job with an
    // `environment:` gets the environment form, otherwise the branch ref form.
    // Anything else — a pull request, a fork, another repo — matches neither.
    const allowedSubjects = [
      `repo:${githubOwner}/${githubRepo}:environment:${deployEnvironment}`,
      `repo:${githubOwner}/${githubRepo}:ref:refs/heads/main`,
    ];

    const role = new iam.Role(this, "DeployRole", {
      roleName: `backrow-github-deploy-${deployEnvironment}`,
      description: `GitHub Actions deploy role for ${githubOwner}/${githubRepo}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            // Without the audience check the role could be assumed using a
            // token minted for a different relying party.
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": allowedSubjects,
          },
        }
      ),
    });

    // The only real privilege: assume the CDK bootstrap roles. Those already
    // carry the deployment permissions, scoped by the bootstrap template.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-image-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${this.region}`,
        ],
      })
    );

    // The CLI reads the bootstrap version before it assumes anything.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadBootstrapVersion",
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`,
        ],
      })
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: role.roleArn,
      description:
        "Set as the AWS_DEPLOY_ROLE_ARN repository secret in GitHub.",
    });
    new CfnOutput(this, "OidcProviderArn", {
      value: provider.openIdConnectProviderArn,
      description:
        "Pass as --context oidcProviderArn=... if you redeploy this stack.",
    });
  }
}
