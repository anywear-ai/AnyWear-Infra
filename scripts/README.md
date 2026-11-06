# `scripts/` entry surface

This file is the single declaration of the `scripts/` entry surface. An entry is a
`.mjs` program at the `scripts/` root that a reviewed caller invokes as a program
by path. Modules that only other programs import live in
[`lib/`](lib/), and their Node tests live in [`../test/scripts/`](../test/scripts/).

`npm run check` enforces the table below with
[`../test/scripts/entry-manifest.test.mjs`](../test/scripts/entry-manifest.test.mjs):
a root file without a row, a test under `scripts/`, a module without a production
importer, an undeclared invocation, a caller that no longer invokes its file, or a
credential class that disagrees with the job all fail the check by name. The table
is the declaration a reviewer audits; the check is what keeps it true.

## Entry manifest

One row per (entry, caller) pair, 19 rows over 15 entries. The file name is
relative to this directory.

| Entry | Caller | Credential | Proof |
| --- | --- | --- | --- |
| `audit-production.mjs` | `package:audit:prod` | none | Scans the production dependency set with five dated GHSA exceptions; `check.yml` runs it before `npm run check`, so a new vulnerable runtime dependency fails the merge that would produce an operation. |
| `aws-operation.mjs` | `shell:.github/scripts/operation-hook.sh` | inherited | Re-validates the operation's inputs and allowed actions for every `aws` call inside a one-shot task (`BASH_ENV` set by `runtime-operation.mjs`), so the task cannot issue an action its operation was not reviewed for. |
| `check-operation.mjs` | `workflow:.github/workflows/mutate.yml@preflight` | none | Refuses a forbidden operation, a mismatched Service artifact identity and an out-of-scope changed stack before the run can hold an environment or an OIDC token. |
| `check-operation.mjs` | `workflow:.github/workflows/runtime.yml@preflight` | none | Same admission without the artifact-identity branch: `state` can only be the read-only operation. |
| `check-operation.mjs` | `action:.github/actions/verify-operation/action.yml` | none | Re-runs the admission in the credential-free `verify` job, so the release read starts only after the operation and its identity are accepted. |
| `check-operation.mjs` | `action:.github/actions/deploy-operation/action.yml` | oidc-session | The credential job's own admission step for a read-only `state` run, which has no `verify` job. |
| `check-operation.mjs` | `shell:.github/scripts/run-one-shot-task.sh` | inherited | Re-validates the operation immediately before the task script registers an ECS task definition, so a spawned shell cannot run under another operation's context. |
| `compare-live-foundation.mjs` | `workflow:.github/workflows/check.yml@source` | none | Compares the CI-synthesized Foundation with the authenticated Original fixture and admits only declared pseudo-parameter and CDK-metadata differences. |
| `create-test-inputs.mjs` | `workflow:.github/workflows/check.yml@source` | none | Writes the three fixture bytes the stage base consumes so the matrix produces the same Lambda asset identities as a real release; no credential, no live read. |
| `ecr-retention.mjs` | `runbook:docs/runbooks/cutover-and-recovery.md` | operator | Verifies the effective lifecycle policy, the protected current/rollback digests and a completed expiration preview — retention as a read-back a human records. |
| `local-artifact-inputs.mjs` | `cdk:lib/artifact-inputs.ts` | synth | The only strict parse of the Service-built Lambda bundles' runtime policy; the CDK app cannot synthesize the stage base from malformed bytes, and the deploy job's byte proof loads the same bytes through the same function (spawned from `bin/infra.ts` in the credential job). |
| `migrate-beta-split.mjs` | `runbook:docs/runbooks/beta-split-migration.md` | operator | The one-time MOVE is validation-only unless `--apply`; each stage prints its plan, refuses a dirty preview and moves exactly one CloudFront distribution under a separate authorization. |
| `production-preflight.mjs` | `workflow:.github/workflows/production.yml@promotion` | none | Resolves and verifies the Production release identity, stable release and Beta qualification record before any Production credential; no environment, no `id-token`. |
| `promote-production.mjs` | `workflow:.github/workflows/production.yml@promotion` | none | The source blocker: fails before `npm ci`, the App token or any credential, so no activation variable can enable Production. |
| `prove-release-bytes.mjs` | `action:.github/actions/deploy-operation/action.yml` | oidc-session | The deploy job's first step: re-derives the dispatch, requires the digest set to equal the operation's consumed set, hashes each travelled byte once and strictly loads the schema asset or policy before the step that requests an OIDC token. |
| `qualification-dispatch.mjs` | `workflow:.github/workflows/mutate.yml@qualify-hook` | none | Dispatches the E2E qualification with exactly one App token narrowed to AnyWear-E2E `actions: write`; no environment, no OIDC, no AWS permission; the dispatch is the job's last step. |
| `runtime-operation.mjs` | `action:.github/actions/deploy-operation/action.yml` | oidc-session | The only program that reads the Actions OIDC token and calls `sts assume-role-with-web-identity` with an operation-specific session policy; it executes after the byte proof. |
| `synth-matrix.mjs` | `workflow:.github/workflows/check.yml@source` | none | Compares dev/Beta/prod syntheses across the three identity phases with the preserved baselines; an unexpected resource/output/endpoint/topology change fails. |
| `verify-operation-inputs.mjs` | `action:.github/actions/verify-operation/action.yml` | none | The only pre-credential reader of the Service release: read-only App token, exactly the consumed names, bytes published and `release_assets` written; no environment, no OIDC. |

## Data files

Non-entry files at the `scripts/` root. They are data, not programs: no caller
invokes them, and the entry manifest does not list them.

| File | Consumer |
| --- | --- |
| `README.md` | This file: the single declaration of the entry surface, read by `test/scripts/entry-manifest.test.mjs`. |
| `authorization-non-coverage.json` | No consumer in this repository; cited by AnyWear-Meta's `deployment_authorization_surface.md`. |

## Caller kinds

| Kind | Site grammar | Why it exists |
| --- | --- | --- |
| workflow | `.github/workflows/<file>.yml@<job>` | a `run:` step in a job |
| action | `.github/actions/<dir>/action.yml` | a composite `run:` step |
| shell | `.github/scripts/<file>.sh` | a non-comment line in a hook |
| package | `<script name>` in `package.json` | a repository command |
| runbook | `README.md`, `AGENTS.md`, or `docs/**/*.md` | an operator CLI with no workflow caller |
| cdk | `lib/<file>.ts` | the CDK application spawns the program (`bin/infra.ts` → `lib/artifact-inputs.ts` → `scripts/local-artifact-inputs.mjs`) |

## Layout rules

- **An entry stays at the `scripts/` root.** Only a reviewed caller that invokes
  the file as a program by path earns a row here. A new root `.mjs` without a row
  fails `npm run check`.
- **A module lives in `lib/`.** `scripts/lib/` is Node ESM imported only by the
  entries and by other modules. A module may import `scripts/lib/*.mjs` and
  `lib/contracts.mjs`, never `lib/*.ts`; it must have at least one non-test
  importer, must not carry a `process.argv[1]` main guard, and any repository-root
  anchor it computes from its own location steps up two levels.
- **A Node test lives in `test/scripts/`.** No `*.test.mjs` file may sit under
  `scripts/` at any depth. `npm run check` runs `test/scripts/*.test.mjs`,
  `test/contracts/*.test.mjs` and `.github/scripts/*.test.mjs`.
- **One definition per shared constant.** `BASE_STACK`, `SSM_GET_PARAMETERS_LIMIT`,
  `SERVICE_REPOSITORY` and `INFRA_REPOSITORY` are each defined once; a re-export is
  not a definition.
- **`README.md` and `authorization-non-coverage.json` are data.** A new non-entry
  file at the `scripts/` root fails the check until the data table declares it.
