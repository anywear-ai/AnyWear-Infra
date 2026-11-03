import test from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_TRIGGERS, dispatchingRunUrl, validateDeliveryInput } from './delivery-inputs.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { RELEASE_IDENTITY_OPERATIONS } from './release-inputs.mjs';

// #226: the deploy chain's context is accepted only by `deploy-runtime`. These
// cases drive the credential-free validators, so every refusal is proven to happen
// before any job holds a token, an environment or an OIDC identity.
const serviceCommit = 'b'.repeat(40);
const dispatchedBy = 'https://github.com/git-malu/AnyWear-Service/actions/runs/40123456789';
const mutateOperations = Object.freeze(['deploy-foundation', 'deploy-billing', 'deploy-platform',
  'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
  'admission-status', 'add-testers', 'set-testers']);
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit,
  TESTER_EMAILS: '[]', DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: '', ...overrides,
});
const operationEnv = (operation, overrides = {}) => {
  const release = RELEASE_IDENTITY_OPERATIONS.includes(operation);
  return env({
    INFRA_OPERATION: operation,
    INFRA_IDENTITY_PHASE: ['deploy-runtime', 'stop-runtime'].includes(operation) ? 'roles-added' : 'retired',
    SERVICE_ARTIFACT_TAG: release ? `service-artifacts-${serviceCommit}` : '',
    SERVICE_COMMIT: release ? serviceCommit : '',
    ...overrides,
  });
};

test('deploy-runtime accepts deploy with a run URL and manual without one', () => {
  assert.deepEqual(DELIVERY_TRIGGERS, ['deploy', 'release', 'manual']);
  assert.deepEqual(validateDeliveryInput(env({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })),
    { delivery_trigger: 'deploy', dispatched_by: dispatchedBy });
  assert.deepEqual(validateDeliveryInput(env()), { delivery_trigger: 'manual', dispatched_by: '' });
  // The full credential-free validation accepts both, and it is the same call the
  // preflight and the operation make.
  assert.doesNotThrow(() => validateOperationInputs(env({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })));
  assert.doesNotThrow(() => validateOperationInputs(env()));
});

test('deploy-runtime refuses release in the credential-free preflight', () => {
  // A tag-shaped dispatch reaches this workflow only by misuse; the refusal names
  // why before any credential or environment exists.
  assert.throws(() => validateOperationInputs(env({ DELIVERY_TRIGGER: 'release', DISPATCHED_BY: dispatchedBy })),
    /delivery_trigger=release is refused: the release chain never deploys/);
  assert.throws(() => validateDeliveryInput(env({ DELIVERY_TRIGGER: 'release', DISPATCHED_BY: dispatchedBy })),
    /delivery_trigger=release is refused/);
});

test('deploy-runtime requires a run URL for deploy and none for manual', () => {
  for (const bad of [undefined, '', 'http://github.com/git-malu/AnyWear-Service/actions/runs/1',
    'https://github.com/git-malu/AnyWear-Service', 'https://github.com/git-malu/AnyWear-Service/actions/runs/',
    'https://github.com/git-malu/AnyWear-Service/actions/runs/00', ` ${dispatchedBy}`, 'https://example.com/a/b/actions/runs/1']) {
    assert.throws(() => validateDeliveryInput(env({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: bad })),
      /delivery_trigger=deploy requires the dispatching run URL as dispatched_by/, String(bad));
  }
  assert.throws(() => validateDeliveryInput(env({ DISPATCHED_BY: dispatchedBy })),
    /delivery_trigger=manual accepts no dispatched_by/);
  assert.throws(() => validateDeliveryInput(env({ DELIVERY_TRIGGER: 'merge' })), /requires an explicit delivery trigger/);
  assert.throws(() => validateDeliveryInput(env({ DELIVERY_TRIGGER: '' })), /requires an explicit delivery trigger/);
});

test('the other eleven operations refuse a delivery trigger and a dispatching run', () => {
  const others = mutateOperations.filter(operation => operation !== 'deploy-runtime');
  assert.equal(others.length, 11);
  for (const operation of others) {
    // A manual dispatch of that operation sends the workflow defaults, which are
    // inert here: the operation takes no entry event and no dispatching run.
    assert.doesNotThrow(() => validateOperationInputs(operationEnv(operation)), operation);
    for (const trigger of ['deploy', 'release']) {
      assert.throws(() => validateOperationInputs(operationEnv(operation, { DELIVERY_TRIGGER: trigger })),
        /accepts no entry event/, `${operation} ${trigger}`);
    }
    assert.throws(() => validateOperationInputs(operationEnv(operation, { DISPATCHED_BY: dispatchedBy })),
      /accepts no dispatched_by/, operation);
  }
});

test('the dispatch key is the dispatching run URL', () => {
  assert.equal(dispatchingRunUrl(env()), 'https://github.com/git-malu/AnyWear-Infra/actions/runs/77');
  for (const bad of [{ GITHUB_REPOSITORY: undefined }, { GITHUB_REPOSITORY: 'git-malu' }, { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ID: 'run-7' }]) {
    assert.throws(() => dispatchingRunUrl(env(bad)), /dispatching/, JSON.stringify(bad));
  }
});
