import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { FoundationStack } from "../lib/foundation-stack.js";
import { RuntimeStack } from "../lib/runtime-stack.js";

function synthesize() {
  const app = new App();
  const env = { account: "123456789012", region: "us-east-1" };
  const foundation = new FoundationStack(app, "Foundation", { env });
  const runtime = new RuntimeStack(app, "Runtime", { env, foundation });
  return {
    foundation: Template.fromStack(foundation),
    runtime: Template.fromStack(runtime),
  };
}

describe("hackathon infrastructure", () => {
  it("keeps PostgreSQL private, single-AZ, and smallest approved class", () => {
    const { foundation } = synthesize();
    foundation.hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.t4g.micro",
      MultiAZ: false,
      PubliclyAccessible: false,
      AllocatedStorage: "20",
      StorageType: "gp3",
      StorageEncrypted: true,
    });
  });

  it("never places runtime secrets directly in container environment variables", () => {
    const { runtime } = synthesize();
    const secretNames = ["MODEL_GATEWAY_API_KEY", "DB_PASSWORD"];
    const appRunner = Object.values(runtime.findResources("AWS::AppRunner::Service"))[0] as any;
    const appRunnerPlainNames = appRunner.Properties.SourceConfiguration.ImageRepository
      .ImageConfiguration.RuntimeEnvironmentVariables.map((item: { Name: string }) => item.Name);
    const taskDefinition = Object.values(runtime.findResources("AWS::ECS::TaskDefinition"))[0] as any;
    const ecsPlainNames = taskDefinition.Properties.ContainerDefinitions.flatMap(
      (container: { Environment?: Array<{ Name: string }> }) =>
        (container.Environment ?? []).map(item => item.Name),
    );
    expect(appRunnerPlainNames).not.toEqual(expect.arrayContaining(secretNames));
    expect(ecsPlainNames).not.toEqual(expect.arrayContaining(secretNames));
    runtime.resourceCountIs("AWS::SecretsManager::Secret", 0);
  });

  it("uses exactly one NAT gateway and no load balancer", () => {
    const { foundation, runtime } = synthesize();
    foundation.resourceCountIs("AWS::EC2::NatGateway", 1);
    runtime.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
  });

  it("keeps the worker at one minimum-size task", () => {
    const { runtime } = synthesize();
    runtime.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 1 });
    runtime.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "256",
      Memory: "512",
    });
  });

  it("runs App Runner on the minimum CPU with bounded memory", () => {
    const { runtime } = synthesize();
    runtime.hasResourceProperties("AWS::AppRunner::Service", {
      InstanceConfiguration: { Cpu: "0.25 vCPU", Memory: "1 GB" },
      HealthCheckConfiguration: { Path: "/health", Protocol: "HTTP" },
    });
  });
});
