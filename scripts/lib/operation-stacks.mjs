const stackChanges = Object.freeze({
  'deploy-foundation': ['AnyWearFoundationStack'],
  'deploy-billing': ['AnyWearBillingStack-beta'],
  'deploy-platform': ['AnyWearPlatformStack-beta'],
  // Issue #166: Egress is the disposable network edge. It exists only while
  // Beta runs, so it is an operation-owned stack, not part of the always-present
  // configured manifest below.
  'deploy-egress': ['AnyWearEgressStack-beta'],
  'delete-egress': ['AnyWearEgressStack-beta'],
  // Issue #195: the release slice is deployed and stopped by Infra with the same
  // restricted mutations entry. Both operations change only the Runtime stack.
  // Since #254 a `deploy-runtime` run may also write the Base stack's one
  // `ApiOriginDomainName` parameter once its Runtime stack is terminal: that is
  // an in-place parameter write of the same start, not a second changed stack, so
  // the changed set and the one-asset release contract stay as they are.
  'deploy-runtime': ['AnyWearRuntimeStack-beta'],
  'stop-runtime': ['AnyWearRuntimeStack-beta'],
  // Release recovery restores the persistent Base stack only.
  'restore-release': ['AnyWearPlatformStack-beta'],
});

// One authoritative table for the configured stack set. The authorization gate and
// the operation's own change scope read this instead of repeating stack names,
// regions and count assertions locally. It is exactly the stack set this repository
// always produces: Foundation, the Beta Base stack and Billing.
// `AnyWearRuntimeStack-beta` and `AnyWearEgressStack-beta` exist only while the
// environment runs.
export const configuredStacks = Object.freeze([
  Object.freeze({ stack_name: 'AnyWearFoundationStack', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearPlatformStack-beta', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearBillingStack-beta', region: 'us-east-1' }),
]);

// Stacks an operation may change without being part of the always-present
// manifest.
export const operationOwnedStacks = Object.freeze([
  Object.freeze({ stack_name: 'AnyWearEgressStack-beta', region: 'ap-east-1' }),
  Object.freeze({ stack_name: 'AnyWearRuntimeStack-beta', region: 'ap-east-1' }),
]);

export function configuredStackNames() {
  return configuredStacks.map(stack => stack.stack_name);
}

export function changedStackNames(operation) {
  return [...(stackChanges[operation] ?? [])];
}
