import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256 } from '../../scripts/lib/json-contract.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from '../../scripts/lib/tester-allowlist.mjs';
import { validateOperationInputs } from '../../scripts/runtime-operation.mjs';
import { runtimeStack } from '../../scripts/lib/one-writer.mjs';

const selector = { image: { service_sha: '1'.repeat(40), digest: `sha256:${'2'.repeat(64)}` } };
const testers = ['existing@example.com'];
function ioFixture({ runtimeStatus = 'UPDATE_COMPLETE', digest = selector.image.digest,
  initialTesters = testers, statusOverride } = {}) {
  const calls = [];
  let current = [...initialTesters];
  // Issue #166: the Base stack publishes the public API URL; the Runtime stack
  // exists while Beta runs and reports the pinned revision.
  const platform = { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE',
    Outputs: Object.entries({ EcsClusterName: 'beta-anywear', ApiBaseUrl: 'https://example.cloudfront.net' })
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const runtime = runtimeStatus === null ? undefined : { StackName: runtimeStack, StackStatus: runtimeStatus,
    Parameters: Object.entries({ ServiceImageDigest: digest, ServiceCommitSha: selector.image.service_sha,
      VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:test', CloudFrontPrefixListId: 'pl-test' })
      .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    Outputs: Object.entries({ ApiBaseUrl: 'https://example.cloudfront.net' })
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const stacks = new Map([['AnyWearPlatformStack-beta', platform], [runtimeStack, runtime]]);
  return { calls, async aws(args) {
    if (args[0] === 'cloudformation') {
      const name = args.at(-1);
      const stack = stacks.get(name);
      if (!stack) {
        const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${name} does not exist`;
        throw Object.assign(new Error(stderr), { stderr });
      }
      return { Stacks: [stack] };
    }
    if (args[0] === 'ssm') {
      const name = args.at(-1);
      assert.equal(name, '/anywear/beta/tester_allowlist', 'the tester surface reads only the allowlist');
      return { Parameter: { Name: name, Value: canonicalJson(current) } };
    }
    return {};
  }, async verifyHealth() { calls.push(['health']); }, async oneShot(role, revision, action, payload) {
    calls.push([role, revision, action, payload]);
    // `set-testers` replaces the exact list and reads no admission state.
    if (action === 'set-testers') current = JSON.parse(payload);
    if (action === 'status') {
      const line = { action: 'status', tester_count: current.length,
        tester_allowlist_hash: sha256(canonicalJson(current)) };
      return statusOverride ? statusOverride(line, current) : line;
    }
  } };
}
// The run's evidence is its printed line, not a record. Capture stdout for the
// duration of one driver call so a test can assert exactly what an operator sees.
async function captureStdout(run) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { value: await run(), lines }; }
  finally { process.stdout.write = original; }
}
test('Infra tester add merges exact emails on the revision the Runtime stack reports; a non-running Runtime performs no task', async () => {
  const io = ioFixture();
  await runTesterAllowlist('add', '[" NEW@example.com ", "new@example.com"]', io);
  const lifecycle = io.calls.find(call => call[0] === 'lifecycle' && call[2] === 'set-testers');
  assert.equal(lifecycle[2], 'set-testers');
  assert.equal(lifecycle[3], '["existing@example.com","new@example.com"]');
  for (const options of [{ runtimeStatus: null }, { runtimeStatus: 'UPDATE_IN_PROGRESS' }]) {
    const blocked = ioFixture(options);
    await assert.rejects(runTesterAllowlist('set', '[]', blocked));
    assert.ok(!blocked.calls.some(call => call[0] === 'lifecycle' || call[0] === 'health'), JSON.stringify(options));
  }
  await assert.rejects(runTesterAllowlist('cleanup', '[]', io));
  for (const input of ['["*@example.com"]', '["@example.com"]', JSON.stringify(Array(51).fill('a@example.com'))]) assert.throws(() => normalizeTesterEmails(input));
});
test('a tester write proves the persisted list from the status line and one SSM read-back', async () => {
  const io = ioFixture();
  const { lines } = await captureStdout(() => runTesterAllowlist('add', '["new@example.com"]', io));
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.operation, 'add-testers');
  assert.equal(line.tester_count, 2);
  assert.equal(line.tester_allowlist_hash, sha256(canonicalJson(['existing@example.com', 'new@example.com'])));
  assert.equal(line.matches, true);
  // The write is one one-shot plus its status read-back; no mode is read or written.
  assert.deepEqual(io.calls.filter(call => call[0] === 'lifecycle').map(call => call[2]).sort(),
    ['set-testers', 'status']);
  assert.equal(/@example\.com/.test(lines[0]), false, 'the printed line never carries tester addresses');
});
test('a write whose status line disagrees with the SSM read-back fails closed', async () => {
  const io = ioFixture({ statusOverride: line => ({ ...line, tester_count: 1 }) });
  await assert.rejects(runTesterAllowlist('add', '["new@example.com"]', io),
    /tester count\/hash differs from the SSM allowlist/);
  const wrongHash = ioFixture({ statusOverride: line => ({ ...line, tester_allowlist_hash: 'b'.repeat(64) }) });
  await assert.rejects(runTesterAllowlist('add', '["new@example.com"]', wrongHash),
    /tester count\/hash differs from the SSM allowlist/);
});
test('admission status reports the count and hash the SSM allowlist actually holds', async () => {
  const io = ioFixture({ initialTesters: ['a@example.com', 'b@example.com'] });
  const { lines } = await captureStdout(() => runTesterAllowlist('status', '[]', io));
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(event).sort(), ['matches', 'operation', 'tester_allowlist_hash', 'tester_count']);
  assert.equal(event.operation, 'admission-status');
  assert.equal(event.tester_count, 2);
  assert.equal(event.tester_allowlist_hash, sha256(canonicalJson(['a@example.com', 'b@example.com'])));
  assert.equal(event.matches, true);
  assert.equal(/@example\.com/.test(lines[0]), false, 'the status line never carries tester addresses');
  // A status read mutates nothing.
  assert.deepEqual(io.calls.filter(call => call[0] === 'lifecycle').map(call => call[2]), ['status']);
});
test('a status line that is not the #213 contract fails closed', async () => {
  for (const override of [
    line => ({ action: 'status', tester_count: line.tester_count }),
    line => ({ action: 'status', tester_allowlist_hash: line.tester_allowlist_hash }),
    line => ({ action: 'set-testers', tester_count: line.tester_count, tester_allowlist_hash: line.tester_allowlist_hash }),
  ]) {
    const io = ioFixture({ statusOverride: override });
    await assert.rejects(runTesterAllowlist('status', '[]', io));
  }
});
test('tester operation validates protected executor and explicit normalized payload before credentials', () => {
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: '4'.repeat(40),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true', INFRA_OPERATION: 'add-testers',
    INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '["test@example.com"]' };
  validateOperationInputs(env);
  validateOperationInputs({ ...env, TESTER_EMAILS: '[" OTHER@example.com "]', INFRA_OPERATION: 'set-testers' });
  for (const change of [{ TESTER_EMAILS: '["*@example.com"]' }, { INFRA_OPERATION: 'tester-cleanup' }, { GITHUB_SHA: 'short' },
    { INFRA_OPERATION: 'admission-status' }, { GITHUB_EVENT_NAME: 'push' }]) assert.throws(() => validateOperationInputs({ ...env, ...change }));
  validateOperationInputs({ ...env, INFRA_OPERATION: 'admission-status', TESTER_EMAILS: '[]' });
});
