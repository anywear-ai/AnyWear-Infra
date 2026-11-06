import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedBetaSizingProfile } from '../../scripts/lib/beta-sizing-profile.mjs';

// The retained sizing profile is a release-slice parameter. It is preserved by
// `deploy-runtime` and never set; the state observer only reads the retained value
// to report Beta state.
test('a pre-profile workload reads the source default', () => {
  assert.equal(retainedBetaSizingProfile({}), 's1');
  assert.equal(retainedBetaSizingProfile({ BetaApiSizingProfile: 's2-api' }), 's2-api');
});

test('an unknown retained profile fails closed and changes nothing', () => {
  assert.throws(() => retainedBetaSizingProfile({ BetaApiSizingProfile: 's3' }), /Unknown retained Beta API sizing profile/);
});
