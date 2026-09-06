import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export class FoundationStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly database: rds.DatabaseInstance;
  readonly databasePassword: secretsmanager.Secret;
  readonly modelGatewayApiKey: secretsmanager.Secret;
  readonly sandboxHmacSecret: secretsmanager.Secret;
  readonly invitationHmacSecret: secretsmanager.Secret;
  readonly nationalityKey: kms.Key;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "runtime", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.databasePassword = generatedSecret(this, "DatabasePassword", "ai-travel-agent/database-password", 32);
    this.modelGatewayApiKey = generatedSecret(this, "ModelGatewayApiKey", "ai-travel-agent/model-gateway-api-key", 40);
    this.sandboxHmacSecret = generatedSecret(this, "SandboxHmacSecret", "ai-travel-agent/sandbox-hmac-secret", 48);
    this.invitationHmacSecret = generatedSecret(this, "InvitationHmacSecret", "ai-travel-agent/invitation-hmac-secret", 48);

    this.database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromPassword("travelagent", this.databasePassword.secretValue),
      databaseName: "travelagent",
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      deletionProtection: false,
      backupRetention: cdk.Duration.days(1),
      deleteAutomatedBackups: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });
    this.database.connections.allowDefaultPortFrom(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      "PostgreSQL from private application subnets",
    );

    this.nationalityKey = new kms.Key(this, "NationalityKey", {
      alias: "alias/ai-travel-agent-nationality",
      description: "Encrypts provider-only quote nationality values",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "ai-travel-agent-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 10,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.userPoolClient = this.userPool.addClient("WebClient", {
      userPoolClientName: "ai-travel-agent-web",
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      refreshTokenValidity: cdk.Duration.days(30),
    });

    cdk.Tags.of(this).add("project", "ai-travel-agent");
    cdk.Tags.of(this).add("environment", "hackathon");
    cdk.Tags.of(this).add("cost-owner", "ignite-2026-team");

    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "DatabaseEndpoint", { value: this.database.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, "ModelSecretName", { value: this.modelGatewayApiKey.secretName });
  }
}

function generatedSecret(
  scope: Construct,
  id: string,
  secretName: string,
  passwordLength: number,
): secretsmanager.Secret {
  return new secretsmanager.Secret(scope, id, {
    secretName,
    generateSecretString: {
      passwordLength,
      excludePunctuation: true,
      includeSpace: false,
    },
  });
}
