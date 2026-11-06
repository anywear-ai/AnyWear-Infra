// The one pinned-workload readback shared by the runtime, tester and restore
// operations. It moved here when the Beta lifecycle entry point retired; every
// caller names the exact selected Service image/commit it is operating on.
function values(entries, nameKey, valueKey) {
  return Object.fromEntries((entries ?? []).map((entry) => [entry[nameKey], entry[valueKey]]));
}

export function workloadRevision(stack) {
  const parameters = values(stack.Parameters, 'ParameterKey', 'ParameterValue');
  const digest = parameters.ServiceImageDigest;
  const commit = parameters.ServiceCommitSha;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw new Error('Beta workload requires an existing pinned image and commit');
  }
  if (!parameters.VlmConfigArn || !/^pl-[a-z0-9]+$/.test(parameters.CloudFrontPrefixListId ?? '')) {
    throw new Error('Beta workload parameters are incomplete');
  }
  return { digest, commit, parameters };
}
