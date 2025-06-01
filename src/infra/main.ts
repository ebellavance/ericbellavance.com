import { App } from "aws-cdk-lib";
import { getStageFromShortName } from "./constants";
import { WebsiteStack } from "./stacks/WebsiteStack";

const app = new App();

const stageShortName = app.node.tryGetContext("stage");

if (!stageShortName) {
  throw new Error("Error, you have to add context: stage");
}

const stage = getStageFromShortName(stageShortName);

if (!stage) {
  throw new Error("Error, invalid context variable: stage");
}

const env = {
  account: stage.ACCOUNT_NUMBER,
  region: stage.PRIMARY_REGION,
};

new WebsiteStack(app, 'WebsiteStack', {
  env,
  stage,
});
