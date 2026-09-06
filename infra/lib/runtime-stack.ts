import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apprunner from "aws-cdk-lib/aws-apprunner";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { FoundationStack } from "./foundation-stack.js";

interface RuntimeStackProps extends cdk.StackProps {
  foundation: FoundationStack;
}

export class RuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { foundation } = props;

    const image = new ecrAssets.DockerImageAsset(this, "ApiImage", {
      directory: join(import.meta.dirname, "../.."),
      file: "apps/api/Dockerfile",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    const apiSecurityGroup = new ec2.SecurityGroup(this, "ApiSecurityGroup", {
      vpc: foundation.vpc,
      description: "App Runner VPC connector to the private database",
      allowAllOutbound: true,
    });
    const workerSecurityGroup = new ec2.SecurityGroup(this, "WorkerSecurityGroup", {
      vpc: foundation.vpc,
      description: "Fargate Worker to database and public providers through NAT",
      allowAllOutbound: true,
    });
    const appRunnerAccessRole = new iam.Role(this, "AppRunnerAccessRole", {
      assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
    });
    image.repository.grantPull(appRunnerAccessRole);

    const appRunnerInstanceRole = new iam.Role(this, "AppRunnerInstanceRole", {
      assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
    });
    grantRuntimeSecrets(foundation, appRunnerInstanceRole);
    foundation.nationalityKey.grantEncryptDecrypt(appRunnerInstanceRole);

    const connector = new apprunner.CfnVpcConnector(this, "VpcConnector", {
      subnets: foundation.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }).subnetIds,
      securityGroups: [apiSecurityGroup.securityGroupId],
      vpcConnectorName: "ai-travel-agent-runtime",
    });

    const api = new apprunner.CfnService(this, "ApiService", {
      serviceName: "ai-travel-agent-api",
      sourceConfiguration: {
        autoDeploymentsEnabled: false,
        authenticationConfiguration: { accessRoleArn: appRunnerAccessRole.roleArn },
        imageRepository: {
          imageIdentifier: image.imageUri,
          imageRepositoryType: "ECR",
          imageConfiguration: {
            port: "3000",
            runtimeEnvironmentVariables: runtimeEnvironment(foundation, "ai-travel-agent-api"),
            runtimeEnvironmentSecrets: runtimeSecrets(foundation),
          },
        },
      },
      instanceConfiguration: {
        cpu: "0.25 vCPU",
        memory: "1 GB",
        instanceRoleArn: appRunnerInstanceRole.roleArn,
      },
      networkConfiguration: {
        egressConfiguration: {
          egressType: "VPC",
          vpcConnectorArn: connector.attrVpcConnectorArn,
        },
      },
      healthCheckConfiguration: {
        protocol: "HTTP",
        path: "/health",
        interval: 10,
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      },
    });
    api.node.addDependency(image);

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: foundation.vpc,
      clusterName: "ai-travel-agent-cluster",
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });
    const task = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      family: "ai-travel-agent-worker",
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    grantRuntimeSecrets(foundation, task.taskRole);
    foundation.nationalityKey.grantEncryptDecrypt(task.taskRole);

    const workerLogGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: "/ai-travel-agent/worker",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    task.addContainer("agent-worker", {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      command: ["node", "dist/workers/worker-main.js"],
      environment: Object.fromEntries(
        runtimeEnvironment(foundation, "ai-travel-agent-worker").map(item => [item.name, item.value]),
      ),
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(foundation.databasePassword),
        MODEL_GATEWAY_API_KEY: ecs.Secret.fromSecretsManager(foundation.modelGatewayApiKey),
        SANDBOX_HMAC_SECRET: ecs.Secret.fromSecretsManager(foundation.sandboxHmacSecret),
        INVITATION_EMAIL_HMAC_SECRET: ecs.Secret.fromSecretsManager(foundation.invitationHmacSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "worker", logGroup: workerLogGroup }),
      healthCheck: {
        command: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:9464/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const worker = new ecs.FargateService(this, "WorkerService", {
      cluster,
      serviceName: "agent-worker",
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [workerSecurityGroup],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });
    cdk.Tags.of(this).add("project", "ai-travel-agent");
    cdk.Tags.of(this).add("environment", "hackathon");
    cdk.Tags.of(this).add("cost-owner", "ignite-2026-team");

    new cdk.CfnOutput(this, "ApiUrl", { value: `https://${api.attrServiceUrl}` });
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "WorkerServiceName", { value: worker.serviceName });
    new cdk.CfnOutput(this, "WorkerTaskDefinitionArn", { value: task.taskDefinitionArn });
    new cdk.CfnOutput(this, "RuntimeSubnetIds", {
      value: foundation.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(","),
    });
    new cdk.CfnOutput(this, "WorkerSecurityGroupId", { value: workerSecurityGroup.securityGroupId });
  }
}

function runtimeEnvironment(foundation: FoundationStack, serviceName: string) {
  return [
    { name: "AWS_REGION", value: foundation.region },
    { name: "NODE_ENV", value: "production" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "PORT", value: "3000" },
    { name: "AUTH_MODE", value: "cognito" },
    { name: "COGNITO_USER_POOL_ID", value: foundation.userPool.userPoolId },
    { name: "COGNITO_CLIENT_ID", value: foundation.userPoolClient.userPoolClientId },
    { name: "DB_HOST", value: foundation.database.dbInstanceEndpointAddress },
    { name: "DB_PORT", value: foundation.database.dbInstanceEndpointPort },
    { name: "DB_USER", value: "travelagent" },
    { name: "DB_NAME", value: "travelagent" },
    { name: "DB_SSL_MODE", value: "require" },
    { name: "MODEL_GATEWAY_PROVIDER", value: "gemini" },
    { name: "MODEL_GATEWAY_MODEL", value: "gemini-3.1-flash-lite" },
    { name: "MODEL_GATEWAY_PROMPT_VERSION", value: "1.1.0" },
    { name: "MODEL_GATEWAY_TOOL_CALLING_ENABLED", value: "false" },
    { name: "LOCATION_REFERENCE_MODE", value: serviceName.endsWith("worker") ? "disabled" : "in-process" },
    { name: "NUITEE_NATIONALITY_CIPHER_MODE", value: "kms" },
    { name: "NUITEE_NATIONALITY_KMS_KEY_ID", value: foundation.nationalityKey.keyArn },
    { name: "PASSWORD_RESET_MODE", value: "direct" },
    { name: "PLAN_ENABLE_HOTEL", value: "false" },
    { name: "PLAN_ENABLE_PLACES", value: "false" },
    { name: "PLAN_ENABLE_NAVIGATION", value: "false" },
    { name: "PLAN_ENABLE_ACCOMMODATION_DISCOVERY", value: "false" },
    { name: "PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED", value: "false" },
    { name: "OFFER_CUE_ENABLED", value: "false" },
    { name: "OTEL_SDK_DISABLED", value: "true" },
    { name: "OTEL_TRACES_EXPORTER", value: "none" },
    { name: "OTEL_SERVICE_NAME", value: serviceName },
    { name: "LOG_LEVEL", value: "info" },
    { name: "LOG_FORMAT", value: "json" },
    { name: "WORKER_METRICS_HOST", value: "0.0.0.0" },
    { name: "WORKER_METRICS_PORT", value: "9464" },
  ];
}

function runtimeSecrets(foundation: FoundationStack) {
  return [
    { name: "DB_PASSWORD", value: foundation.databasePassword.secretArn },
    { name: "MODEL_GATEWAY_API_KEY", value: foundation.modelGatewayApiKey.secretArn },
    { name: "SANDBOX_HMAC_SECRET", value: foundation.sandboxHmacSecret.secretArn },
    { name: "INVITATION_EMAIL_HMAC_SECRET", value: foundation.invitationHmacSecret.secretArn },
  ];
}

function grantRuntimeSecrets(foundation: FoundationStack, grantee: iam.IGrantable) {
  foundation.databasePassword.grantRead(grantee);
  foundation.modelGatewayApiKey.grantRead(grantee);
  foundation.sandboxHmacSecret.grantRead(grantee);
  foundation.invitationHmacSecret.grantRead(grantee);
}
