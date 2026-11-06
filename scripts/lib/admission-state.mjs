import { canonicalJson, parseJson, sha256 } from './json-contract.mjs';

// Beta admission after #213 is one input at one decision point: the exact tester
// allowlist, read only by Cognito PreSignUp at registration. There is no mode, no
// window and no second parameter; the allowlist constrains registration only, so
// an existing account is never re-gated by its current contents.
export const TESTER_ALLOWLIST_PARAMETER = '/anywear/beta/tester_allowlist';

// The canonical tester list: sorted, unique, lowercase, at most 50 exact
// addresses within the SSM value budget. The same function is the parser, so the
// writer and every reader agree on one byte string.
export function normalizeTesterEmails(bytes) {
  const emails = parseJson(bytes);
  if (!Array.isArray(emails) || emails.length > 50 || emails.some(email => typeof email !== 'string')) throw new Error('At most 50 exact tester emails required');
  const normalized = [...new Set(emails.map(email => email.trim().toLowerCase()))].sort();
  if (normalized.some(email => email.length > 254 || email.includes('*') || !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))) throw new Error('Exact tester email required');
  const payload = canonicalJson(normalized);
  if (Buffer.byteLength(payload) > 4096) throw new Error('Tester list exceeds SSM capacity');
  return payload;
}

// The Service→Infra status contract: the allowlist hash is the lowercase-hex
// sha256 of the canonical JSON array of normalized addresses.
export const testerAllowlistHash = emails => sha256(canonicalJson(emails));

export function unavailableAdmissionState() {
  return { tester_emails: 'unavailable' };
}

// Read only the allowlist. A present-but-malformed value is a failed read, not a
// value to interpret: there is no fail-closed mode word any more.
export async function readAdmissionState(io) {
  const parameter = (await io.aws(['ssm', 'get-parameter', '--name', TESTER_ALLOWLIST_PARAMETER])).Parameter;
  if (parameter?.Name !== undefined && parameter.Name !== TESTER_ALLOWLIST_PARAMETER) throw new Error('Unexpected tester allowlist parameter identity');
  return { tester_emails: parseJson(normalizeTesterEmails(parameter?.Value)) };
}

// Evidence-only reads record what was observed without turning a failed read into
// a failed operation. A sanitized `unavailable` keeps "empty" distinct from
// "unreadable" in the run evidence.
export async function observeAdmissionState(io) {
  try {
    return { state: await readAdmissionState(io), result: 'observed' };
  } catch {
    return { state: unavailableAdmissionState(), result: 'unavailable' };
  }
}
