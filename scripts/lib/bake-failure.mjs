// Issue #336: the failed 300-second bake's step-log record.
//
// The gate block already carries every signal's judged `value`, its `threshold`,
// the reads it came from and its exceptions, but the deploy operation used to
// project three fields out of eight — `signal`, `state`, `exceptions` — so a
// failure line named the signal and repeated the exception list, never the number
// that breached or the queue it belonged to. This module is the one projector
// over that block: one labelled line per signal whose state is not
// `not-breaching`, in `DEPLOYMENT_GATE_SIGNAL_NAMES` order, plus the count
// summary the step throws.
//
// It is pure: it reads only its `gate` argument, mutates nothing, calls no AWS
// surface and adds no second evidence line. `reads` and `alarms` stay on the
// in-memory block and in CloudWatch; `comparison` is implied by the threshold
// keys beside the value keys and is not repeated. Nothing here publishes a
// record (#207, ADR-0030 §1) — the lines are the step log.
//
// The record is bounded at 2048 bytes for the worst case of six simultaneous
// failing signals. The bound is applied per member and never by dropping a
// signal or a judged number: `target` is clipped first because it is the only
// unbounded member that grows with a resource name, then `reason`; `state`,
// `value` and `threshold` are never clipped.

import { DEPLOYMENT_GATE_SIGNAL_NAMES } from '../../lib/contracts.mjs';

// The hard ceiling for the whole record: every per-signal line with its
// newline plus the thrown summary line.
export const BAKE_FAILURE_LIMIT_BYTES = 2048;
// The ordinary one-signal reference (the incident's own breach), not a target
// the six-signal record is held to.
export const BAKE_FAILURE_DESIGN_LIMIT_BYTES = 1024;
// The two clips, each measured in UTF-8 bytes and each including the `...`
// marker written in place of the remainder.
export const BAKE_FAILURE_TARGET_LIMIT_BYTES = 96;
export const BAKE_FAILURE_REASON_LIMIT_BYTES = 60;

const ORDER = new Map(DEPLOYMENT_GATE_SIGNAL_NAMES.map((name, index) => [name, index]));
const ECS_VALUE_KEYS = Object.freeze(['longest_gap_seconds', 'max_sample_gap_seconds', 'samples']);

const scalar = (value) => (value === null || value === undefined ? 'null' : String(value));

/**
 * Escape the characters that would make one signal span more than one physical
 * line: the backslash itself, the three short escapes, every other C0 control and
 * the two Unicode line separators. A single left-to-right pass, so an escaped
 * backslash is never mistaken for the start of a second escape.
 */
function escapeText(value) {
  const text = String(value);
  let escaped = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === '\\') escaped += '\\\\';
    else if (character === '\n') escaped += '\\n';
    else if (character === '\r') escaped += '\\r';
    else if (character === '\t') escaped += '\\t';
    else if (code < 0x20 || code === 0x2028 || code === 0x2029) {
      escaped += `\\u${code.toString(16).padStart(4, '0')}`;
    } else escaped += character;
  }
  return escaped;
}

/**
 * Clip `text` to `limitBytes` UTF-8 bytes including the trailing `...`, cutting
 * the head on a code-point boundary so a multi-byte character is never split.
 * A text already inside the bound is returned untouched.
 */
function clipText(text, limitBytes) {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return text;
  const budget = limitBytes - 3;
  let head = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) break;
    head += character;
    bytes += size;
  }
  return `${head}...`;
}

function pairs(object) {
  if (!object || typeof object !== 'object') return 'null';
  return Object.entries(object).map(([key, value]) => `${key}=${scalar(value)}`).join(',');
}

function readsOf(signal) {
  return Array.isArray(signal?.reads) ? signal.reads : [];
}

/**
 * The `value` slot: the gate's own object copied whole as `key=value` pairs, or
 * `null` when the gate judged no number at all. The ECS signal is the one
 * projection: its object also carries the per-sample rows and the verdicts, so
 * only the count gap and — when a sample's deployment half was unsettled — the
 * first non-null condition are printed.
 */
function valueSlot(signal) {
  const value = signal?.value;
  if (!value || typeof value !== 'object') return 'null';
  if (signal.name !== 'ecs_running_not_desired') return pairs(value);
  const entries = ECS_VALUE_KEYS.map((key) => [key, value[key] ?? null]);
  const rows = Array.isArray(value.unexpected_deployments) ? value.unexpected_deployments : [];
  const breach = rows.find((row) => row?.condition !== null && row?.condition !== undefined);
  if (breach) entries.push(['deployment_breach', breach.condition]);
  return entries.map(([key, entry]) => `${key}=${scalar(entry)}`).join(',');
}

// A target slot with no read at all prints `unknown`; a name the gate never read
// is never invented here.
const unknownTarget = () => undefined;

function albTarget(signal) {
  const read = readsOf(signal).find((candidate) => typeof candidate?.dimensions?.LoadBalancer === 'string');
  return typeof read?.dimensions.LoadBalancer === 'string' ? read.dimensions.LoadBalancer : unknownTarget();
}

function ecsTarget(signal) {
  const read = readsOf(signal).find((candidate) => typeof candidate?.cluster === 'string' && candidate.cluster !== '');
  if (!read) return unknownTarget();
  const services = [];
  const rows = Array.isArray(signal?.value?.unexpected_deployments) ? signal.value.unexpected_deployments : [];
  for (const row of rows) {
    if (typeof row?.service === 'string' && !services.includes(row.service)) services.push(row.service);
  }
  // A count-half-only breach records no per-service row, so the target names the
  // two services the gate actually read rather than attributing the gap to one.
  if (services.length === 0) {
    for (const service of Array.isArray(read.services) ? read.services : []) {
      if (typeof service === 'string' && !services.includes(service)) services.push(service);
    }
  }
  return services.length > 0 ? `${read.cluster}(${services.join(',')})` : unknownTarget();
}

const labeledQueue = (label, name) => `${label}=${typeof name === 'string' && name !== '' ? name : 'unknown'}`;

function sqsAgeTarget(signal) {
  const reads = readsOf(signal).filter((candidate) => candidate?.metric_name === 'ApproximateAgeOfOldestMessage');
  if (reads.length === 0) return unknownTarget();
  return [labeledQueue('vto', reads[0]?.dimensions?.QueueName),
    labeledQueue('auto_tagging', reads[1]?.dimensions?.QueueName)].join(',');
}

function sqsDepthTarget(signal) {
  const reads = readsOf(signal).filter((candidate) => candidate?.source === 'sqs'
    && typeof candidate?.attribute === 'string');
  if (reads.length === 0) return unknownTarget();
  return [labeledQueue('vto_dlq', reads[0]?.queue_name),
    labeledQueue('auto_tagging_dlq', reads[1]?.queue_name)].join(',');
}

function outboxTarget(signal) {
  const read = readsOf(signal).find((candidate) => typeof candidate?.log_group === 'string' && candidate.log_group !== '');
  if (!read) return unknownTarget();
  const logGroup = typeof read.log_group === 'string' ? read.log_group : 'unknown';
  const filterPattern = typeof read.filter_pattern === 'string' && read.filter_pattern !== ''
    ? read.filter_pattern : 'unknown';
  return `${logGroup},${filterPattern}`;
}

const TARGETS = Object.freeze({
  alb_5xx_rate: albTarget,
  alb_p95_latency: albTarget,
  ecs_running_not_desired: ecsTarget,
  sqs_oldest_message_age: sqsAgeTarget,
  sqs_dlq_depth: sqsDepthTarget,
  outbox_oldest_age: outboxTarget,
});

function targetSlot(signal) {
  const derive = TARGETS[signal.name] ?? unknownTarget;
  const target = derive(signal);
  return typeof target === 'string' && target !== '' ? escapeText(target) : 'unknown';
}

function rank(name) {
  return ORDER.has(name) ? ORDER.get(name) : DEPLOYMENT_GATE_SIGNAL_NAMES.length;
}

/** The failing signals, in contract order; an unknown signal keeps its gate order after them. */
function failingSignals(gate) {
  const signals = Array.isArray(gate?.signals) ? gate.signals : [];
  return signals
    .map((signal, index) => ({ signal, index }))
    .filter(({ signal }) => signal && signal.state !== 'not-breaching')
    .sort((left, right) => rank(left.signal.name) - rank(right.signal.name) || left.index - right.index)
    .map(({ signal }) => signal);
}

/** One labelled line per failing signal, in `DEPLOYMENT_GATE_SIGNAL_NAMES` order. */
export function bakeFailureLines(gate) {
  return failingSignals(gate).map((signal) => {
    const slots = [
      escapeText(signal.name),
      `state=${scalar(signal.state)}`,
      `value=${valueSlot(signal)}`,
      `threshold=${pairs(signal.threshold)}`,
      `target=${clipText(targetSlot(signal), BAKE_FAILURE_TARGET_LIMIT_BYTES)}`,
    ];
    // The reason is the deciding exception `failSignal` puts first, and only an
    // `insufficient` signal has one: a breach is fully described by its number.
    if (signal.state === 'insufficient') {
      const reason = Array.isArray(signal.exceptions) ? signal.exceptions[0] : undefined;
      if (reason !== undefined && reason !== null) {
        slots.push(`reason=${clipText(escapeText(reason), BAKE_FAILURE_REASON_LIMIT_BYTES)}`);
      }
    }
    return slots.join(' ');
  });
}

/**
 * The one-line summary the deploy step throws: how many of the six signals failed
 * and which ones, keeping the prefix the existing assertions and the runbook
 * already name.
 */
export function bakeFailureSummary(gate) {
  const names = failingSignals(gate).map((signal) => escapeText(signal.name));
  return `The 300-second bake failed (${names.length} of ${DEPLOYMENT_GATE_SIGNAL_NAMES.length} signals): ${names.join(', ')}`;
}
