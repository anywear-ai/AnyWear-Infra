import { spawnSync } from 'node:child_process';

const exceptions = new Map([
  ['GHSA-mh99-v99m-4gvg', { expiresOn: '2026-12-01', packageName: 'brace-expansion' }],
  ['GHSA-q2hr-2g5m-vwhr', { expiresOn: '2026-12-01', packageName: 'brace-expansion' }],
  ['GHSA-qhr7-859c-m2p7', { expiresOn: '2026-12-01', packageName: 'brace-expansion' }],
  ['GHSA-6j4f-fj2g-mc7p', { expiresOn: '2026-12-01', packageName: 'brace-expansion' }],
  ['GHSA-g3hv-75wg-m249', { expiresOn: '2026-12-01', packageName: ['aws-cdk-lib', 'minimatch'] }],
]);

const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args = isWindows
  ? ['/d', '/s', '/c', 'npm audit --omit=dev --audit-level low --json']
  : ['audit', '--omit=dev', '--audit-level', 'low', '--json'];
const result = spawnSync(
  command,
  args,
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);

if (result.error) {
  console.error('Unable to run npm audit:', result.error.message);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('npm audit did not return valid JSON.');
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};

function collectAdvisoryIds(packageName, seen = new Set()) {
  if (seen.has(packageName)) return new Set();
  seen.add(packageName);

  const vulnerability = vulnerabilities[packageName];
  const advisoryIds = new Set();
  for (const cause of vulnerability?.via ?? []) {
    if (typeof cause === 'string') {
      for (const id of collectAdvisoryIds(cause, seen)) advisoryIds.add(id);
      continue;
    }

    const githubId = typeof cause.url === 'string'
      ? cause.url.match(/GHSA-[\w-]+/)?.[0]
      : undefined;
    advisoryIds.add(githubId ?? `npm:${String(cause.source ?? 'unknown')}`);
  }
  return advisoryIds;
}

const failures = [];
for (const packageName of Object.keys(vulnerabilities)) {
  const advisoryIds = collectAdvisoryIds(packageName);
  if (advisoryIds.size === 0) {
    failures.push(`${packageName}: no advisory identifier was reported`);
    continue;
  }

  for (const advisoryId of advisoryIds) {
    const exception = exceptions.get(advisoryId);
    if (!exception || ![].concat(exception.packageName).includes(packageName)) {
      failures.push(`${packageName}: ${advisoryId}`);
      continue;
    }

    const expiresAt = Date.parse(`${exception.expiresOn}T23:59:59Z`);
    if (Date.now() > expiresAt) {
      failures.push(`${packageName}: ${advisoryId} exception expired on ${exception.expiresOn}`);
      continue;
    }

    console.warn(`Allowing ${packageName} advisory ${advisoryId} until ${exception.expiresOn}.`);
  }
}

if (failures.length > 0) {
  console.error('Unapproved production dependency advisories:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (result.status !== 0 && Object.keys(vulnerabilities).length === 0) {
  console.error(result.stderr?.trim() || 'npm audit failed without reporting vulnerabilities.');
  process.exit(1);
}
