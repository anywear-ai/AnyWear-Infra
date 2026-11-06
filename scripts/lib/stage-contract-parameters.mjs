import { sha256 } from './json-contract.mjs';
import {
  STAGE_CONTRACT_STAGE,
  STAGE_CONTRACT_PARAMETERS,
  STAGE_CONTRACT_CONDITIONAL_PARAMETERS,
  STAGE_CONTRACT_READ_PARAMETERS,
} from '../../lib/contracts.mjs';

// The exact `/anywear/beta/...` stage-contract surface is exported by
// `lib/contracts.mjs`: 35 names exist in every identity phase and variant
// (including `api_base_url`), and `cleanup_task_role_arn` exists only while the
// phase creates the cleanup task role (`identityPhase !== 'legacy'`). A deployment
// records each consumed parameter with its SSM parameter version and the sha256 of
// its value, so it is auditable without a committed cross-repository pin.
//
// This script adds only the runtime read: the workflow runs it before (and
// without) compiling TypeScript, so it imports the contract directly and wraps
// the names in bounded `ssm get-parameters` batches.
export {
  STAGE_CONTRACT_STAGE,
  STAGE_CONTRACT_PARAMETERS,
  STAGE_CONTRACT_CONDITIONAL_PARAMETERS,
  STAGE_CONTRACT_READ_PARAMETERS,
};

// `ssm get-parameters` accepts at most 10 names per request, so the surface is
// read in deterministic batches instead of one oversized call.
export const SSM_GET_PARAMETERS_LIMIT = 10;
export const STAGE_CONTRACT_READ_BATCHES = Object.freeze(
  Array.from({ length: Math.ceil(STAGE_CONTRACT_READ_PARAMETERS.length / SSM_GET_PARAMETERS_LIMIT) },
    (_, index) => Object.freeze(STAGE_CONTRACT_READ_PARAMETERS.slice(
      index * SSM_GET_PARAMETERS_LIMIT, (index + 1) * SSM_GET_PARAMETERS_LIMIT))));

// Read the consumed stage contract through bounded `ssm get-parameters` calls and
// normalize it to the record's `inputs[]` rows. The value itself is never
// recorded, only its content hash and the parameter version that produced it.
//
// `allowUnpublished` is the one reviewed exception for a parameter the target
// Base stack has not published yet (pre-M4 `api_base_url`): the name may appear
// as an SSM `InvalidParameters` entry and may be absent from the returned rows,
// and the record hashes only the published subset. Every other unconditional
// name stays required; the phase-dependent cleanup role remains the only
// absence that never needs an allow-list entry.
export async function readStageInputs(io, { allowUnpublished = [] } = {}) {
  const allowed = new Set();
  if (!Array.isArray(allowUnpublished)) throw new Error('Invalid unpublished stage-contract parameters');
  for (const value of allowUnpublished) {
    if (typeof value !== 'string' || !value) throw new Error('Invalid unpublished stage-contract parameter');
    const name = value.startsWith('/anywear/beta/') ? value : `/anywear/beta/${value}`;
    if (!STAGE_CONTRACT_PARAMETERS.includes(name)) throw new Error(`Unknown unpublished stage-contract parameter ${value}`);
    if (allowed.has(name)) throw new Error(`Duplicate unpublished stage-contract parameter ${value}`);
    allowed.add(name);
  }
  const byName = new Map();
  for (const batch of STAGE_CONTRACT_READ_BATCHES) {
    const response = await io.aws(['ssm', 'get-parameters', '--names', ...batch], 'ap-east-1');
    const parameters = response.Parameters;
    const invalid = response.InvalidParameters ?? [];
    if (!Array.isArray(parameters) || !Array.isArray(invalid)
      || invalid.some(parameter => !batch.includes(parameter)
        || (!STAGE_CONTRACT_CONDITIONAL_PARAMETERS.includes(parameter) && !allowed.has(parameter)))
      || parameters.length + invalid.length !== batch.length) {
      throw new Error('Stage contract parameters unavailable');
    }
    for (const parameter of parameters) {
      if (!batch.includes(parameter?.Name) || byName.has(parameter.Name)) {
        throw new Error(`Stage contract parameter ${parameter?.Name} unexpected`);
      }
      byName.set(parameter.Name, parameter);
    }
  }
  if (STAGE_CONTRACT_PARAMETERS.some(parameter => !byName.has(parameter) && !allowed.has(parameter))) {
    throw new Error('Stage contract parameters unavailable');
  }
  return STAGE_CONTRACT_READ_PARAMETERS.filter(parameter => byName.has(parameter)).map(parameter => {
    const value = byName.get(parameter);
    if (typeof value.Value !== 'string' || value.Type === 'SecureString') throw new Error(`Stage contract parameter ${parameter} unreadable`);
    if (!Number.isSafeInteger(Number(value.Version)) || Number(value.Version) < 1) throw new Error(`Stage contract parameter ${parameter} has no version`);
    return { parameter, version: String(value.Version), value_sha256: sha256(value.Value) };
  });
}
