# AnyWear Infra agent instructions

This repository owns shared AWS infrastructure and environment operations after
the verified #54 cutover. It owns the account-wide Foundation and Billing stacks
and the Beta stage's persistent `Base` stack (`AnyWearPlatformStack-beta`), plus
the disposable `Egress` stack (`AnyWearEgressStack-beta`). Infra also owns
the release slice (`AnyWearRuntimeStack-beta`, formerly `AnyWearWorkloadStack-beta`),
its CDK source and its deploy chain; no other repository synthesizes, deploys or
recovers that stack. AnyWear-Service
remains the application, migration, verification and immutable artifact
publisher. Earlier Service-side bootstrap authority is historical evidence only
and must not be relabeled as an Infra-produced deployment.

- Read the accepted ownership ADR and deployment contracts before modifying
  infrastructure. Keep proposed targets separate from observed implementation.
- Preserve existing stack names, construct/logical IDs, physical resources,
  endpoints, outputs and runtime-owned configuration through extraction.
- Service owns application/Lambda/migration/verification source and immutable
  artifacts. Do not generate the shared API or read mutable peer `main` as a
  deployment input. Client publishes independently through deployed interfaces.
- There is no committed selection and no cross-repository native-asset
  verification path. `deploy-platform`, `deploy-runtime`, `restore-release` and
  `migrate` take one reviewed Service artifact identity (`service_artifact_tag` +
  `service_commit`), read the sealed artifact and its tag ref over the REST API,
  require the release's schema declaration (`service-schema.json`) plus the two
  Lambda bundles and runtime policy to be present, uploaded and digest-valid
  while ignoring extras such as the retired legacy manifest, and prove the
  release before any credential. `deploy-platform` and `restore-release`
  download the three stage-base files and prove each travelled byte once in the
  deploy job; `deploy-runtime` downloads only `service-schema.json`, re-hashes it
  once in the deploy job, strictly validates it as a consumer, and the
  schema-boundary gate compares it with the live applied journal before any
  stack mutation. `migrate` consumes exactly the same `service-schema.json` and
  runs the release it names — the tag, Service commit and ECR digest resolved in
  this run, whether or not that release is deployed — as one
  `beta-anywear-migrate` one-shot with `["node","dist/migrate.js"]` under the
  existing migration task role, instead of deploying a stack; it reads Beta's
  stacks only to refuse a stopped or racing environment by name, including
  `migrate requires AnyWearEgressStack-beta; Beta is stopped, run its start
  sequence`, and never chooses an image from a stack. The deploy resolves the
  release tag, Service commit and the ECR digest of the immutable
  `service-artifacts-<service_commit>` tag into its step
  log and the stack's parameters. No
  Service-built artifact is committed here. Every other operation rejects an
  artifact identity.
- There is no operation or deployment record (#207). An operation is audited from
  platform facts: the run and its job/step conclusions, the GitHub Environment
  deployment, CloudFormation stack events and status, the immutable release
  tag→commit with per-asset digests, the ECR image digest and the live `/health`
  and `/readyz` endpoints. A mutation that landed before a later gate refused
  leaves a non-success run and one `$GITHUB_STEP_SUMMARY` line naming the stack it
  changed; no step uses `continue-on-error`, and nothing reports the operation
  complete. The one artifact a mutating run publishes is the transport
  `service-release-bytes-<run_id>-<run_attempt>`, containing only
  `.service-artifacts/selected/` and retained one day: it is a deploy input, not
  evidence.
- `lib/contracts.mjs` (declarations `lib/contracts.d.mts`, tests in
  `test/contracts/`) is ordinary repository source and the single source of the
  stage-contract names/kinds, stack identities, the deployed-template
  normalisation, the task-definition identity and the bake gate's stage-free
  constants and name builders. The CDK app, the operation scripts and the tests
  import it directly; there is no package boundary, no `file:` dependency and no
  publication step. `npm run check` runs its tests, and
  `test/contracts/identity.test.mjs` recomputes the value identity from the
  committed fixture. Change it in place in a reviewed diff; regenerate the fixture
  with `node test/support/contracts-identity.mjs` only for an intended value
  change.
- Do not claim repository branch protection when the private plan cannot enforce
  it. The configured Beta environment restricts the branch to main. Apply the
  independently reviewed exact source/inputs and operational coordination
  with one writer; these are distinct from repository branch protection.
- Use `gh` for GitHub and `aws` for AWS. Verify account, profile and region before
  cloud commands. Run package/build commands only within this repository.
- Before AWS mutations, verify protected main/workflow, explicit operation,
  account/region, the reviewed Service artifact identity when the operation takes
  one, identity phase, retention protection and rollback inputs. Use one Infra
  runtime queue. Enumerate conflicting Actions, local processes, CloudFormation
  operations and ECS/helper tasks; timeout does not establish cessation. Repository
  concurrency is not a cross-repository lock; migration rollout stays separately
  coordinated.
- Issue #166: Beta is three stacks with disjoint lifetimes. `Base`
  (`AnyWearPlatformStack-beta`, physical name retained) holds the VPC and its
  subnets plus each subnet's route table and association, Aurora, S3, Cognito,
  ECR, SQS, SSM params and both CloudFront distributions and is persistent;
  `Egress` (`AnyWearEgressStack-beta`) holds the NAT, EIP, the 0.0.0.0/0 default
  routes in the Base-owned private route tables and the S3 gateway endpoint and
  is deleted on stop (it creates no route table and no subnet association);
  `Runtime` (`AnyWearRuntimeStack-beta`, Infra-owned since #195) holds ALB, ECS
  services/task definitions, log groups and the cleanup operation and is deleted
  on stop. There is no `environmentRunning` switch, no `BetaActive` output and no
  stopped template. Beta run state is one fact: whether the Runtime stack exists.
  Stop deletes Runtime then Egress; start recreates Egress then Runtime, and
  `restore-release` requires Runtime to exist ("start first"). A Base mutation
  still reads Runtime terminal first (one writer); a missing Runtime is the
  stopped state, not an inactive variant to maintain.
- The Base stack publishes `api_base_url` and retains Aurora, both S3 buckets,
  the Cognito pool, the ECR repository and both CloudFront distributions
  (`DeletionPolicy`/`UpdateReplacePolicy: Retain`). The API CloudFront
  distribution moved from the Service stack into Base with a one-time reviewed
  CloudFormation stack-refactor MOVE; its logical ID is pinned in
  `lib/api-distribution.json` and its origin is the live API load-balancer DNS
  name, passed as the `ApiOriginDomainName` stack parameter every Base deploy
  sets (`deploy-platform`, `restore-release`, and a `deploy-runtime` that
  repoints the edge), never a same-stack `Fn::GetAtt` — a same-stack reference
  is what made the resource unmovable. The one-time
  migration (`scripts/migrate-beta-split.mjs` + its runbook) is never automatic,
  defaults to validation-only, and is a Deployment-stage action.
- Issue #166 keeps the three bounded Beta entries in the
  [operations catalog](README.md#operations): `check.yml` is automatic;
  `runtime.yml` is the manual `state` entry,
  where `state` is read-only with restricted STS credentials, works with
  `ENABLE_BETA_MUTATION` closed and publishes no artifact; `mutate.yml` is the
  single manual mutation entry
  and rejects cross-family or out-of-scope inputs before credentials. Since #207
  every mutation runs `preflight` → `verify` → `deploy` in one run and has no
  `observe` or `record` job: `deploy` is the only job that holds an AWS
  credential, and its first step proves the travelled release bytes against the
  published digests before the first OIDC request. Since #226 a `deploy-runtime`
  run adds `qualify-hook` after a successful `deploy`: no environment, no
  `id-token`, no AWS permission, `contents: read` and one App installation token
  narrowed to `AnyWear-E2E` with `actions: write` only, dispatching the E2E
  qualification without waiting for it. `delivery_trigger` and `dispatched_by` are
  accepted only by `deploy-runtime` and proved in the same credential-free
  preflight: `deploy` requires the dispatching run's HTTPS URL, `manual` requires
  no URL, `release` is refused there because the release chain never deploys, and
  the other eleven operations refuse a trigger that names an entry event.
  `deploy-egress`/`delete-egress`
  change only the operation-owned `AnyWearEgressStack-beta`; `delete-egress`
  refuses unless the Runtime stack is absent. `production.yml`
  is `workflow_call`-only and is not an entry. The three tester operations are
  `admission-status`, `add-testers` and `set-testers`; the exact tester allowlist
  is the only admission input and a tester write is one SSM write with a
  count/hash read-back, with no admission or lifecycle precondition. Preserve
  session restrictions for
  final qualification and the protected-executor boundary. Existing OIDC trust is
  repository/environment scoped, not workflow
  scoped; source/session checks do not narrow inherited task-role or downstream
  CDK authority.
  Initial `deployScope=foundation`
  bootstrap is a separately assigned operator allocation and needs no Service
  artifact. Never use `cdk bootstrap`, broader trust, shared-role fallback or new
  permissions to make a blocked bootstrap/consumer operation succeed.
- Since #195 `deploy-runtime` and `stop-runtime` are the only mutation paths for
  the release slice (`AnyWearRuntimeStack-beta`); AnyWear-Service carries no CDK
  source or deploy chain. `deploy-runtime` takes one reviewed Service artifact
  identity (`service_artifact_tag` + `service_commit`), downloads and validates
  the sealed artifact's `service-schema.json`, resolves the immutable ECR image
  digest, admits the pre-mutation schema boundary with one bounded read-only
  `schema-journal` verify task under the existing verification-task role,
  judges and executes the change set, runs the unchanged 300-second six-signal
  bake under the read-only runtime session, compares the deployed template hash and
  the five parameters with the requested deployment, and prints the bake result and
  the `/health` floor in the mutating job's step log; `stop-runtime`
  deletes only that stack,
  and an absent stack is its accepted no-op. The historical runs below evidence
  the pre-#195 path only: Service run 39137577023
  ("Service release: deploy", `workflow_dispatch`, success, 2026-10-18T14:47:35Z)
  and the Infra `deploy-foundation` runs at 12:48:21Z, 12:22:55Z, 11:02:38Z and
  07:33:47Z belonged to the Service-owned slice and its release chain, which no
  longer exists. Issue #166 renamed that slice to `AnyWearRuntimeStack-beta`;
  older references use its then-name `AnyWearWorkloadStack-beta`.
- Every CLI scope requires explicit `legacyRoleSource=cdk|external`.
  `cdk` reproduces the Service source fixture; never use it as the live
  account plan. Foundation in account `650880818323`/`ap-east-1` owns only its
  existing provider/helpers. Live `external` leaves Dev/Beta legacy roles outside
  Foundation and Production absent, without import/adoption. Runtime always uses
  external. Later `identityPhase=retired` cannot retire external Beta trust or its
  unmanaged policy; a separate effective IAM writer/readback must do that.
- Dedicated roles separate direct responsibilities. The existing CDK execution
  role has `AdministratorAccess` and no permissions boundary: Infra deployment
  has transitive account-wide authority, not Beta resource isolation. Review
  effective bootstrap/inline/managed policies, including unmanaged
  `AnyWearBetaPipelineBaseline`, before retirement; synth alone cannot prove IAM.
- The Beta stage base is published as SSM parameters under `/anywear/beta/`. Two
  of those values are reviewed constants, not Platform resources: the VLM config
  secret ARN and the AWS-managed CloudFront origin-facing prefix list id. Change
  the constants only in a reviewed diff; `deploy-runtime` reads them from the
  stage contract and passes them as the Runtime template's two plain parameters.
  Since #195 the Runtime stack deploys through the existing
  `beta-infra-deploy-role` and the standard CDK bootstrap path
  (`cdk-hnb659fds-deploy-role`, `-file-publishing-role`, `-lookup-role` and the
  `cdk-hnb659fds-cfn-exec-role-<account>-<region>` execution role), under the
  operation's own change scope and preflight — not an IAM isolation claim the
  bootstrap path does not provide. The bake's two read-only statements live on the
  existing `beta-infra-runtime-role` (`cloudwatch:DescribeAlarms` on
  `beta-anywear-*`; `logs:FilterLogEvents` on `/anywear/beta/worker`), and the
  deploy role gains only the change-set `Describe`/`Execute`/`Delete` statements
  scoped to the Runtime stack and its change-set ARNs. The two per-service
  deployment roles are retired in source; issue #199's separately authorized
  `deploy-foundation` removed the live remainder, so the live Foundation defines
  neither role nor either default policy, and the live read-backs are recorded on
  issue #199. The Runtime stack's CloudFormation execution role is the CDK
  bootstrap execution role, because the executed update that rebound it preceded
  the removal.
- The `infraServices` CDK context and the Foundation per-service deploy roles were
  retired by #195. A stale `infraServices` context now fails synthesis explicitly
  in `bin/infra.ts`, the synthesized Foundation no longer defines
  `beta-service-deploy-role` or `beta-service-deploy-cfn-role`, and the
  `lib/contracts.mjs` stage contract no longer exports the service-role naming
  helpers.
  `deploy-runtime`/`stop-runtime` are the replacement. The authenticated live
  Foundation carries none of the four retired resources: issue #199's separately
  authorized `deploy-foundation` removed both roles and both default policies,
  and the live read-backs are recorded on issue #199. The fixture no longer
  records a pending removal, and its `publication_verified` and
  `deployment_qualified` remain false.
- The accepted #54 IAM boundary is scoped: the named legacy Beta role has
  deny-only trust with zero inline or attached grants, and Infra owns the one
  operational Beta queue. The inherited Dev wildcard E2E subject, `cdk-*`
  assume-role chain and CloudFormation execution role with `AdministratorAccess`
  and no permissions boundary remain unchanged and outside this scope. Do not
  claim account-wide IAM exclusivity or Beta resource isolation.
- `identityPhase=legacy` and `ecrImageRetention=false` preserve the source
  baseline by default. Role additions, retention activation and old-role
  retirement require separate reviewed diffs/operations. Initial cutover keeps the
  live image, Client, Lambda bytes, runtime policy, endpoints and schema behavior.
- Production activation/onboarding remains outside #54. Keep its deployment and
  readiness gates disabled; its source blocker must fail before AWS credentials
  even if an activation variable changes. A separately reviewed onboarding PR
  must establish the target account, runtime and verifier contract before removing
  that blocker. Do not add Production roles or broaden bootstrap in #54.
- Preserve other contributors' work. Keep one deployment writer per environment
  and verify that prior mutations have ceased before handoff.
- Review diffs, run `git diff --check`, and complete repository checks before
  publishing. PR merge alone does not establish deployed acceptance.
- Never commit credentials, runtime secrets or unredacted cloud diagnostics.

## Required source checks

Use Node.js 24 and npm within this repository for package commands.

```sh
npm ci
npm run audit:prod
npm run check
node scripts/create-test-inputs.mjs
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --output cdk.matrix
node scripts/synth-matrix.mjs --artifact-directory .service-artifacts/test --baseline-templates test/baselines --retention-protection true --output cdk.protected.matrix
git diff --check
```

Also synthesize the live Foundation with `deployScope=foundation`,
`identityPhase=roles-added`, `legacyRoleSource=external`, account `650880818323`
and application region `ap-east-1`, then run `scripts/compare-live-foundation.mjs`
against that output. CI preserves the actual CLI template and comparison. The
authenticated Original fixture permits exactly six dedicated roles/three policies
(the runtime role's #195 bake reads live in its existing DedicatedPolicy);
only fixed pseudo-parameter equivalence and declared CDK diagnostic metadata
differences are normalized. Provider/helper code, output and IAM changes fail.

`npm run check` runs CDK build/tests and Node contract/workflow tests. The production
dependency audit allows only the script's finite, dated exceptions; do not silently
renew them. Source matrix exceptions are exact Lambda asset locations, enumerated
Beta identity changes and explicitly selected retention activation. Unexpected
resource/output/endpoint/topology changes fail the gate. Original deployed CFN
templates and physical inventories remain an independent release check.

Both source matrices cover all three identity phases. The second explicitly
sets retention protection; review both `cdk.matrix/comparison.json` and
`cdk.protected.matrix/comparison.json`, which CI uploads together.

Review the [Beta runbook](docs/runbooks/beta-infrastructure.md) and
[cutover/recovery runbook](docs/runbooks/cutover-and-recovery.md). The accepted
#54 qualification is [E2E run 37949887097](https://github.com/git-malu/AnyWear-E2E/actions/runs/37949887097),
attempt `1`, against reviewed E2E main `b60f2e26adec9ed7c03ee9e671099213321fbb99`;
its correlated Service cleanup is [run 37950914153](https://github.com/git-malu/AnyWear-Service/actions/runs/37950914153),
and final admission closure is [Infra run 37951949885](https://github.com/git-malu/AnyWear-Infra/actions/runs/37951949885).
This evidence verifies correctness for the recorded tuple, not a latency SLA.
Preserve source maps, original component/build provenance, the run ids and their
job/step conclusions, and exact run/attempt/artifact hashes before workspace cleanup.
