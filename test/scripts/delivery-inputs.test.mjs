import test from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_TRIGGERS, DELIVERY_TRIGGER_OPERATIONS, dispatchingRunUrl, validateClientInputs,
  validateDeliveryInput } from '../../scripts/lib/delivery-inputs.mjs';
import { validateOperationInputs } from '../../scripts/runtime-operation.mjs';
import { RELEASE_IDENTITY_OPERATIONS } from '../../scripts/lib/release-inputs.mjs';

// #226/#344: the deploy chain's and the Client publication chain's context is
// accepted only by the two operations that carry it. These cases drive the
// credential-free validators, so every refusal is proven to happen before any job
// holds a token, an environment or an OIDC identity.
const serviceCommit = 'b'.repeat(40);
const clientRunId = '40123456789';
const clientBundleDigest = 'd'.repeat(64);
const dispatchedBy = 'https://github.com/git-malu/AnyWear-Service/actions/runs/40123456789';
const clientDispatchedBy = 'https://github.com/git-malu/AnyWear-Client/actions/runs/40123456790';
const mutateOperations = Object.freeze(['deploy-foundation', 'deploy-billing', 'deploy-platform',
  'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
  'admission-status', 'add-testers', 'set-testers', 'rearm-object-deletion', 'publish-client']);
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit,
  TESTER_EMAILS: '[]', DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: '',
  CLIENT_RUN_ID: '', CLIENT_RUN_ATTEMPT: '', CLIENT_BUNDLE_DIGEST: '', ...overrides,
});
const operationEnv = (operation, overrides = {}) => {
  const release = RELEASE_IDENTITY_OPERATIONS.includes(operation);
  return env({
    INFRA_OPERATION: operation,
    INFRA_IDENTITY_PHASE: ['deploy-runtime', 'stop-runtime'].includes(operation) ? 'roles-added' : 'retired',
    SERVICE_ARTIFACT_TAG: release ? `service-artifacts-${serviceCommit}` : '',
    SERVICE_COMMIT: release ? serviceCommit : '',
    // The re-arm operation requires its own composed input pair; without it the
    // full preflight refuses before this file's subject. It belongs to no other
    // assertion here.
    ...(operation === 'rearm-object-deletion' ? {
      OBJECT_DELETION_MANIFEST_ID: '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
      OBJECT_DELETION_EXPECTED_GENERATION: '7' } : {}),
    ...overrides,
  });
};
// A publication dispatch as the Client handoff sends it: `publish`, the Client run
// URL, and the three publication inputs.
const clientEnv = (overrides = {}) => operationEnv('publish-client', {
  DELIVERY_TRIGGER: 'publish', DISPATCHED_BY: clientDispatchedBy,
  CLIENT_RUN_ID: clientRunId, CLIENT_RUN_ATTEMPT: '2', CLIENT_BUNDLE_DIGEST: clientBundleDigest, ...overrides });

test('delivery-runtime accepts deploy with a run URL and manual without one', () => {
  // `publish` is the Client chain's event and joins the closed enum; `release` stays
  // representable and refused everywhere.
  assert.deepEqual(DELIVERY_TRIGGERS, ['deploy', 'release', 'manual', 'publish']);
  assert.deepEqual(DELIVERY_TRIGGER_OPERATIONS, ['deploy-runtime', 'publish-client']);
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

// #344: the Client publication accepts the Client chain's `publish` and a manual
// dispatch, and nothing else. `deploy` belongs to the Runtime deployment, and the
// two events are not interchangeable even though both name an upstream run URL.
test('publish-client accepts publish with a run URL and manual without one', () => {
  assert.doesNotThrow(() => validateOperationInputs(clientEnv()));
  assert.deepEqual(validateDeliveryInput(clientEnv()),
    { delivery_trigger: 'publish', dispatched_by: clientDispatchedBy });
  assert.doesNotThrow(() => validateOperationInputs(operationEnv('publish-client', {
    CLIENT_RUN_ID: clientRunId, CLIENT_RUN_ATTEMPT: '2', CLIENT_BUNDLE_DIGEST: clientBundleDigest })));
  for (const trigger of ['deploy', 'release']) {
    assert.throws(() => validateDeliveryInput(clientEnv({ DELIVERY_TRIGGER: trigger })),
      trigger === 'release' ? /delivery_trigger=release is refused/ : /refuses delivery_trigger=deploy/, trigger);
  }
  assert.throws(() => validateDeliveryInput(clientEnv({ DISPATCHED_BY: '' })),
    /delivery_trigger=publish requires the dispatching run URL as dispatched_by/);
  assert.throws(() => validateDeliveryInput(clientEnv({ DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: clientDispatchedBy })),
    /delivery_trigger=manual accepts no dispatched_by/);
  // The Runtime operation refuses the Client chain's event symmetrically.
  assert.throws(() => validateDeliveryInput(env({ DELIVERY_TRIGGER: 'publish', DISPATCHED_BY: clientDispatchedBy })),
    /refuses delivery_trigger=publish/);
});

// #344: the Client publication identity. All three values are required for the one
// operation that publishes and refused on every other operation, so a publication
// identity cannot ride a deployment.
test('the Client publication identity is required by publish-client and refused elsewhere', () => {
  assert.deepEqual(validateClientInputs(clientEnv()), {
    client_run_id: Number(clientRunId), client_run_attempt: 2, client_bundle_digest: clientBundleDigest });
  for (const [name, values] of Object.entries({
    CLIENT_RUN_ID: ['', '0', '00', '-1', 'run-1', ' 4', '1.5'],
    CLIENT_RUN_ATTEMPT: ['', '0', '00', '-2', 'attempt'],
    CLIENT_BUNDLE_DIGEST: ['', 'D'.repeat(64), 'd'.repeat(63), 'd'.repeat(65), `sha256:${'d'.repeat(64)}`, `${'d'.repeat(64)} `],
  })) {
    for (const value of values) {
      assert.throws(() => validateClientInputs(clientEnv({ [name]: value })),
        /requires a positive-integer|client_bundle_digest/, `${name}=${JSON.stringify(value)}`);
    }
  }
  // The order is the workflow's, and the refusal names the missing input.
  assert.throws(() => validateClientInputs(clientEnv({ CLIENT_RUN_ID: '' })), /positive-integer client_run_id/);
  assert.throws(() => validateClientInputs(clientEnv({ CLIENT_RUN_ATTEMPT: '' })), /positive-integer client_run_attempt/);
  assert.throws(() => validateClientInputs(clientEnv({ CLIENT_BUNDLE_DIGEST: '' })), /client_bundle_digest/);
  // Every other operation refuses a supplied value, in the credential-free preflight.
  for (const operation of mutateOperations.filter(candidate => candidate !== 'publish-client')) {
    assert.doesNotThrow(() => validateOperationInputs(operationEnv(operation)), operation);
    for (const overrides of [{ CLIENT_RUN_ID: clientRunId }, { CLIENT_RUN_ATTEMPT: '2' },
      { CLIENT_BUNDLE_DIGEST: clientBundleDigest }]) {
      assert.throws(() => validateOperationInputs(operationEnv(operation, overrides)),
        /accepts no client_run_id, client_run_attempt or client_bundle_digest/, `${operation} ${JSON.stringify(overrides)}`);
    }
  }
});

test('the other twelve operations refuse a delivery trigger and a dispatching run', () => {
  const others = mutateOperations.filter(operation => !DELIVERY_TRIGGER_OPERATIONS.includes(operation));
  assert.equal(others.length, 12);
  for (const operation of others) {
    // A manual dispatch of that operation sends the workflow defaults, which are
    // inert here: the operation takes no entry event and no dispatching run.
    assert.doesNotThrow(() => validateOperationInputs(operationEnv(operation)), operation);
    for (const trigger of ['deploy', 'release', 'publish']) {
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
