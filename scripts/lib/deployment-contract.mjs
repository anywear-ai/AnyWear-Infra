import {
  INFRA_REPOSITORY,
  SERVICE_REPOSITORY,
  STAGE_CONTRACT_STAGE,
  platformStackName,
} from '../../lib/contracts.mjs';

// Single-account constants and the repository identities the operation controls
// import.
//
// The operation/observation record validators that used to live here retired with
// #207: the platform keeps the audit facts, and the four controls import only the
// account, the region, the protected executor identity and the peer repository
// name. Everything else the deployment contract needs — the stage parameter
// surface, the stack identities, the deployed-template normalisation, the bake
// gate's thresholds and name builders — comes from the stage contract at
// `lib/contracts.mjs`.
export const account = '650880818323';
export const region = 'ap-east-1';
export { INFRA_REPOSITORY, SERVICE_REPOSITORY };
// The persistent Beta stage base keeps the Base identifier; the stage contract's
// helper is the one definition of its name.
export const BASE_STACK = platformStackName(STAGE_CONTRACT_STAGE);
