import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { BackrowStack } from "../lib/backrow-stack";

/**
 * Phase 0 unit test: synthesize the stack and assert the wired resources
 * exist. This is the "does the skeleton stand up" check that runs in CI on
 * every PR — no AWS account required.
 */
function synth(): Template {
  const app = new App();
  const stack = new BackrowStack(app, "Backrow-test", { environment: "test" });
  return Template.fromStack(stack);
}

describe("BackrowStack (Phase 0 skeleton)", () => {
  const template = synth();

  test("has one on-demand DynamoDB table with PK/SK", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
  });

  test("provisions a Lambda function on the Node 22 runtime", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
    });
  });

  test("creates a WebSocket API with connect/disconnect/default routes", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "WEBSOCKET",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "$connect",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "$disconnect",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "$default",
    });
  });

  /**
   * Regression test for a real Phase 0 bug: reusing one
   * WebSocketLambdaIntegration instance across $connect/$disconnect/$default
   * binds only once, so only the first route got an invoke permission. The
   * other routes returned "Internal server error" and never reached the
   * Lambda. There must be one permission per WebSocket route, plus one for
   * the HTTP API.
   */
  test("grants API Gateway invoke permission on every WebSocket route", () => {
    template.resourceCountIs("AWS::Lambda::Permission", 4);

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

  test("Lambda can push messages back to clients (PostToConnection)", () => {
    // Replies go out via PostToConnection, not via a route response, so the
    // function needs execute-api:ManageConnections on the WebSocket API.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "execute-api:ManageConnections",
            Effect: "Allow",
          }),
        ]),
      }),
    });
  });

  test("creates a stub HTTP API", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
    });
  });

  test("creates an SSM config parameter", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/backrow/test/config",
      Type: "String",
    });
  });
});
