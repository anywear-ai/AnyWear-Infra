import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOVERY_TARGETS, recoveryViolations } from '../../scripts/lib/recovery-contract.mjs';

const clusterId = 'AnyWearDatabase2CD487D8';
const writerId = 'AnyWearDatabasewriter936467CD';

function platformTemplate({ clusterDeletionPolicy = 'Delete', deletionProtection = false,
  retention, window, writerDeletionPolicy = clusterDeletionPolicy } = {}) {
  const properties = { Engine: 'aurora-postgresql', EngineVersion: '17.7', DeletionProtection: deletionProtection };
  if (retention !== undefined) properties.BackupRetentionPeriod = retention;
  if (window !== undefined) properties.PreferredBackupWindow = window;
  return { Resources: {
    [clusterId]: { Type: 'AWS::RDS::DBCluster', DeletionPolicy: clusterDeletionPolicy, Properties: properties },
    [writerId]: { Type: 'AWS::RDS::DBInstance', DeletionPolicy: writerDeletionPolicy,
      Properties: { DBClusterIdentifier: { Ref: clusterId }, DBInstanceClass: 'db.serverless' } },
  } };
}
const beta = (overrides = {}) => platformTemplate({ clusterDeletionPolicy: 'Retain', deletionProtection: true,
  retention: 7, window: '16:00-16:30', ...overrides });
const prod = (overrides = {}) => platformTemplate({ clusterDeletionPolicy: 'Retain', deletionProtection: true,
  retention: 35, window: '16:00-16:30', ...overrides });

test('recovery targets are frozen and use template deletion-policy terms', () => {
  assert.ok(Object.isFrozen(RECOVERY_TARGETS));
  assert.ok(Object.isFrozen(RECOVERY_TARGETS.beta));
  assert.ok(Object.isFrozen(RECOVERY_TARGETS.prod));
  assert.deepEqual(Object.keys(RECOVERY_TARGETS), ['beta', 'prod']);
  assert.deepEqual({ stage: RECOVERY_TARGETS.beta.stage, stackName: RECOVERY_TARGETS.beta.stackName,
    retention: RECOVERY_TARGETS.beta.pitrRetentionDays, window: RECOVERY_TARGETS.beta.preferredBackupWindow,
    protection: RECOVERY_TARGETS.beta.deletionProtection, removalPolicy: RECOVERY_TARGETS.beta.clusterRemovalPolicy,
    deletionPolicy: RECOVERY_TARGETS.beta.clusterDeletionPolicy },
  { stage: 'beta', stackName: 'AnyWearPlatformStack-beta', retention: 7, window: '16:00-16:30',
    protection: true, removalPolicy: 'RETAIN', deletionPolicy: 'Retain' });
  assert.deepEqual({ retention: RECOVERY_TARGETS.prod.pitrRetentionDays, window: RECOVERY_TARGETS.prod.preferredBackupWindow,
    removalPolicy: RECOVERY_TARGETS.prod.clusterRemovalPolicy, deletionPolicy: RECOVERY_TARGETS.prod.clusterDeletionPolicy },
  { retention: 35, window: '16:00-16:30', removalPolicy: 'RETAIN', deletionPolicy: 'Retain' });
});

test('correct Beta and Production Platform templates satisfy the contract', () => {
  assert.deepEqual(recoveryViolations(beta(), { stage: 'beta' }), []);
  assert.deepEqual(recoveryViolations(prod(), { stage: 'prod' }), []);
});

test('a wrong PITR retention is reported at the exact cluster path', () => {
  for (const [stage, target] of [['beta', 7], ['prod', 35]]) {
    for (const actual of [1, 30]) {
      if (actual === target) continue;
      const template = stage === 'beta' ? beta({ retention: actual }) : prod({ retention: actual });
      assert.deepEqual(recoveryViolations(template, { stage }), [
        { path: `/Resources/${clusterId}/Properties/BackupRetentionPeriod`, expected: target, actual },
      ]);
    }
  }
});

test('a wrong preferred backup window is reported at the exact cluster path', () => {
  for (const stage of ['beta', 'prod']) {
    const template = stage === 'beta' ? beta({ window: '17:00-18:00' }) : prod({ window: '17:00-18:00' });
    assert.deepEqual(recoveryViolations(template, { stage }), [
      { path: `/Resources/${clusterId}/Properties/PreferredBackupWindow`, expected: '16:00-16:30', actual: '17:00-18:00' },
    ]);
  }
});

test('cluster deletion protection false is reported with the expected true value', () => {
  for (const stage of ['beta', 'prod']) {
    const template = stage === 'beta' ? beta({ deletionProtection: false }) : prod({ deletionProtection: false });
    assert.deepEqual(recoveryViolations(template, { stage }), [
      { path: `/Resources/${clusterId}/Properties/DeletionProtection`, expected: true, actual: false },
    ]);
  }
});

test('a wrong cluster DeletionPolicy is reported against the stage target', () => {
  assert.deepEqual(recoveryViolations(beta({ clusterDeletionPolicy: 'Delete', writerDeletionPolicy: 'Retain' }), { stage: 'beta' }), [
    { path: `/Resources/${clusterId}/DeletionPolicy`, expected: 'Retain', actual: 'Delete' },
  ]);
  assert.deepEqual(recoveryViolations(prod({ clusterDeletionPolicy: 'Delete', writerDeletionPolicy: 'Delete' }), { stage: 'prod' }), [
    { path: `/Resources/${clusterId}/DeletionPolicy`, expected: 'Retain', actual: 'Delete' },
    { path: `/Resources/${writerId}/DeletionPolicy`, expected: 'Retain', actual: 'Delete' },
  ]);
});

test('a wrong writer-instance DeletionPolicy is reported as the instance-level evidence', () => {
  assert.deepEqual(recoveryViolations(prod({ writerDeletionPolicy: 'Delete' }), { stage: 'prod' }), [
    { path: `/Resources/${writerId}/DeletionPolicy`, expected: 'Retain', actual: 'Delete' },
  ]);
  assert.deepEqual(recoveryViolations(beta({ writerDeletionPolicy: 'Delete' }), { stage: 'beta' }), [
    { path: `/Resources/${writerId}/DeletionPolicy`, expected: 'Retain', actual: 'Delete' },
  ]);
});

test('every violation is reported for a template that regresses on several properties', () => {
  const template = beta({ retention: 1, window: '17:00-18:00', deletionProtection: false,
    clusterDeletionPolicy: 'Delete', writerDeletionPolicy: 'Delete' });
  assert.deepEqual(recoveryViolations(template, { stage: 'beta' }).map(({ path }) => path), [
    `/Resources/${clusterId}/Properties/BackupRetentionPeriod`,
    `/Resources/${clusterId}/Properties/PreferredBackupWindow`,
    `/Resources/${clusterId}/Properties/DeletionProtection`,
    `/Resources/${clusterId}/DeletionPolicy`,
    `/Resources/${writerId}/DeletionPolicy`,
  ]);
});

test('a dev Platform template passes only while it contains no database cluster', () => {
  const template = beta();
  assert.deepEqual(recoveryViolations({ Resources: {} }, { stage: 'dev' }), []);
  assert.deepEqual(recoveryViolations(template, { stage: 'dev' }), [
    { path: `/Resources/${clusterId}`, expected: 'absent', actual: 'AWS::RDS::DBCluster' },
  ]);
});

test('a missing or duplicated database cluster fails closed', () => {
  const missing = platformTemplate(); delete missing.Resources[clusterId];
  assert.deepEqual(recoveryViolations(missing, { stage: 'beta' }), [
    { path: '/Resources', expected: 'one AWS::RDS::DBCluster', actual: '0 AWS::RDS::DBCluster resources' },
  ]);
  const duplicate = beta();
  duplicate.Resources.OtherDatabaseABCDEF12 = { Type: 'AWS::RDS::DBCluster', DeletionPolicy: 'Delete', Properties: {} };
  assert.deepEqual(recoveryViolations(duplicate, { stage: 'beta' }), [
    { path: '/Resources', expected: 'one AWS::RDS::DBCluster', actual: '2 AWS::RDS::DBCluster resources' },
  ]);
});

test('a missing or duplicated writer instance fails closed', () => {
  const missing = beta(); delete missing.Resources[writerId];
  assert.deepEqual(recoveryViolations(missing, { stage: 'beta' }), [
    { path: `/Resources/${clusterId}`, expected: `one AWS::RDS::DBInstance writer for ${clusterId}`, actual: '0 writers' },
  ]);
  const duplicate = beta();
  duplicate.Resources.OtherWriterABCDEF12 = { Type: 'AWS::RDS::DBInstance', DeletionPolicy: 'Delete',
    Properties: { DBClusterIdentifier: { Ref: clusterId } } };
  assert.deepEqual(recoveryViolations(duplicate, { stage: 'beta' }), [
    { path: `/Resources/${clusterId}`, expected: `one AWS::RDS::DBInstance writer for ${clusterId}`, actual: '2 writers' },
  ]);
});
