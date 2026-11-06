import { runtimeStackName } from '../../lib/contracts.mjs';

// One writer per environment. Infra deploys the persistent Beta Base stack and
// the Runtime stack, so no Base mutation may cross a Runtime deployment.
// CloudFormation only reports a stack as terminal in these
// statuses; a missing stack is not terminal either, and every reader fails closed.
export const runtimeStack = runtimeStackName('beta');
export const terminalStackStatuses = Object.freeze(new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']));

// Issue #166: Beta run state is one fact — whether the Runtime stack exists. It
// replaced the per-stack `BetaActive` outputs and the stopped topology. A missing
// StackName is absence, not an inactive state to maintain.
export function runtimeExists(stack) {
  return stack?.StackName === runtimeStack;
}

export function assertTerminalRuntime(runtime, action) {
  if (!terminalStackStatuses.has(runtime?.StackStatus)) {
    throw new Error(`${action} requires a terminal ${runtimeStack}; observed ${runtime?.StackStatus ?? 'unavailable'}`);
  }
}

// Operations that act on deployed compute need the stack present and stable.
export function assertRuntimeReady(runtime, action) {
  if (!runtimeExists(runtime)) {
    throw new Error(`${action} requires ${runtimeStack}; start Beta first (deploy-egress, then the Service deploy)`);
  }
  assertTerminalRuntime(runtime, action);
}

// `delete-egress` is the stop path's second step: the Runtime stack must already
// be gone, or deleting Egress would strand running tasks without NAT.
export function assertRuntimeAbsent(runtime, action) {
  if (runtimeExists(runtime)) {
    throw new Error(`${action} requires ${runtimeStack} to be absent; stop the Runtime stack first`);
  }
}

// A stopped environment has no Runtime stack. CloudFormation's DescribeStacks
// answers a missing stack with a `ValidationError: Stack with id <name> does not
// exist` (or `Stack <name> does not exist`), and the AWS CLI exits non-zero, so
// every reader below catches exactly that sentence and returns absence. The
// runner's stderr prefixes the CLI's own line with `aws: [ERROR]: `, so that
// wrapper is accepted; nothing else is. Every other failure — throttling,
// AccessDenied, network, malformed output — is rethrown: absence is never
// inferred from a generic error and a mock that returns `{Stacks: []}` without
// that error fails closed instead.
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isStackAbsentError(error, stackName) {
  if (typeof stackName !== 'string' || stackName.length === 0) return false;
  const text = [error?.stderr, error?.message, error?.cause?.message]
    .filter(value => typeof value === 'string').join('\n');
  if (!text) return false;
  const name = escapeRegExp(stackName);
  const pattern = new RegExp(
    `(?:^|\\n)(?:aws: \\[ERROR\\]: )?`
    + `(?:An error occurred \\(ValidationError\\) when calling the DescribeStacks operation: )?`
    + `Stack (?:with id )?${name} does not exist\\s*$`,
  );
  return pattern.test(text);
}

// The one absence-aware stack reader. `io.aws` is the operation's restricted
// session; `region` is passed through for the observation path. A single stack
// is returned, or `undefined` when CloudFormation reports exactly that the stack
// does not exist.
export async function describeStack(io, stackName, region) {
  try {
    const response = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', stackName], region);
    const stacks = response?.Stacks;
    if (!Array.isArray(stacks)) throw new Error(`DescribeStacks returned no stack list for ${stackName}`);
    if (stacks.length > 1) throw new Error(`DescribeStacks returned multiple stacks for ${stackName}`);
    if (stacks.length === 0) {
      throw new Error(`DescribeStacks returned no stack for ${stackName} without an absence error`);
    }
    return stacks[0];
  } catch (error) {
    if (isStackAbsentError(error, stackName)) return undefined;
    throw error;
  }
}
