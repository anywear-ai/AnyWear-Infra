import test from 'node:test';
import assert from 'node:assert/strict';
import * as deployment from '../../scripts/lib/deployment-contract.mjs';

// Issue #207 shrank this module to the constants the operation controls import.
// The record and observation validators it used to re-export are retired; the
// contract's own surface test asserts they are gone from `lib/contracts.mjs`, and
// this test asserts they are gone from this module too.
const REMOVED = Object.freeze([
  'DEPLOYMENT_RECORD_MEMBERS', 'DEPLOYMENT_PRODUCER_FIELDS', 'DEPLOYMENT_STACK_FIELDS',
  'DEPLOYMENT_INPUT_FIELDS', 'SERVICE_OBSERVED_FIELDS', 'SERVICE_ECS_IDENTITY_FIELDS',
  'SERVICE_DEPLOYMENT_RECORD_MEMBERS', 'SERVICE_DEPLOYMENT_RECORD_SCHEMA',
  'validateServiceDeploymentRecord', 'validateServiceStacks', 'validateDeploymentRecord',
  'validateInfraDeploymentRecord', 'validateObservationRecord', 'validateSnapshot',
  'validateDeploymentGate', 'validateSchemaBoundary', 'schemaBoundaryPrefixHash',
  'stableLambdaConfiguration', 'assertObservedMatchesDeployment',
]);

test('the deployment contract keeps the reviewed account, region and repository identities', () => {
  assert.equal(deployment.account, '650880818323');
  assert.equal(deployment.region, 'ap-east-1');
  assert.equal(deployment.INFRA_REPOSITORY, 'anywear-ai/AnyWear-Infra');
  assert.equal(deployment.SERVICE_REPOSITORY, 'anywear-ai/AnyWear-Service');
});

test('no retired record or observation validator remains on the module', () => {
  for (const name of REMOVED) {
    assert.equal(deployment[name], undefined, `${name} must not be exported by deployment-contract.mjs`);
  }
});
