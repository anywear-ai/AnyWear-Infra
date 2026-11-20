import { matches, HASH } from './json-contract.mjs';

// The deploy chain's and the Client publication chain's context (#226, #344).
// `delivery_trigger` names the entry event that reached this workflow and
// `dispatched_by` names the run that dispatched it. Two operations carry chain
// context: `deploy-runtime` deploys a Runtime tuple from the Service deploy chain,
// and `publish-client` publishes the bundle the Client chain built. The other
// twelve operations refuse a trigger that carries context, so a chain-shaped
// dispatch to the wrong operation fails loudly instead of being ignored.
//
// `release` is representable and refused everywhere: a version tag proves a
// qualification record and changes nothing in Beta, so it has no operation here.
// Keeping the value in the enum makes the forbidden path a refusal with a message
// rather than an input the workflow cannot accept at all.
export const DELIVERY_TRIGGERS = Object.freeze(['deploy', 'release', 'manual', 'publish']);
// The two operations that may carry an entry event. `deploy-runtime` takes the
// Service deploy chain's `deploy`; `publish-client` takes the Client publication
// chain's `publish`. Both also accept a manual dispatch, which carries none.
export const DELIVERY_TRIGGER_OPERATIONS = Object.freeze(['deploy-runtime', 'publish-client']);
// The one dispatch event each operation accepts. `manual` is the workflow default,
// so an operation that takes no context treats it as absence.
const ACCEPTED_TRIGGERS = Object.freeze({
  'deploy-runtime': Object.freeze(['deploy', 'manual']),
  'publish-client': Object.freeze(['publish', 'manual']),
});
// The Client publication chain's three inputs. They identify the Client run Infra
// proves and the bundle manifest digest it re-hashes; no other operation takes
// them.
export const CLIENT_PUBLICATION_OPERATION = 'publish-client';
export const CLIENT_INPUTS = Object.freeze(['CLIENT_RUN_ID', 'CLIENT_RUN_ATTEMPT', 'CLIENT_BUNDLE_DIGEST']);
// The one form a dispatcher produces for `dispatched_by`: the HTTPS URL of the
// GitHub Actions run that dispatched this workflow. It is also the key the
// receiving workflow renders into its own `run-name`, so a re-run can be
// deduplicated from the run list without reading workflow inputs.
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Validate the chain context inputs for one operation. Returns the accepted pair
 * for the two operations that carry context and `null` for an operation that takes
 * none. `manual` is the workflow's default, so an operation outside the two treats
 * it as absence; anything that names an event or a dispatching run is refused.
 */
export function validateDeliveryInput(env = process.env, operation = env.INFRA_OPERATION) {
  const deliveryTrigger = env.DELIVERY_TRIGGER ?? '';
  const dispatchedBy = env.DISPATCHED_BY ?? '';
  const accepted = ACCEPTED_TRIGGERS[operation];
  if (!accepted) {
    if (deliveryTrigger && deliveryTrigger !== 'manual') {
      throw new Error(`Only ${DELIVERY_TRIGGER_OPERATIONS.join(' and ')} take a delivery trigger; ${operation} accepts no entry event`);
    }
    if (dispatchedBy) {
      throw new Error(`Only ${DELIVERY_TRIGGER_OPERATIONS.join(' and ')} take a dispatching run; ${operation} accepts no dispatched_by`);
    }
    return null;
  }
  // The exact refusal the ADR records, and the reason a tag-shaped dispatch to this
  // workflow fails loudly instead of running a deploy or a publication.
  if (deliveryTrigger === 'release') {
    throw new Error('delivery_trigger=release is refused: the release chain never deploys');
  }
  if (!DELIVERY_TRIGGERS.includes(deliveryTrigger)) {
    throw new Error(`${operation} requires an explicit delivery trigger: ${DELIVERY_TRIGGERS.join(', ')}`);
  }
  if (!accepted.includes(deliveryTrigger)) {
    throw new Error(`${operation} refuses delivery_trigger=${deliveryTrigger}: it accepts ${accepted.join(' or ')}`);
  }
  // The two chain events carry the dispatching run; a manual dispatch carries none.
  if (deliveryTrigger !== 'manual') {
    if (!RUN_URL.test(dispatchedBy)) {
      throw new Error(`delivery_trigger=${deliveryTrigger} requires the dispatching run URL as dispatched_by`);
    }
  } else if (dispatchedBy) {
    throw new Error('delivery_trigger=manual accepts no dispatched_by');
  }
  return { delivery_trigger: deliveryTrigger, dispatched_by: dispatchedBy };
}

/**
 * Validate the Client publication identity. `publish-client` requires all three:
 * the positive-integer run id and attempt of the Client publisher run it proves,
 * and the 64-hex SHA-256 of that run's `dist/bundle-manifest.json`. Every other
 * operation refuses a supplied value, so a publication identity cannot ride a
 * deployment or be scored as one.
 */
export function validateClientInputs(env = process.env, operation = env.INFRA_OPERATION) {
  const supplied = CLIENT_INPUTS.map(name => env[name] ?? '');
  if (operation !== CLIENT_PUBLICATION_OPERATION) {
    if (supplied.some(value => value !== '')) {
      throw new Error(`Only ${CLIENT_PUBLICATION_OPERATION} takes the Client publication identity; ${operation} accepts no client_run_id, client_run_attempt or client_bundle_digest`);
    }
    return null;
  }
  const [runId, runAttempt, digest] = supplied;
  for (const [value, label] of [[runId, 'client_run_id'], [runAttempt, 'client_run_attempt']]) {
    if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) {
      throw new Error(`${CLIENT_PUBLICATION_OPERATION} requires a positive-integer ${label} (got '${value}')`);
    }
  }
  matches(digest, HASH, 'client_bundle_digest (the SHA-256 of dist/bundle-manifest.json)');
  return { client_run_id: Number(runId), client_run_attempt: Number(runAttempt), client_bundle_digest: digest };
}

/**
 * The dispatch key a re-run compares: this run's own URL. The receiving workflow
 * renders it into its `run-name`, which the run list exposes as `display_title`.
 */
export function dispatchingRunUrl(env = process.env) {
  if (typeof env.GITHUB_REPOSITORY !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY)) {
    throw new Error('The dispatching repository is required');
  }
  matches(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/, 'dispatching run id');
  return `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}
