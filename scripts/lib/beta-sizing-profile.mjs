const profiles = new Set(['s1', 's2-api']);

// The retained sizing profile is a release-slice parameter. It is preserved, never
// set: nothing writes it after the reviewed update that selected it, and
// `deploy-runtime` only passes the live value back. The state observer reports the
// retained value, so a missing parameter reads as the source default.
export function retainedBetaSizingProfile(parameters) {
  // The pre-profile source has the fixed S1 512/1024 pair.
  const observed = parameters.BetaApiSizingProfile === undefined ? 's1' : parameters.BetaApiSizingProfile;
  if (!profiles.has(observed)) throw new Error('Unknown retained Beta API sizing profile');
  return observed;
}
