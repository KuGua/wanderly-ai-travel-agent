#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { FoundationStack } from "../lib/foundation-stack.js";
import { RuntimeStack } from "../lib/runtime-stack.js";

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const foundation = new FoundationStack(app, "AiTravelFoundation", { env });
new RuntimeStack(app, "AiTravelRuntime", {
  env,
  foundation,
});
