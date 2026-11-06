import { matches } from './json-contract.mjs';

// The deploy chain's context (#226). `delivery_trigger` names the entry event that
// reached this workflow and `dispatched_by` names the run that dispatched it.
// Only `deploy-runtime` deploys a Runtime tuple, so only it may carry them; the
// other eleven operations refuse a trigger that carries context, so a chain-shaped
// dispatch to the wrong operation fails loudly instead of being ignored.
//
// `release` is representable and refused: a version tag proves a qualification
// record and changes nothing in Beta, so it has no operation here. Keeping the
// value in the enum makes the forbidden path a refusal with a message rather than
// an input the workflow cannot accept at all.
export const DELIVERY_TRIGGERS = Object.freeze(['deploy', 'release', 'manual']);
export const DELIVERY_TRIGGER_OPERATION = 'deploy-runtime';
// The one form a dispatcher produces for `dispatched_by`: the HTTPS URL of the
// GitHub Actions run that dispatched this workflow. It is also the key the
// receiving workflow renders into its own `run-name`, so a re-run can be
// deduplicated from the run list without reading workflow inputs.
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/;

/**
 * Validate the deploy chain's two context inputs for one operation. Returns the
 * accepted pair for `deploy-runtime` and `null` for an operation that takes no
 * context. `manual` is the workflow's default, so an operation other than
 * `deploy-runtime` treats it as absence; anything that names an event or a
 * dispatching run is refused.
 */
export function validateDeliveryInput(env = process.env, operation = env.INFRA_OPERATION) {
  const deliveryTrigger = env.DELIVERY_TRIGGER ?? '';
  const dispatchedBy = env.DISPATCHED_BY ?? '';
  if (operation !== DELIVERY_TRIGGER_OPERATION) {
    if (deliveryTrigger && deliveryTrigger !== 'manual') {
      throw new Error(`Only ${DELIVERY_TRIGGER_OPERATION} takes a delivery trigger; ${operation} accepts no entry event`);
    }
    if (dispatchedBy) {
      throw new Error(`Only ${DELIVERY_TRIGGER_OPERATION} takes a dispatching run; ${operation} accepts no dispatched_by`);
    }
    return null;
  }
  // The exact refusal the ADR records, and the reason a tag-shaped dispatch to this
  // workflow fails loudly instead of running deploy-runtime.
  if (deliveryTrigger === 'release') {
    throw new Error('delivery_trigger=release is refused: the release chain never deploys');
  }
  if (!DELIVERY_TRIGGERS.includes(deliveryTrigger)) {
    throw new Error(`deploy-runtime requires an explicit delivery trigger: ${DELIVERY_TRIGGERS.join(', ')}`);
  }
  if (deliveryTrigger === 'deploy') {
    if (!RUN_URL.test(dispatchedBy)) {
      throw new Error('delivery_trigger=deploy requires the dispatching run URL as dispatched_by');
    }
  } else if (dispatchedBy) {
    throw new Error('delivery_trigger=manual accepts no dispatched_by');
  }
  return { delivery_trigger: deliveryTrigger, dispatched_by: dispatchedBy };
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
