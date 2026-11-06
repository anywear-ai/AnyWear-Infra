import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_CONTRACT_PARAMETERS, STAGE_CONTRACT_CONDITIONAL_PARAMETERS, STAGE_CONTRACT_READ_PARAMETERS,
  STAGE_CONTRACT_READ_BATCHES, readStageInputs } from '../../scripts/lib/stage-contract-parameters.mjs';
import { stageContractSchemaHash, validateStageInputs } from '../../lib/contracts.mjs';
import { verifyLifecyclePreview, verifyProtectedImages, verifyRetentionPolicy } from '../../scripts/ecr-retention.mjs';

test('the stage-contract name list is the 35 unconditional Beta parameters plus one phase-dependent name', () => {
  assert.equal(STAGE_CONTRACT_PARAMETERS.length, 35);
  assert.deepEqual([...STAGE_CONTRACT_PARAMETERS], [...STAGE_CONTRACT_PARAMETERS].sort());
  assert.deepEqual([...STAGE_CONTRACT_CONDITIONAL_PARAMETERS], ['/anywear/beta/cleanup_task_role_arn']);
  assert.equal(STAGE_CONTRACT_READ_PARAMETERS.length, 36);
  assert.deepEqual([...STAGE_CONTRACT_READ_PARAMETERS], [...STAGE_CONTRACT_READ_PARAMETERS].sort());
  assert.ok(STAGE_CONTRACT_PARAMETERS.every(name => /^\/anywear\/beta\/[a-z0-9_]+$/.test(name)));
  assert.ok(STAGE_CONTRACT_PARAMETERS.every(name => !STAGE_CONTRACT_CONDITIONAL_PARAMETERS.includes(name)));
  assert.deepEqual(validateStageInputs([]), []);
  assert.equal(stageContractSchemaHash([]), stageContractSchemaHash([]));
});

test('readStageInputs records every unconditional parameter and admits only the phase-dependent absence', async () => {
  const calls = [];
  const io = ({ invalid = [], omit = [], replacements = {} } = {}) => ({ async aws(args, region) {
    assert.deepEqual(args.slice(0, 2), ['ssm', 'get-parameters']);
    assert.equal(region, 'ap-east-1');
    const names = args.slice(3);
    assert.ok(names.length <= 10, 'ssm get-parameters accepts at most ten names per call');
    calls.push(names);
    const returned = names.filter(name => !invalid.includes(name) && !omit.includes(name))
      .map(name => replacements[name] ?? name);
    return { Parameters: returned.map(name => ({ Name: name, Type: 'String',
        Value: `value-${STAGE_CONTRACT_READ_PARAMETERS.indexOf(name)}`, Version: STAGE_CONTRACT_READ_PARAMETERS.indexOf(name) + 1 })),
      InvalidParameters: invalid.filter(name => names.includes(name)) };
  } });
  const rows = await readStageInputs(io());
  assert.deepEqual(calls, [...STAGE_CONTRACT_READ_BATCHES]);
  assert.equal(rows.length, 36);
  assert.deepEqual(rows.map(row => row.parameter), [...STAGE_CONTRACT_READ_PARAMETERS]);
  assert.deepEqual(rows.map(row => row.version), STAGE_CONTRACT_READ_PARAMETERS.map((_, index) => String(index + 1)));
  // A legacy deploy publishes no cleanup role, so its parameter is legitimately invalid.
  calls.length = 0;
  const legacyRows = await readStageInputs(io({ invalid: [...STAGE_CONTRACT_CONDITIONAL_PARAMETERS] }));
  assert.deepEqual(calls, [...STAGE_CONTRACT_READ_BATCHES]);
  assert.equal(legacyRows.length, 35);
  assert.deepEqual(legacyRows.map(row => row.parameter), [...STAGE_CONTRACT_PARAMETERS]);
  // Any unconditional absence, an unexpected name or a duplicate still fails.
  await assert.rejects(readStageInputs(io({ invalid: [STAGE_CONTRACT_PARAMETERS[0]] })), /unavailable/);
  await assert.rejects(readStageInputs(io({ omit: [STAGE_CONTRACT_PARAMETERS[0]] })), /unavailable/);
  await assert.rejects(readStageInputs({ async aws() { return { Parameters: [], InvalidParameters: [] }; } }), /unavailable/);
  await assert.rejects(readStageInputs(io({ replacements: {
    [STAGE_CONTRACT_PARAMETERS[0]]: '/anywear/beta/not_in_contract' } })), /unexpected/);
  await assert.rejects(readStageInputs(io({ invalid: STAGE_CONTRACT_READ_PARAMETERS.slice(1) })), /unavailable/);
});

test('readStageInputs admits only the reviewed pre-M4 unpublished parameter and hashes the published subset', async () => {
  const apiBaseUrl = '/anywear/beta/api_base_url';
  const makeIo = ({ invalid = [] } = {}) => ({ async aws(args, region) {
    assert.deepEqual(args.slice(0, 2), ['ssm', 'get-parameters']);
    assert.equal(region, 'ap-east-1');
    const names = args.slice(3);
    const returned = names.filter(name => !invalid.includes(name));
    return { Parameters: returned.map(name => ({ Name: name, Type: 'String',
        Value: `value-${STAGE_CONTRACT_READ_PARAMETERS.indexOf(name)}`, Version: STAGE_CONTRACT_READ_PARAMETERS.indexOf(name) + 1 })),
      InvalidParameters: invalid.filter(name => names.includes(name)) };
  } });

  const subset = await readStageInputs(makeIo({ invalid: [apiBaseUrl] }), { allowUnpublished: ['api_base_url'] });
  assert.equal(subset.length, 35);
  assert.ok(!subset.some(row => row.parameter === apiBaseUrl));
  assert.deepEqual(subset.map(row => row.parameter),
    [...STAGE_CONTRACT_READ_PARAMETERS].filter(name => name !== apiBaseUrl));
  assert.equal(stageContractSchemaHash(subset), stageContractSchemaHash(subset));
  // The full name form is accepted equivalently.
  assert.deepEqual(await readStageInputs(makeIo({ invalid: [apiBaseUrl] }), { allowUnpublished: [apiBaseUrl] }), subset);
  // A published api_base_url is included normally.
  const full = await readStageInputs(makeIo(), { allowUnpublished: ['api_base_url'] });
  assert.equal(full.length, 36);
  assert.ok(full.some(row => row.parameter === apiBaseUrl));
  assert.notEqual(stageContractSchemaHash(subset), stageContractSchemaHash(full));
  // Without the allow list the same absence still fails.
  await assert.rejects(readStageInputs(makeIo({ invalid: [apiBaseUrl] })), /unavailable/);
  // Another unconditional absence still fails even with the allow list.
  await assert.rejects(readStageInputs(makeIo({ invalid: [apiBaseUrl, STAGE_CONTRACT_PARAMETERS[0]] }),
    { allowUnpublished: ['api_base_url'] }), /unavailable/);
  // The phase-dependent cleanup absence still works with the allow list.
  const legacy = await readStageInputs(makeIo({ invalid: [...STAGE_CONTRACT_CONDITIONAL_PARAMETERS, apiBaseUrl] }),
    { allowUnpublished: ['api_base_url'] });
  assert.equal(legacy.length, 34);
  assert.ok(!legacy.some(row => row.parameter === apiBaseUrl));
  // Unknown or conditional allow entries are refused, as are duplicates and a
  // non-array allow list.
  for (const entry of ['not_a_param', '/anywear/beta/not_a_param', STAGE_CONTRACT_CONDITIONAL_PARAMETERS[0], '']) {
    await assert.rejects(readStageInputs(makeIo(), { allowUnpublished: [entry] }), /Unknown unpublished|Invalid unpublished/);
  }
  await assert.rejects(readStageInputs(makeIo(), { allowUnpublished: ['api_base_url', '/anywear/beta/api_base_url'] }),
    /Duplicate unpublished/);
  await assert.rejects(readStageInputs(makeIo(), { allowUnpublished: 'api_base_url' }), /Invalid unpublished/);
});

test('the retention validators keep the reviewed Beta policy bounds', () => {
  const policy = { rules: [
    { rulePriority: 1, selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'], countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
    { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] };
  const hash = verifyRetentionPolicy(policy);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyRetentionPolicy({ rules: [policy.rules[0]] }), /two priority-ordered/);
  assert.throws(() => verifyRetentionPolicy({ rules: [{ ...policy.rules[0], selection: { ...policy.rules[0].selection, countNumber: 10 } }, policy.rules[1]] }), /not the reviewed Beta policy/);
  const images = [{ imageDigest: `sha256:${'1'.repeat(64)}`, imageTags: ['protected-service-' + 'a'.repeat(40)] },
    { imageDigest: `sha256:${'2'.repeat(64)}`, imageTags: ['protected-service-' + 'b'.repeat(40)] }];
  assert.equal(verifyProtectedImages(images, [{ service_sha: 'a'.repeat(40), digest: `sha256:${'1'.repeat(64)}` }]), 2);
  assert.throws(() => verifyProtectedImages(images, [{ service_sha: 'c'.repeat(40), digest: `sha256:${'1'.repeat(64)}` }]), /lacks exact protected tag/);
  assert.equal(verifyLifecyclePreview({ status: 'COMPLETE', previewResults: [{ imageDigest: `sha256:${'2'.repeat(64)}`, action: { type: 'EXPIRE' } }] },
    [{ digest: `sha256:${'1'.repeat(64)}` }]), true);
  assert.throws(() => verifyLifecyclePreview({ status: 'COMPLETE', previewResults: [{ imageDigest: `sha256:${'1'.repeat(64)}`, action: { type: 'EXPIRE' } }] },
    [{ digest: `sha256:${'1'.repeat(64)}` }]), /would expire/);
});
