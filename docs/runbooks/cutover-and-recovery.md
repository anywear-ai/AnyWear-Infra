# Infrastructure cutover and recovery

This is a reviewed procedure for [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54),
not a record of completed AWS actions. Record execution, original resources,
release decisions and exact recovery outcomes in the issue and protected run
artifacts. The [Beta operation runbook](beta-infrastructure.md) owns normal inputs.

The procedure's accepted #54 boundary is now recorded: Infra owns the sole
operational Beta queue, while Service owns application/migration/verification
source and immutable artifacts. The named legacy Beta role has deny-only trust
with zero inline or attached grants. This does not claim account-wide IAM
exclusivity or Beta resource isolation; the inherited Dev wildcard E2E subject,
`cdk-*` assume-role chain and CloudFormation `AdministratorAccess` execution
role remain outside scope.

## Foundation-only bootstrap

The initial artifact publisher role must exist before Service can produce sealed
inputs for application CDK. In a separately assigned Foundation/account-IAM
operator allocation, check out the reviewed full Infra source, verify AWS account and
`ap-east-1`, and compare the existing Foundation Original template, physical map,
effective OIDC/role policies and proposed synth. `deployScope=foundation` omits
application/Billing construction and skips the Service artifact loader:

```sh
npm ci
npm run build
npx cdk synth AnyWearFoundationStack -c deployScope=foundation -c identityPhase=roles-added \
  -c legacyRoleSource=external
```

After review of that exact source/diff and recording the operator/writer window,
the existing authorized operator can reconcile only Foundation:

```sh
npx cdk deploy AnyWearFoundationStack --exclusively \
  -c deployScope=foundation -c identityPhase=roles-added -c legacyRoleSource=external \
  --require-approval never
```

All CLI entry points require explicit `legacyRoleSource=cdk|external`.
`cdk` is the separately identified Service source/simulation baseline; it is
not the deployed-account ownership mode. The live Foundation Original contains
only the provider/helpers/metadata. Dev belongs to `AnyWearInfraStack-dev`, Beta
is outside Foundation, and no Prod pipeline role exists. `external` is limited to
account `650880818323`/`ap-east-1`, keeps those external identities untouched, and
creates only the six dedicated roles plus two Foundation policies. There is no
import/adoption or automatic legacy-role retirement. Ordinary runtime hardcodes
this same external mode for all CDK construction, avoiding a later collision.

This creates the six dedicated roles while retaining the old Beta trust/grants.
Read back roles, immutable OIDC subjects and effective policies before configuring
consumers. Keep the old executor usable until its jobs and rollback obligations
have ended. Ordinary `mutate.yml` deployment later requires the reviewed sealed
Service release identity; that requirement does not apply to this explicit
Foundation-only operator path.
`deployScope=billing` similarly synthesizes only Billing and requires its separately
assigned `us-east-1` window.

Use existing authorized operator credentials for bootstrap. Do not run `cdk
bootstrap`, create a wider deployment policy, expand bootstrap trust, substitute a
shared principal or onboard Production to resolve a missing role/input.

The baseline CDK CloudFormation execution role has `AdministratorAccess` and no
permissions boundary. The new deploy role's exact bootstrap-role assumption list
therefore leads to transitive account-wide deployment authority. Direct runtime,
Client, Service and E2E policies are narrower; the deploy chain is not a Beta
resource security boundary. Inventory the deployed bootstrap assume/pass chain,
inline/managed policies and execution role before authorizing that chain. A future
permissions-boundary/bootstrap redesign needs its own accepted scope and diff.

## Direct release identity

After #158 step C there is no committed selection and no cross-repository native
asset verification. `deploy-platform`, `deploy-runtime`, `restore-release` and
`migrate` take one reviewed Service release identity (`service_release_tag` +
`service_commit`). A source PR
reviews the tag and the Service commit; the release and its tag ref are then read
over the REST API with a read-only token (the tag must resolve to that commit,
`draft=false`, `immutable=true`, and the operation's consumed files must be
present, uploaded and digest-valid; extras such as the retired legacy
manifest are ignored), and only those files are downloaded: the two Lambda bundles
and the runtime policy (`pre-sign-up.zip`, `post-confirmation.zip`,
`runtime-policy.json`) for the stage-base operations, and only
`service-schema.json` for `deploy-runtime` and `migrate`. The deploy job
re-hashes each travelled byte once against those published digests before any
credential, then resolves the release tag, Service commit and the ECR digest of the
immutable `service-artifacts-<service_commit>` tag into the deploy's log and the
stack's parameters. Every other operation rejects a release identity. No operation
writes a deployment record (#207): the run, the Environment deployment, the
stack's own events and the release/ECR identities are the audit facts.

The protected Beta job first checks exact main/workflow/account/region and
operation, plus the release identity only for `deploy-platform`, `deploy-runtime`,
`restore-release` and `migrate`,
with explicit identity/retention only for CDK families and fixed protected source
context for other entries. It then reads the release identity and downloads the
files it consumes, and the deploy job immediately re-hashes each downloaded
byte once before any credential, and only then obtains
operation-specific restricted AWS OIDC sessions. Final qualification also uses a restricted session, not a role-wide
credential action. The CLI
uses a fresh external empty config and fixes telemetry off, excluding ambient
credentials, debug/config/Git/Node overrides. Source CI pins CLI 2.101.0 and
reproduces its original relative device-id write in a credential-free isolated
Linux network namespace; the fixed environment must preserve strict clean source.

A direct invocation uses the same reviewed inputs through the workflow:

```sh
gh workflow run mutate.yml --repo git-malu/AnyWear-Infra \
  -f operation=deploy-platform \
  -f service_release_tag="$SERVICE_RELEASE_TAG" -f service_commit="$SERVICE_COMMIT"
```

There is no publication Actions ZIP, executable candidate/receipt/handshake,
mandatory issue-comment URL, writer token or expiry field in this path. The
reviewed release tag/commit and the release-digest byte proof replace that ceremony. This source interface does not authorize the #54 cutover, which still
requires one rollout writer, resource cessation and the separately
reviewed maintenance/recovery plan. Foundation-only bootstrap remains below its
existing separately allocated operator boundary and requires no Service artifact.

## Bootstrap ECR retention without a sealed-input cycle

GitHub immutable releases do not stop ECR's count-based garbage collection.
Protect the existing current and required rollback digests before old-writer
retirement. The first sealed artifact publisher may require proof of the protected
policy before application CDK can consume that release. Break this cycle with a
bounded initial operator procedure, not wider bootstrap permissions.

In a separately reviewed ECR maintenance window, bind the exact account/repository,
policy content hash, current/rollback `(service_sha, digest)` list and existing
authorized operator. Freeze conflicting image publishers and deployments. Save
the original `get-lifecycle-policy` response, its exact `lifecyclePolicyText` bytes
and canonical hash, image/tag inventory and original policy absence if applicable.
Preserve this outside the removable worktree and in protected evidence.

The target Beta policy is exactly:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["protected-service-"],
        "countType": "imageCountMoreThan",
        "countNumber": 1000
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 30
      },
      "action": { "type": "expire" }
    }
  ]
}
```

Its canonical content SHA-256 is
`2d589aee6958df20f54de927bf1efc11db94e49c8516793d2c874cc97b57976e`.
This identifies the reviewed target text; authenticated readback must establish
that the effective repository policy has the same hash.

1. Verify each required digest is still present. Retrieve its exact OCI manifest
   with `ecr batch-get-image`; preserve exact manifest bytes and verify their hash
   matches the selected digest. Add `protected-service-<full-Service-sha>` with
   `ecr put-image` against those same bytes. Verify the returned digest and exact
   tag; an existing tag pointing elsewhere fails. Do not rebuild, upload layers,
   retag an unrelated image or replace immutable tags.
2. Inventory all images/tags and verify the protected digest count is at most 256.
   The priority-1 threshold of 1000 leaves at least 744 images of headroom. Tag
   ordering protects qualifying digests from the lower-priority any-image rule;
   protection remains contingent on the reviewed bound and exact effective policy.
3. Preview the reviewed target policy using `ecr start-lifecycle-policy-preview`
   with its exact policy text. Wait for `COMPLETE`, retrieve every preview result
   and reject any `EXPIRE` action for a current/rollback digest. Do not accept an
   in-progress/failed preview or partial paginated inventory.
4. The assigned existing operator applies only that reviewed policy with `ecr
   put-lifecycle-policy`. Re-read its canonical hash, exact tags and all required
   digests, preview the effective policy again, and verify the policy has not
   changed during preview. Preserve both policy readbacks and preview results.
5. Under explicitly authorized Infra execution, `node scripts/ecr-retention.mjs required-images.json`
   validates the same rules/tags/bounds and completed preview, using
   `ECR_RETENTION_VERIFIED_POLICY_SHA256` to bind the approved hash. The required
   file is an array of exact `service_sha`/`digest` objects. The runtime role can
   tag existing manifests and preview/read the policy; it cannot directly replace
   the policy or upload/delete images. Initial policy installation uses the
   separately assigned existing operator, not an expanded runtime role.
6. Publish/import the sealed Service baseline with the verified policy hash and
   protected current/rollback list, then deploy the stage base through the
   ordinary workflow described above with the reviewed Service release identity.
   Reconcile Platform later with the same live artifacts and explicit
   `ecrImageRetention=true`, so CDK owns
   the identical policy. Never deploy the default `false` context over the staged
   protection.

Recheck digest/tag presence, effective hash and preview immediately before
deployment/rollback and after any authorized image publication. If the inventory
exceeds the bound or any check changes, hold release/retirement and schedule
repair; never silently raise the threshold or discard a rollback digest.

If policy installation must be reversed, keep writers frozen, recheck that the
saved old policy would not expire required digests, and obtain the explicit
recovery writer for that exact original policy. Restore saved policy bytes
with the existing authorized operator, or restore absence only when absence was
the captured original state. Read back and hash the result, recheck digests and
record the failed protection attempt plus recovery result. Restoring a policy
does not restore an expired image. Keep new activation and old-role retirement
closed until a reviewed protection condition is available again.

## Application-preserving ownership cutover

Capture live Original CFN templates and physical resource maps independently from
the source-synth matrix. Preserve stack/construct/logical/resource identities,
SSM names and runtime values, exports, endpoints and unchanged database
behavior. The legacy `AnyWearInfraStack-dev` is outside this migration.

The baseline import retains independently proven component producers. Preserve
the already deployed Lambda ZIP bytes, their `index.js` and source maps, exact
bootstrap bucket/key, ZIP SHA-256/live `CodeSha256`, original protected build source,
lock/toolchain inputs and original run/attempt. A later recovery or equal source
contents does not invent build provenance. Keep imported image, policy and schema
producer sources separate from the release publisher's workflow SHA/run.

After roles and consumers are proved, freeze old Service infrastructure writers
and conflicting Client/E2E operations, verify cessation, then assign Infra one
runtime allocation. The first Infra reconcile uses the same live image, Client,
Lambda bytes and policy. Review real change sets/diffs against original physical
identities; source-matrix equality alone does not authorize a replacement.
Verify stable independent Client publication through existing CFN/SSM outputs.
Retain the original templates, selected assets and usable recovery writer.

Exercise reviewed `restore-release` as the Base recovery path; it deploys only
`AnyWearPlatformStack-beta` and leaves the Runtime slice to this repository's
`deploy-runtime` operation. It does not run down migrations and it never
verifies a candidate release. (The former `deploy-workload` path no longer exists
in Infra; #166 renamed the slice to `AnyWearRuntimeStack-beta`, and since #195 the
slice's CDK source and deploy chain are in this repository.)
`restore-release` requires an existing terminal Runtime stack ("start first")
before CFN, reads the Runtime terminal before and after its own deploy, and
redeploys only Base; stable stack status is required for the CloudFormation
mutation itself. It reads no admission state after #213: the tester allowlist
constrains registration only, so it is neither a precondition nor a postcondition
of a Base recovery. Failures preserve observed state and require an explicitly
reviewed recovery; no automatic sibling deploy or revert occurs.

Admission after #213 is one input: `/anywear/beta/tester_allowlist` (a JSON array
of at most 50 exact emails within 4096 bytes, default `[]`), read only by Cognito
`PreSignUp` at registration. There is no mode, no window and no expiry.
`admission-status` reads the tester count and hash through the deployed Service
lifecycle `status` command and compares them with one SSM read-back;
`add-testers`/`set-testers` perform one SSM write with no admission or lifecycle
precondition and the same read-back. `migrate`, `restore-release` and
`runtime.yml state` carry no admission precondition and read no admission state.

Current dispatches use `mutate.yml` for maintenance, `deploy-egress`/
`delete-egress` for the disposable network edge, and `restore-release`. Beta
stops by deleting Runtime then Egress and starts by recreating Egress then
Runtime; the persistent Base stack is never deleted and no stopped Base template
exists. After a change, read the run's job/step conclusions, the `beta`
Environment deployment and the scoped stack's CloudFormation events; E2E v3
qualification consumes no Infra record and observes the platform itself. Read-only
`runtime.yml` `state` remains available with the stage switch closed, including
recovery diagnosis, and cannot start tasks or qualify database/schema state.

At the time, the bounded #54 practical recovery was executed as [stop
37886520975](https://github.com/git-malu/AnyWear-Infra/actions/runs/37886520975)
then [start 37887802281](https://github.com/git-malu/AnyWear-Infra/actions/runs/37887802281),
both with historical Infra producer `bafc3072ea6aee2d5193009c014cb1cf04b43848`
and coherent Service release `407218593`. Both lifecycle entry points are retired,
and #166 replaced the resident direction with the three-stack stop/start, so that
sequence is preserved history, not current guidance. This
does not exercise `restore-release` or automatic failure recovery. Historical release
`406706155` remains preserved evidence but is byte-incoherent and cannot be selected
for current rollback. Do not relabel the observed Client/Service tuple or historical
Infra producer as a newer documentation or executor revision.

For an ownership failure, suspend the new writer, enumerate its running tasks/CFN
operations and verify cessation. Restore the recorded legacy source/templates/
assets with exactly one old recovery writer. Do not relabel original Service-era
evidence as Infra-produced. No retired strict sampler/drill matrix is reintroduced
as a #54 gate.

## Retirement and final qualification

After rehearsal and rollback acceptance, schedule Foundation/IAM retirement
separately from Beta runtime and billing. In the actual `external` ownership mode,
`identityPhase=retired` removes template-owned Platform grants and retains the
dedicated consumers; Foundation never owned the old Beta role, so this phase
cannot retire its trust or unmanaged `AnyWearBetaPipelineBaseline`. Those require
the separately reviewed IAM writer/diff/readback after old sessions cease. Dev
remains with its original stack, and Production remains absent. The `cdk`
source/simulation fixture's retired role is not a live retirement result.

Inventory and explicitly reconcile `AnyWearBetaPipelineBaseline`, all other
inline/managed attachments and bootstrap trust. Record exact intended removals
and read back effective authorization after the active executor and nested cleanup
helpers stop. Verify Service cannot assume CDK roles, Client cannot push Service
images/deploy CFN, and E2E cannot reconcile infrastructure. Retire Service CDK/runtime
entry points only after their recovery obligations and consumer migrations finish.

Observe new post-retirement Original templates and actual runtime identities from
the run's conclusions, the Environment deployment and the stacks' own events, then
run final
E2E v3 qualification in its scheduled window: it reads the deployed tuple and
takes its own authenticated before/after observations. Pre-retirement
rehearsal hashes cannot substitute. Preserve the run ids and conclusions,
sealed Service release identities, signed releases and publisher identities, authenticated
before/after observations and exact source/run/attempt/artifact hashes before root
registration, repository reconciliation or resource cleanup.

The accepted final correctness evidence is [E2E run
37949887097](https://github.com/git-malu/AnyWear-E2E/actions/runs/37949887097),
attempt `1`, with correlated Service cleanup [run
37950914153](https://github.com/git-malu/AnyWear-Service/actions/runs/37950914153)
and final admission closure [Infra run
37951949885](https://github.com/git-malu/AnyWear-Infra/actions/runs/37951949885).
The deployed Client `8320db0816b1c2d36e79a583160548744fd3d8c0`, Service
`ab211c8212444b735e614ef9a74f184d24744d6b` and historical Infra observer
`bafc3072ea6aee2d5193009c014cb1cf04b43848` remain distinct from the newer
qualification/cleanup executor heads. The suite intentionally skipped public
registration under closed intake; the observed provider timeout/retry case is a
correctness observation, not a latency SLA or a provider/network diagnosis.

Production deployment and readiness gates remain disabled. The workflow has a
source blocker before AWS credential assumption: changing an activation variable
cannot establish its missing target-account/runtime/verifier contract. A separately
reviewed onboarding PR must complete that contract before removing the blocker.
Future promotion also requires a sealed stable Service release, a completed-success
E2E v3 qualification whose record binds the reviewed release tuple and its own
authenticated observations, digest-preserving promotion and scan policy. Artifact
prereleases, legacy v1 records or a Beta bootstrap do not activate that path.
#54 makes no Production execution claim.

There is no inactive Base deployment path. Every protected Base deploy requires a
terminal Base stack and a terminal Runtime stack when Runtime exists; the
postcondition is exactly that observed state, not a `BetaActive` output. A Base
mutation fails closed while Runtime is non-terminal (one writer). Preserve actual
stack statuses and Runtime existence on failure.
