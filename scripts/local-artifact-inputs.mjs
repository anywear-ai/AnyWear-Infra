import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson, exact, integer } from './lib/json-contract.mjs';

// The stage base deploys two Service-built Lambda bundles and the task runtime
// policy. They are read from a Service release directory, never rebuilt or
// committed here. This loader keeps the strict runtime-policy parse and bounds a
// pre-credential gate; a bundle's byte provenance is proven once in the deploy
// job against the release's published digests, not by a manifest read here.
const POLICY_KEYS = ['queueVisibilitySeconds', 'receiveVisibilitySeconds', 'dbLeaseMs', 'sqsHeartbeatMs', 'retryDelayBaseMs',
  'retryDelayMaxMs', 'outboxRetryDelayMs', 'outboxMaxAttempts', 'maxAttempts', 'maxReceives', 'terminalRedriveSeconds'];
// The published names the stage base consumes. They are frozen constants, not
// fields read from a Service-supplied manifest.
export const BUNDLE_FILES = Object.freeze({ 'pre-sign-up': 'pre-sign-up.zip', 'post-confirmation': 'post-confirmation.zip' });
export const RUNTIME_POLICY_FILE = 'runtime-policy.json';

export function loadLocalArtifactInputs(directory) {
  const policy = parseJson(readFileSync(path.join(directory, RUNTIME_POLICY_FILE)));
  exact(policy, ['vto', 'auto-tagging'], 'runtime policy');
  for (const item of Object.values(policy)) {
    exact(item, POLICY_KEYS, 'task runtime policy');
    for (const key of POLICY_KEYS) integer(item[key], `runtime policy ${key}`);
    if (item.queueVisibilitySeconds > 43200 || item.maxReceives > 1000) throw new Error('Unsupported queue settings');
  }
  return { lambdas: Object.fromEntries(Object.entries(BUNDLE_FILES)
    .map(([lambda, file]) => [lambda, { path: path.join(directory, file) }])), runtimePolicy: policy };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(JSON.stringify(loadLocalArtifactInputs(path.resolve(process.argv[2]))));
