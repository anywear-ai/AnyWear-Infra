# AnyWear Infra

Private repository for AnyWear's shared AWS CDK application and infrastructure
operations. Extraction is tracked in [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54).

This repository contains the CDK app, a versioned constructs package, source
checks and reviewed Beta operation entry point. The verified #54 cutover assigns
Infra the sole operational Beta deployment queue. AnyWear-Service remains the
application, migration, verification and immutable artifact publisher; source
delivery alone does not establish AWS deployment or runtime acceptance.

The accepted [ownership ADR](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/ADR/0021-shared-infrastructure-repository.md)
assigns shared infrastructure to Infra, immutable application artifacts to Service,
independent web publishing to Client, and authenticated system qualification to E2E.

## Source checks

Use Node.js 24 and npm in this repository:

```sh
npm ci
npm run audit:prod
npm run check
node scripts/create-test-inputs.mjs
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --output cdk.matrix
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --retention-protection true --output cdk.protected.matrix
```

[Source CI](.github/workflows/check.yml) runs these checks without private peer
checkouts or cloud credentials. The matrix compares dev active, Beta active and
prod active across the three identity phases against the preserved
Service source templates for the stack set this app still synthesizes
(Foundation, Base, Billing). Issue #166 removed the stopped Beta template: the
environment stops by deleting the Egress and Runtime stacks, so the Base template
has one variant. Fixture artifacts are a local stand-in for the
stage base's Service-built Lambda inputs; deployments download the sealed Service
artifact instead. CI repeats all three phases with explicit retention protection
and uploads `cdk.matrix/comparison.json` and
`cdk.protected.matrix/comparison.json` as `infra-source-matrix`.

## Stage contract

`AnyWearPlatformStack-beta` (the persistent `Base` stack) publishes the Beta stage
base as plain SSM parameters under `/anywear/beta/`. **35 names exist in every
identity phase and environment variant**: the public API distribution base URL
(`api_base_url`), the VPC and subnet tiers (public, private and isolated),
ECS cluster name and ARN, Aurora endpoint and secret, the three workload security
groups plus the one-shot task security group, the ECR repository identity, both
task queues, both queue and dead-letter-queue names and URLs, the wardrobe bucket
ARN, the operations topic, the CloudFront origin-facing prefix list id, the VLM
config secret ARN, and the one-shot verification/execution role ARNs and log
group name/ARN. One further name, `cleanup_task_role_arn`, is published only
while the identity phase creates the cleanup task role
(`identityPhase !== 'legacy'`). They join the four existing published names
(`cognito_user_pool_id`, `cognito_client_id`, `s3_bucket_name`,
`qweather_api_host`); the runtime-owned `tester_allowlist` and
`aws_region` parameters are not duplicated. Values come from the existing
Base resources; nothing reads another stack at deploy time. The ten values
added by the issue #158 extension replace the remaining weak
`Fn::GetStackOutput` reads; the Runtime stack resolves them from the stage
contract, so the Base/Runtime deploy order no longer matters. `private_subnet_ids` and
`isolated_subnet_ids` are the two Base subnet groups and are never empty
`StringList`s; the Egress stack adds the 0.0.0.0/0 routes to the Base-owned
Private route tables while it exists (Base keeps the route tables and their single
per-subnet associations).

Two values have no Base resource: `vlm_config_arn` and
`cloudfront_prefix_list_id` are reviewed constants read from the then-live
`AnyWearWorkloadStack-beta` parameters before the #166 split (account `650880818323`,
`ap-east-1`), recorded as identifiers only. They are changed only in a reviewed
diff. Any other stage must pass explicit values and fails closed without them.

Foundation no longer defines per-service deploy roles. Issue #195 retired
`beta-service-deploy-role` and `beta-service-deploy-cfn-role` with the Service
deploy chain: the release slice is deployed by `deploy-runtime` under the
existing `beta-infra-deploy-role`, which already assumes the standard CDK
bootstrap roles (`cdk-hnb659fds-deploy-role`, `-file-publishing-role`,
`-lookup-role`) and the bootstrap CloudFormation execution role
(`cdk-hnb659fds-cfn-exec-role-650880818323-ap-east-1`). The operation's own
preflight, change set and session policy are its scope; it does not claim IAM
isolation the bootstrap path does not provide. The live Foundation no longer
carries the four retired resources: issue #199's separately authorized
`deploy-foundation` removed them, and
`test/fixtures/foundation-live-provenance.json` no longer records a pending
removal. The Runtime stack's execution role is the CDK bootstrap role because the
rebind happened before the removal.
The Runtime stack's CDK source, baselines and deploy chain now live in this
repository (`lib/runtime-stack.ts`, `deployScope=runtime`), and `deploy-runtime`
with the Beta stage contract deploys it, admits the pre-mutation schema
comparison and bakes the six signals in the same job.

`beta-infra-runtime-role` (Platform `DedicatedPolicy`) gains two read-only
statements for the deployment bake (#195): `cloudwatch:DescribeAlarms` on
`beta-anywear-*` and `logs:FilterLogEvents` on `/anywear/beta/worker`.
`beta-infra-deploy-role` gains the change-set `Describe`/`Execute`/`Delete`
statements scoped to the Runtime stack and its change-set ARNs. Both are read or
operation-scoped; no managed policy or account-wide grant is added.

### Stage contract

[`lib/contracts.mjs`](lib/contracts.mjs), with declarations at
[`lib/contracts.d.mts`](lib/contracts.d.mts), is the dependency-free source of the
stage-contract names/kinds, the stack identities, the deployed-template
normalisation, the task-definition identity and the 300-second bake gate's one
stage-free threshold table and name builders. It is ordinary repository source:
the CDK app, the operation scripts and the tests import it directly, so there is no
package boundary, no `file:` dependency, no registry artifact and no build step.
`lib/stage-contract.ts`, the Runtime deploy and the bake consume or re-export it,
and `npm run check` runs its tests in [`test/contracts/`](test/contracts/).
[`test/contracts/identity.test.mjs`](test/contracts/identity.test.mjs) recomputes
the 31 value exports, the 35/1/36 parameter counts, the 300/15/20/15 bake
constants and the canonical value hashes against
[`test/fixtures/contracts-v0.7.0-identity.json`](test/fixtures/contracts-v0.7.0-identity.json),
which records the identity of the retired 0.7.0 producer as dated history.

Issue #191 retired the former versioned package and its publication path: there is
no version bump to perform and no tag to push. Change the contract in place in a
reviewed diff; after an intended value change, regenerate the fixture with
`node test/support/contracts-identity.mjs` and review the fixture delta with the
change.

Issue #207 retired the operation/deployment evidence chain: there is no
`anywear_infra_operation`, `anywear_infra_verified_inputs`,
`anywear_infra_release_inputs`, `anywear_infra_deployment`,
`anywear_infra_family_observation` or `anywear_service_deployment` record, no
`.sha256` companion and no `record` job, and the stage contract no longer
exports their validators. An operator audits an operation from platform facts: the
run and its job/step conclusions, the GitHub Environment deployment, CloudFormation
stack events and stack status, the immutable release tag→commit with per-asset
digests, the ECR image digest and the live `/health` and `/readyz` endpoints.

## Operations

Infra exposes **3 entries / 2 manual dispatch surfaces / 1 switch**
(`ENABLE_BETA_MUTATION`): one automatic source check and one manual operation
chain per deployable unit. `production.yml` stays in the tree but is
`workflow_call`-only, so it is not an entry.

| Entry | Trigger | Purpose |
| --- | --- | --- |
| [check.yml](.github/workflows/check.yml) | PR / push `main` | CDK build and tests, contract/workflow tests, live-Foundation comparison and both source matrices; no dispatch surface |
| [runtime.yml](.github/workflows/runtime.yml) | manual `operation: state` | `state`: fixed AWS read-only state/SSM status, usable with the stage switch closed, no tasks, no mutation and no artifact |
| [mutate.yml](.github/workflows/mutate.yml) | manual `operation` (12 options) | `deploy-foundation`, `deploy-billing`, `deploy-platform`, `deploy-egress`, `delete-egress`, `deploy-runtime`, `stop-runtime`, `restore-release`, `migrate`, `admission-status`, `add-testers`, `set-testers`. Every run is one `preflight` → `verify` → `deploy` chain, and a `deploy-runtime` run adds `qualify-hook` after a successful `deploy`; the release bytes travel as `service-release-bytes-<run_id>-<run_attempt>` and the published digests as the `verify` output. `delivery_trigger` and `dispatched_by` are accepted only by `deploy-runtime`, and the hook dispatches the E2E qualification without waiting for it. The run's job and step conclusions are the verdict |
| [production.yml](.github/workflows/production.yml) | `workflow_call` only | Future Production scaffold with its tested pre-AWS blocker; not a dispatch entry until a separately reviewed onboarding PR completes its contract |
| [bin/infra.ts](bin/infra.ts), `deployScope=foundation` | CLI | Separate Foundation-only initial role bootstrap; no Service artifact input is required |
| [bin/infra.ts](bin/infra.ts), `deployScope=billing` | CLI | Separate account billing scope in `us-east-1`; application resources are not synthesized |
| [bin/infra.ts](bin/infra.ts), `deployScope=egress` | CLI | Separate disposable `AnyWearEgressStack-beta` scope; no Service artifact input |
| [migrate-beta-split.mjs](scripts/migrate-beta-split.mjs) | CLI (Deployment-gated) | One-time Base/Runtime split: three separately authorized stages, validation-only by default; see its runbook |
| [ecr-retention.mjs](scripts/ecr-retention.mjs) | CLI | Verify exact effective policy, protected current/rollback digests and completed expiration preview |
| [prove-release-bytes.mjs](scripts/prove-release-bytes.mjs) | CLI (deploy step) | Prove the travelled release bytes against the published digests and load the schema asset before any credential |

The `mutate.yml` menu is a superset of the retired per-family files. A dispatch
surface is per workflow, so `identity_phase`, `retention_protection`,
`tester_emails`, `service_artifact_tag`, `service_commit`, `delivery_trigger` and
`dispatched_by` are workflow-level inputs; `scripts/runtime-operation.mjs`
enforces their per-operation scope in preflight, before any credential. Only a
`deploy-*` operation or `restore-release` may vary identity phase and retention
protection; every other operation must run the `retired` / `true` context. Only
`add-testers` and `set-testers` accept a tester payload. Only `deploy-platform`,
`deploy-runtime`, `restore-release` and `migrate` take a Service artifact
identity. Only `deploy-runtime` takes the deploy chain's context: a merge sends
`delivery_trigger=deploy` with the dispatching run's HTTPS URL as `dispatched_by`,
a human sends the `manual` default with no run URL, and `release` is refused in
the credential-free preflight so a tag-shaped dispatch fails loudly. The other
eleven operations refuse a trigger that names an entry event. There is no
admission-mode or bound input: the only admission value is the exact
tester allowlist. The
standalone `verify` operation is retired: Infra's operation chain runs no
cross-repository release-verification task. The `verify` family remains for exactly
one use — the schema-boundary gate's bounded, read-only `schema-journal` probe
(`beta-anywear-verify`) before a Runtime mutation — and `artifact-verify` stays the
E2E qualification executor's one-shot family.

`mutate.yml` is one credential-timing chain: `preflight` (no environment, no
`id-token`, no App token; rejects a forbidden operation and an unexpected artifact
identity before any credential) → `verify` (**the only job that reads the Service
release**: read-only App token only when the operation takes a Service release,
`contents: read`, no environment and no OIDC; it reads the release and tag ref
over the REST API, downloads the operation's consumed set — three stage-base
files, or only `service-schema.json` for `deploy-runtime` and `migrate` —
publishes those bytes as `service-release-bytes-<run_id>-<run_attempt>` and
publishes the digests as its `release_assets` output) → `deploy` (**the only job**
that holds an AWS
credential: `environment: beta`, `id-token: write`, `INFRA_DEPLOY_ROLE_ARN` and
`INFRA_RUNTIME_ROLE_ARN`, scheduled after `verify`; its first step is
`prove-release-bytes.mjs`, which re-derives the dispatch, requires the digest
output to be exactly the operation's asset set, hashes each travelled file and
strictly loads the schema asset or runtime policy **before** the step that
requests the OIDC token) → `qualify-hook` (**a `deploy-runtime` run only, after
`deploy` succeeded**: it declares no environment, holds no `id-token` and no AWS
permission, keeps `contents: read` and mints exactly one App installation token
narrowed to `AnyWear-E2E` with `actions: write` only; it lists the target's
`queued` and `in_progress` runs and dispatches nothing when this run's URL already
appears in one of their names, otherwise it calls the REST dispatch endpoint with
`return_run_details: true`, prints the created run's URL and verifies the created
run by the id the response names; only when that id is absent does it poll the
active-run names for this run's URL a bounded number of attempts before failing.
`delivery_trigger=deploy` sends E2E `full`
with `trigger=deploy-qualify`, `expected_service_commit=<service_commit>` and
`worker_slot_offset=0`; `manual` sends `smoke` with `trigger=deploy-smoke`, no
expected commits and `worker_slot_offset=0`; both carry `dispatched_by=<this run
URL>`, and neither waits). `runtime.yml` is `preflight` → `state`, where `state` is
the one credential job and runs with the stage switch closed.

Neither entry has an observation or record job. A mutation that landed and then
failed a later gate leaves a red run, and the failing step appends one
`$GITHUB_STEP_SUMMARY` line naming the stack it already changed, so "changed but
unqualified" is readable from the run itself; the [Beta
runbook](docs/runbooks/beta-infrastructure.md#evidence-and-operation-recovery)
carries the follow-up decision procedure. No step uses `continue-on-error`, so a
failed or partial operation can never read as complete.

Every Beta entry requires exact reviewed main and protected `beta`; the four
operations that take a Service artifact identity also require the reviewed
Service release tag and commit, and a `deploy-runtime` dispatch also carries the
deploy chain's `delivery_trigger`/`dispatched_by` pair, which the same
credential-free preflight proves. The release-identity read and the operation's
consumed download happen before AWS credentials, and each travelled file is
re-hashed once in the deploy job before its restricted STS session;
`deploy-runtime` and `migrate` additionally strictly validate the travelled
`service-schema.json` there, so neither the schema-boundary gate nor the
migration's launch reads an asset this pre-credential check has not already
proved. The sessions are
operation-specific and the read-only session carries no ECS or PassRole
permissions. Only mutation requires
`ENABLE_BETA_MUTATION=true`; read-only `state` remains available when it is
closed. Repository-local Actions concurrency (`anywear-infra-runtime`,
`cancel-in-progress: false`, `queue: max`) serializes Infra jobs and queues up to
100 pending runs instead of replacing them; separate Client and E2E writers still
require scheduling coordination and verified cessation. Existing OIDC trust
identifies Infra/environment, not workflow; these source/session boundaries do
not create an
IAM-enforced workflow trust boundary or restrict the capabilities of existing task
roles. The current CDK CloudFormation execution role uses `AdministratorAccess`
without a permissions boundary, so the deployment chain has account-wide
effective authority; the dedicated role names do not establish Beta resource
isolation. Production activation variables cannot bypass its source blocker; keep
both deployment/readiness gates disabled through #54.

Admission is one input and one decision. `/anywear/beta/tester_allowlist` is a
`String` parameter holding a JSON array of at most 50 exact email addresses within
4096 bytes; its stack default is `[]`. Cognito `PreSignUp` reads it once for every
`triggerSource`, with one attempt and a two-second deadline inside a ten-second
Lambda timeout, and admits exactly a normalized member. A missing, malformed,
oversized, unavailable or denied read refuses registration with the same message
and a distinct log reason. Registration is the only admission decision: no
authenticated API or task path reads the allowlist, and an account that exists can
use every feature whatever the list holds. There is no mode, no window, no expiry
and no second admission parameter.

The three surviving operations are `admission-status`, `add-testers` and
`set-testers`. A tester write (`add-testers` or `set-testers`) is one SSM write
through the deployed Service `set-testers` one-shot, with no admission or lifecycle
precondition; the run then reads the allowlist back from SSM and compares its count
and hash with the Service status line. `admission-status` prints
`{"operation":"admission-status","tester_count":N,"tester_allowlist_hash":"<64 hex>","matches":true}`
and nothing else about admission; a write prints the same count/hash proof for the
list it persisted. The hash is the lowercase-hex
`sha256(JSON.stringify(<normalized, sorted, unique, lowercase emails>))`, so the
status line and the SSM value are comparable without either surface carrying an
address.

Neither `migrate` nor `restore-release` nor `runtime.yml state` has an admission
precondition: the mode parameter is gone and none of the three reads it. `state`
reports the allowlist count and hash beside the stack facts. The pool keeps the
`custom:e2e_bootstrap` schema attribute (AWS cannot delete it), but it is inert:
no reader, no writer and not part of the app client's read attributes. The [Beta
runbook](docs/runbooks/beta-infrastructure.md#tester-allowlist-and-status) carries
the write/read-back contract and the registration failure modes.

Both manual entries share `anywear-infra-runtime` without cancellation, and
`mutate.yml` adds `queue: max` so a newer run waits behind an in-flight cloud
mutation instead of replacing the pending one (up to 100 pending, wait order, no
cancellation). Each run
leaves no artifact beyond the transport one: `service-release-bytes-<run_id>-
<run_attempt>`, whose only content is `.service-artifacts/selected/`, retained one
day, read by the deploy job's byte proof. It is a deploy input, not evidence: it
carries the Service release's own bytes, no AnyWear-authored JSON, no schema, no
producer identity, no verdict and no `.sha256` companion. The published digest set
is the `verify` job's `release_assets` output and is never written to a file or
uploaded. Everything else an operator needs is a platform fact: the run and step
conclusions, the Environment deployment, CloudFormation's own stack events, the
release's tag→commit and per-asset digests, the ECR image digest and the live
endpoints. The infrequent exceptions are documented and labelled: the frozen
account-recovery diagnostic in `AnyWear-E2E` replays one pinned historical run's
artifacts and reads no new run. See the [Beta
runbook](docs/runbooks/beta-infrastructure.md) for dispatch schemas, permissions,
lifecycle authority and recovery.

The accepted #54 IAM boundary is deliberately scoped: the named legacy Beta role
retains deny-only trust and zero inline or attached grants, while the inherited
Dev wildcard E2E subject, `cdk-*` assume-role chain and CloudFormation execution
role with `AdministratorAccess` and no permissions boundary remain unchanged.
Infra's operational queue is not an account-wide IAM exclusivity or Beta
resource-isolation claim. The practical pinned recovery was [stop
37886520975](https://github.com/git-malu/AnyWear-Infra/actions/runs/37886520975)
followed by [start 37887802281](https://github.com/git-malu/AnyWear-Infra/actions/runs/37887802281),
both at historical Infra producer `bafc3072ea6aee2d5193009c014cb1cf04b43848`
with Service release `407218593`. Active `restore-release` and automatic
failure recovery were not exercised; historical release `406706155` remains
preserved evidence but is byte-incoherent and unselectable.

The final correctness qualification is [E2E run
37949887097](https://github.com/git-malu/AnyWear-E2E/actions/runs/37949887097),
with correlated cleanup [Service run
37950914153](https://github.com/git-malu/AnyWear-Service/actions/runs/37950914153)
and admission closure [Infra run
37951949885](https://github.com/git-malu/AnyWear-Infra/actions/runs/37951949885).
These records retain the deployed Client `8320db0816b1c2d36e79a583160548744fd3d8c0`
and Service `ab211c8212444b735e614ef9a74f184d24744d6b` identities separately
from newer executor heads. Public registration remained intentionally skipped
while intake was closed; the recorded provider timeout/retry case is a
correctness observation, not a latency guarantee.

The stage base's Service-built Lambda assets come from a reviewed Service artifact
identity: `deploy-platform`/`restore-release` take `service_artifact_tag` and
`service_commit`, read the sealed artifact and its tag ref over the REST API,
require the two Lambda bundles and the runtime policy to be present, uploaded and
digest-valid (extras such as the retired legacy manifest are ignored), download
only those three, and re-hash each travelled byte once in the deploy job before
any credential. `deploy-runtime` and `migrate` take the same identity but download
only the release's `service-schema.json`: `deploy-runtime` re-hashes it once and
strictly validates it before credentials, then compares it with the live applied
journal before any stack mutation, while `migrate` runs that release as one
`beta-anywear-migrate` one-shot instead of deploying. The deploy resolves the
release tag, Service commit and the ECR digest of the immutable
`service-artifacts-<service_commit>` tag, and they are
readable from the run log and the stack's own parameters. There is no
committed selection, no release manifest, no vendored Service parser
and no cross-repository native-attestation path; publication ZIP/receipt/handshake
ceremony stays retired. See the
[direct artifact identity procedure](docs/runbooks/cutover-and-recovery.md#direct-artifact-identity).
