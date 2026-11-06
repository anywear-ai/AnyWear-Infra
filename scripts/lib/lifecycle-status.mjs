import { parseJson, canonicalJson, HASH } from './json-contract.mjs';

function count(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Invalid lifecycle ${label}`);
}

// The Service→Infra status contract after #213 is one line that carries the
// tester allowlist facts and no mode:
//
//   {"action":"status","tester_count":<0..50>,"tester_allowlist_hash":"<64 hex>", ...backlog}
//
// `action` identifies the object, the integer count and the 64-hex hash are
// required, and any backlog field that is present is validated the same way it
// always was. A status object is never identified by a mode word.
export function parseLifecycleStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.action !== 'status') {
    throw new Error('Lifecycle status fields unavailable');
  }
  count(value.tester_count, 'tester count', 50);
  if (typeof value.tester_allowlist_hash !== 'string' || !HASH.test(value.tester_allowlist_hash)) {
    throw new Error('Invalid lifecycle tester allowlist hash');
  }
  // Backlog is diagnostic evidence about the deployed Service, not an admission
  // decision, so it is optional and validated only when present.
  for (const key of ['tasks', 'outbox', 'outboxManualIntervention']) {
    if (Object.hasOwn(value, key)) count(value[key], key);
  }
  for (const key of ['outboxOldestAgeMs', 'outboxManualInterventionOldestAgeMs']) {
    if (Object.hasOwn(value, key) && value[key] !== null
      && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) throw new Error(`Invalid lifecycle ${key}`);
  }
  if (Object.hasOwn(value, 'outboxStatusCounts')) {
    if (!value.outboxStatusCounts || typeof value.outboxStatusCounts !== 'object' || Array.isArray(value.outboxStatusCounts)) throw new Error('Invalid lifecycle outbox status counts');
    for (const valueCount of Object.values(value.outboxStatusCounts)) count(valueCount, 'outbox status count');
  }
  for (const key of ['queues', 'dlqs']) {
    if (!Object.hasOwn(value, key)) continue;
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) throw new Error(`Invalid lifecycle ${key}`);
    for (const queue of ['vto', 'tagging']) {
      const counts = value[key][queue];
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error(`Invalid lifecycle ${key} ${queue}`);
      for (const field of ['visible', 'notVisible', 'delayed']) count(counts[field], `${key} ${queue} ${field}`);
    }
  }
  canonicalJson(value);
  return value;
}

// A shell's stdout proves neither the Service response nor its task identity.
// Read only the authenticated stopped task's actual CloudWatch destination.
export async function readLifecycleStatus(io, task, definition) {
  const taskId = task?.taskArn?.match(/^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/([a-f0-9]{32})$/)?.[1];
  const container = definition?.containerDefinitions?.find(item => item.name === 'OneShot');
  const options = container?.logConfiguration?.options;
  if (!taskId || task.clusterArn !== 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear'
    || task.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definition?.taskDefinitionArn
    || definition.family !== 'beta-anywear-lifecycle'
    || JSON.stringify(container?.command) !== JSON.stringify(['node', 'dist/ops/beta-lifecycle.js', 'status'])
    || container.logConfiguration.logDriver !== 'awslogs'
    || options?.['awslogs-group'] !== '/anywear/beta/one-shot'
    || options['awslogs-region'] !== 'ap-east-1' || options['awslogs-stream-prefix'] !== definition.family) {
    throw new Error('Exact stopped lifecycle status task/log destination is unproven');
  }
  const args = ['logs', 'get-log-events', '--log-group-name', options['awslogs-group'],
    '--log-stream-name', `${definition.family}/OneShot/${taskId}`, '--start-from-head', '--limit', '1000'];
  let previous;
  for (let attempt = 0; attempt < 5; attempt++) {
    let token; const seen = new Set(); const messages = [];
    for (let page = 0; page < 16; page++) {
      const response = await io.aws([...args, ...(token ? ['--next-token', token] : [])]);
      if (!Array.isArray(response.events) || response.events.length > 1000
        || response.events.some(event => typeof event?.message !== 'string')) throw new Error('Lifecycle status log page is malformed');
      messages.push(...response.events.map(event => event.message));
      if (messages.length > 4096) throw new Error('Lifecycle status log inventory exceeds its bound');
      const next = response.nextForwardToken;
      if (typeof next !== 'string' || !next || next.length > 4096) throw new Error('Lifecycle status log pagination is unproven');
      if (next === token) break;
      if (seen.has(next) || page === 15) throw new Error('Lifecycle status log pagination did not complete');
      seen.add(next); token = next;
    }
    const statuses = [];
    for (const message of messages) {
      // The pinned Service emits one plain JSON object identified by its `action`
      // member. Unrelated log messages are not status evidence; a line that looks
      // like a status but cannot be parsed or validated fails closed rather than
      // being skipped.
      if (!/"action"\s*:\s*"status"/.test(message)) continue;
      const value = parseJson(message);
      statuses.push(parseLifecycleStatus(value));
    }
    if (statuses.length > 1) throw new Error('Lifecycle status log evidence is ambiguous');
    if (statuses.length === 1) {
      const current = canonicalJson(statuses[0]);
      if (previous === current) return statuses[0];
      if (previous !== undefined) throw new Error('Lifecycle status log evidence changed during readback');
      previous = current;
    } else previous = undefined;
    // Require two complete matching scans after task cessation, accounting for
    // delayed CloudWatch ingestion rather than trusting a first partial view.
    if (attempt < 4) await io.sleep(2000);
  }
  throw new Error('Unique authenticated lifecycle status evidence is unavailable');
}
