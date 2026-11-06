import { spawnSync } from 'node:child_process';
import { validateOperationInputs } from './runtime-operation.mjs';
import { assertAwsAllowed } from './lib/operation-boundaries.mjs';
validateOperationInputs();
assertAwsAllowed(process.env, process.argv.slice(2));
const result = spawnSync('aws', process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
