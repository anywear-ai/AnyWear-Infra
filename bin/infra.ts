#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BillingStack } from '../lib/billing-stack';
import { FoundationStack } from '../lib/foundation-stack';
import { DEFAULT_QWEATHER_API_HOST, PlatformStack } from '../lib/platform-stack';
import { EgressStack } from '../lib/egress-stack';
import { platformInputs } from '../lib/platform-inputs';
import { RuntimeStack } from '../lib/runtime-stack';
import { loadArtifactInputs } from '../lib/artifact-inputs';
import { readIdentityPhase } from '../lib/identity-phase';
import { readLegacyRoleSource } from '../lib/legacy-role-source';
import { runtimeStackName } from '../lib/contracts.mjs';

const app = new cdk.App();
// A stale old key must fail for every scope instead of taking today's default:
// appScope, betaActive, environmentRunning, retentionProtection and the retired
// Foundation `infraServices` service set would otherwise synthesize a silently
// different shape. Issue #166 removed the environmentRunning active/stopped
// switch entirely: Beta now stops by deleting the Egress and Runtime stacks, so
// accepting the key would hide a stale caller. Issue #195 retired the per-service
// deploy roles, so an old Foundation dispatch carrying `infraServices` must fail
// instead of synthesizing a different Foundation.
if (app.node.tryGetContext('appScope') !== undefined) throw new Error('appScope was renamed to deployScope');
if (app.node.tryGetContext('betaActive') !== undefined) throw new Error('betaActive was removed: Beta activity is the existence of the Runtime stack, not an output');
if (app.node.tryGetContext('environmentRunning') !== undefined) throw new Error('environmentRunning was removed: Beta stops by deleting the Egress and Runtime stacks');
if (app.node.tryGetContext('retentionProtection') !== undefined) throw new Error('retentionProtection was renamed to ecrImageRetention');
if (app.node.tryGetContext('infraServices') !== undefined) throw new Error('infraServices was removed: the Foundation service deploy roles retired with #195 and the Runtime stack is deployed by deploy-runtime');
const deployScope = app.node.tryGetContext('deployScope') || 'application';
if (!['application', 'foundation', 'billing', 'egress', 'runtime'].includes(deployScope)) throw new Error('Invalid deployScope');
const identityPhase = readIdentityPhase(app.node.tryGetContext('identityPhase'));
// Required even for Billing-only entry; source/simulation mode is never an
// implicit live fallback. Foundation validates the bound external account.
const legacyRoleSource = readLegacyRoleSource(app.node.tryGetContext('legacyRoleSource'));
if (legacyRoleSource === 'external' && process.env.CDK_DEFAULT_ACCOUNT !== '650880818323') {
  throw new Error('External legacy roles require the reviewed account 650880818323');
}
const ecrImageRetentionContext = app.node.tryGetContext('ecrImageRetention');
if (ecrImageRetentionContext !== undefined && !['true', 'false', true, false].includes(ecrImageRetentionContext)) {
  throw new Error('ecrImageRetention must be true or false');
}
const ecrImageRetention = ecrImageRetentionContext === true || ecrImageRetentionContext === 'true';

// The FoundationStack creates account-wide resources like the GitHub OIDC Provider.
// It should be deployed ONCE per AWS account, before any environment stacks.
const env = process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_REGION
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
  : undefined;
const billingEnv = process.env.CDK_DEFAULT_ACCOUNT
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.BILLING_REGION || 'us-east-1' }
  : { region: process.env.BILLING_REGION || 'us-east-1' };

// A Foundation synthesis exists for the account-wide deploy, the Base application
// and the Egress scope, which shares the reviewed dedicated roles. `billing` and
// `runtime` synthesize only their own stack so a deploy of one cannot drift into
// an account-wide shape.
if (!['billing', 'runtime'].includes(deployScope)) new FoundationStack(app, 'AnyWearFoundationStack', { env, identityPhase, legacyRoleSource });
if (deployScope === 'billing') new BillingStack(app, 'AnyWearBillingStack-beta', { stage: 'beta', env: billingEnv });

if (deployScope === 'application') {
const artifactDirectory = app.node.tryGetContext('artifactDirectory') || process.env.ANYWEAR_ARTIFACT_DIRECTORY;
if (typeof artifactDirectory !== 'string' || !artifactDirectory) throw new Error('artifactDirectory must identify locally verified immutable Service artifacts');
const artifactInputs = loadArtifactInputs(artifactDirectory);

const stage = app.node.tryGetContext('stage') || app.node.tryGetContext('env') || 'dev';
const qWeatherApiHost = app.node.tryGetContext('qweatherApiHost')
  || process.env.QWEATHER_API_HOST
  || DEFAULT_QWEATHER_API_HOST;
// The Base API CloudFront distribution's origin is the `ApiOriginDomainName`
// stack parameter (issue #254), not a synthesis input: its requirement moved from
// synthesis to deploy time, because the origin changes when the Runtime stack's
// load balancer is recreated. Only the Beta stage has such a distribution.
// Infra owns every stack of the account from this one application: the
// account-wide Foundation/Billing stacks, the stage base and, since #195, the
// release slice. This `application` branch synthesizes only the Base stack, so a
// Base deploy never touches the Runtime stack; `deployScope=runtime` (below)
// synthesizes `AnyWearRuntimeStack-<stage>` from the same app and `deploy-runtime`
// deploys it. Issue #166 split the stage base's disposable egress into
// `AnyWearEgressStack-beta` and moved the API CloudFront distribution into Base.
new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
  stage,
  artifactInputs,
  identityPhase,
  ecrImageRetention,
  qWeatherApiHost,
  env,
});

if (stage === 'beta') {
  new BillingStack(app, 'AnyWearBillingStack-beta', { stage, env: billingEnv });
}
}

// Issue #166 drill precondition: an Egress start may reuse the retained EIP
// allocation from the previous stop instead of creating a new one.
const natEipAllocationIdContext = app.node.tryGetContext('natEipAllocationId');
if (natEipAllocationIdContext !== undefined && typeof natEipAllocationIdContext !== 'string') {
  throw new Error('natEipAllocationId must be a string');
}
const natEipAllocationId = natEipAllocationIdContext || undefined;

// `egress` is the disposable network edge. It is a separate scope so
// `deploy-egress` / `delete-egress` synthesize only this stack and need no
// Service artifact directory; `cdk deploy/destroy --exclusively` then touches
// exactly this stack. Base publishes the VPC/subnet/route-table ids as
// CloudFormation exports (lib/base-exports.ts) and Egress imports them, so the
// two stacks share the Base-owned network without Egress re-creating route
// tables or a second association. Synthesis performs no AWS call.
if (deployScope === 'egress') {
  new EgressStack(app, 'AnyWearEgressStack-beta', { env, natEipAllocationId });
}

// `runtime` is the release slice (#195). It is a separate scope because the
// Runtime stack consumes no Service-built Lambda or Docker asset: `application`
// synthesizes the Base stack and needs an artifact directory this stack does not
// use. The standard CDK bootstrap synthesizer is the reviewed deployment path
// (`beta-infra-deploy-role` already assumes the `cdk-hnb659fds-*` roles); the
// template bytes are unchanged by the move, which the matrix identity proof
// pins. The stage is explicit: a Runtime deploy names the stack it changes.
if (deployScope === 'runtime') {
  const runtimeStage = app.node.tryGetContext('stage') ?? app.node.tryGetContext('env');
  if (runtimeStage !== 'beta' && runtimeStage !== 'prod') {
    throw new Error("The runtime deployScope requires an explicit stage of 'beta' or 'prod'");
  }
  if (env?.account !== '650880818323' || env?.region !== 'ap-east-1') {
    throw new Error(`The Runtime stack deploys only to 650880818323/ap-east-1 (got ${env?.account}/${env?.region})`);
  }
  new RuntimeStack(app, runtimeStackName(runtimeStage), {
    stage: runtimeStage,
    env,
    platform: (stack) => platformInputs(stack, { stage: runtimeStage, identityPhase }),
  });
}
