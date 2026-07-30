import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { BackrowStack } from "../lib/backrow-stack";

/**
 * Phase 1 stack assertions. Runs in CI with no AWS account.
 *
 * These lean deliberately toward "is it actually invokable and least
 * privileged", not just "does the resource exist". The Phase 0 bug that cost us
 * an afternoon passed a test asserting routes existed — while the routes had no
 * invoke permission and never reached the Lambda.
 */
function synth(): Template {
  const app = new App();
  const stack = new BackrowStack(app, "Backrow-test", { environment: "test" });
  return Template.fromStack(stack);
}

describe("BackrowStack (Phase 1 realtime core)", () => {
  const template = synth();

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

  test("one Lambda per route concern, all on Node 22", () => {
    template.resourceCountIs("AWS::Lambda::Function", 4);
    for (const name of [
      "backrow-test-connect",
      "backrow-test-disconnect",
      "backrow-test-message",
      "backrow-test-sessions",
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
   * Six routes must mean six permissions.
   */
  test("every route has an invoke permission", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 6);
    template.resourceCountIs("AWS::Lambda::Permission", 6);

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
    const policies = Object.values(
      template.findResources("AWS::IAM::Policy")
    ).filter((p) =>
      JSON.stringify(p.Properties?.PolicyDocument).includes(
        "execute-api:ManageConnections"
      )
    );
    // $disconnect (presence update) and $default (replies + fan-out). Not
        // $connect, which never pushes, and not the HTTP handler.
    expect(policies).toHaveLength(2);
  });

  test("$connect gets write-only table access, not read", () => {
    const connectPolicy = Object.values(
      template.findResources("AWS::IAM::Policy")
    ).find((p) => {
      const doc = JSON.stringify(p.Properties?.PolicyDocument);
      return doc.includes("dynamodb:PutItem") && !doc.includes("ManageConnections");
    });

    const doc = JSON.stringify(connectPolicy?.Properties?.PolicyDocument);
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
    ]) {
      template.hasOutput(key, {});
    }
  });
});
