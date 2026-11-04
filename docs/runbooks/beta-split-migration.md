# Beta Base/Runtime split migration (one-time, Deployment-gated)

> **Historical record (pre-#195).** This one-time #166 migration was executed and
> is retained as evidence. Its `Owner` column and the two Foundation execution
> roles it names (`beta-service-deploy-role`, `beta-service-deploy-cfn-role`) no
> longer describe source: #195 retired both roles and moved the Runtime stack's
> CDK source and deploy chain into AnyWear-Infra (`deploy-runtime`).
>
> *2026-11-04 role-name correction ([AnyWear#255](https://github.com/git-malu/AnyWear/issues/255)):
> the role name `Base` in this executed record is `Platform` — `AnyWearPlatformStack-<stage>`, and
> `AnyWearPlatformStack-beta` for Beta — the name the CDK class `PlatformStack` and the operation
> `deploy-platform` use. The steps, stack ids and template names below are the executed history of
> #166 and are not rewritten.*

Issue #166 turns Beta into three stacks with disjoint lifetimes:

| Stack | CloudFormation stack | Owner | Lifetime |
| --- | --- | --- | --- |
| `Base` | `AnyWearPlatformStack-beta` (name retained) | AnyWear-Infra | persistent |
| `Egress` | `AnyWearEgressStack-beta` | AnyWear-Infra | deleted on stop |
| `Runtime` | `AnyWearRuntimeStack-beta` (replaces `AnyWearWorkloadStack-beta`) | AnyWear-Infra | deleted on stop |

The only resource that changes stack is the API CloudFront distribution: a
one-time CloudFormation stack-refactor MOVE from the Service-owned legacy stack
to `Base`, preserving its physical ID and therefore its `*.cloudfront.net`
domain. This runbook executes nothing by itself and is not part of the source
delivery. **Do not run any stage without the Deployment gate's explicit
authorization recorded in the issue.**

## Non-negotiable preconditions

- The issue worker has recorded the user's Deployment decision for #166 (accept
  the three-stack split and supersede #159's resident direction).
- A fresh live Beta tuple read-back exists: both stacks, the API distribution ID
  and domain, the live `ApiLoadBalancerDnsName`, and the Workload stack's
  parameters/conditions/mappings hashes.
- Admission is provably closed (`admission-status`), and no Beta deployment,
  lifecycle action, one-shot task or CloudFormation operation is in flight.
- One Beta writer is allocated. The protected `main`/workflow context, account
  `650880818323`, region `ap-east-1` and a reviewed Service release identity are
  verified before any credential.
- The Foundation change that scopes both Service deploy roles to
  `AnyWearRuntimeStack-beta` is not required for the MOVE itself but must be
  deployed before the Runtime stack is first created (issue step 8).
- **Step 8 must also deploy the Foundation-owned runtime-role read grants before
  M4.** `beta-infra-runtime-role` needs `cloudformation:DescribeStacks` and
  `cloudformation:GetTemplate` on `AnyWearRuntimeStack-beta` (permanent: reading
  an absent stack is a `ValidationError` that still needs authorization) and on
  `AnyWearWorkloadStack-beta` (transitional: only the pre-MOVE origin read). The
  live runtime-role policy comes from the Base stack's `DedicatedPolicy` and
  covers Foundation/Platform/Workload, not Runtime; the new Runtime grant inside
  the Base template is applied by the same M4 update that needs the pre-read.
  Verify the synthesized Foundation policy contains both stack ARNs before
  starting M4. The Workload ARN is removed only in a later reviewed Foundation
  deploy, after M3/M4 has deleted Workload and the Base literal-origin fallback
  is the only origin source; removing it earlier re-breaks a stopped-state
  `deploy-platform`.

## Stage A — Workload pre-move update

The live distribution's `Origin.DomainName` is a same-stack `Fn::GetAtt` of the
ALB, which is what makes the resource unmovable. Resolve it to the literal the
stack already uses (the live `ApiLoadBalancerDnsName`) and remove the
distribution's `DependsOn` residue on resources that stay behind. The moved
distribution is also referenced by the cleanup verification task definition's
`VERIFY_API_URL` environment entry (`CleanupOperationVerificationTaskDefinition*`,
first container, the recorded index); resolve that `https://` + distribution
`Fn::GetAtt` value to the literal `https://<apiDistributionDomain>` in the same
update, so the refactor source does not keep a dangling reference. The MOVE
compares source and destination resource properties/attributes, so the Workload
distribution must also carry `DeletionPolicy: Retain` and
`UpdateReplacePolicy: Retain` like the Base-pinned destination; absent attributes
are added, existing `Retain` values stay unchanged, and any other value refuses.
This is a minimal `update-stack` template delta: the in-place origin and
verify-URL rewrites (CloudFront documents "No interruption" for the origin update)
preserve the distribution ID and domain, and the stack keeps serving.

The pre-move `update-stack` must carry every live Workload parameter: four of
them (`ServiceImageDigest`, `ServiceCommitSha`, `VlmConfigArn`,
`CloudFrontPrefixListId`) have no defaults, so an update without `--parameters`
fails with "Parameters must have values". The apply path reads the live
parameter keys itself (and passes `UsePreviousValue=true` for each, never
inventing a value). The keys can also be recorded and passed explicitly:

```sh
# The live parameter keys (reviewed read; no value is republished).
aws cloudformation describe-stacks --stack-name AnyWearWorkloadStack-beta \
  --query 'Stacks[0].Parameters[].ParameterKey' --output json \
  > workload-parameter-keys.json
```

`update-stack --template-body` sends the template inline and CloudFormation caps
`TemplateBody` at 51,200 bytes; the live Workload template is far larger, so the
apply path uploads the delta to S3 and calls `update-stack --template-url`
(1 MB limit) instead. The reviewed location is the account's CDK assets bucket
`cdk-hnb659fds-assets-650880818323-ap-east-1`, key prefix
`migrations/166/pre-move-<UTC timestamp>.template.json`; the object is kept after
the update as evidence. The URL is
`https://<bucket>.s3.<region>.amazonaws.com/<key>`; the region comes from
`AWS_REGION` (default `ap-east-1`) or `--template-region`. The apply path refuses
a missing or invalid `--template-bucket` before any AWS call, and validation-only
mode needs no bucket.

Prerequisite for the private, account-owned template bucket: `update-stack
--template-url` fetches and validates the object with the **caller/operator's**
credentials, not the CloudFormation execution role. The stock assets-bucket
policy grants only the CDK bootstrap roles, so the reviewed path is an explicit
prefix-scoped bucket-policy statement for the `anywear-dev` operator profile
(which is not one of those bootstrap roles): it grants `s3:GetObject` and
`s3:PutObject` on
`arn:aws:s3:::cdk-hnb659fds-assets-650880818323-ap-east-1/migrations/166/*`.
The same operator principal performs the `aws s3 cp` upload and the
`update-stack` fetch/validation; a known key needs no bucket-wide list grant.
Apply that statement as a separately reviewed bucket-policy change before Stage A
and do not broaden it beyond the prefix. If the bucket uses SSE-KMS, the operator
also needs `kms:GenerateDataKey` for the upload and `kms:Decrypt` for the fetch on
the bucket's key.

Both the `aws s3 cp` upload and the `cloudformation update-stack` call must run in
`ap-east-1`, matching the URL region: pass `--region ap-east-1` to each command
(or export `AWS_REGION=ap-east-1` and `AWS_DEFAULT_REGION=ap-east-1`) under the
`anywear-dev` profile, because both commands otherwise use the ambient profile
region. The uploaded S3 object is retained as evidence; the script's local
temporary template file is not retained.

Stage A also depends on one reviewed IAM grant on the Workload stack's
CloudFormation execution role, `beta-service-deploy-cfn-role`:
`secretsmanager:GetSecretValue` on
`arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/cloudfront_origin_header-*`.
The API distribution's `OriginCustomHeaders` carries a
`{{resolve:secretsmanager:.../cloudfront_origin_header}}` dynamic reference;
CloudFormation re-resolves that reference on every update of the distribution
under the stack execution role, and this is the first distribution update under
the restricted role. The action is the only Secrets Manager permission on that
role and the resource is the one secret ARN suffix (no other secret or action).
It is required only for the one-time pre-move and is removed in a later reviewed
Foundation deploy after the MOVE deletes the Workload stack. The OIDC deploy role
`beta-service-deploy-role` keeps zero Secrets Manager permissions.

```sh
# 1. Validation only (default): builds the delta and prints the exact changes.
#    No AWS call and no --template-bucket required.
node scripts/migrate-beta-split.mjs --stage pre-move \
  --workload-template <live-workload-original.json> \
  --api-load-balancer-dns-name <live ApiLoadBalancerDnsName> \
  --api-distribution-domain <live ApiDistributionDomainName>

# 2. Separate explicit authorization; uploads the delta and applies it in place.
#    The script reads the live parameter keys from describe-stacks automatically;
#    pass --workload-parameters <describe-stacks.json | keys.json> to use the
#    recorded read instead. --api-distribution-domain is required for both modes
#    and must be a bare <id>.cloudfront.net domain (no scheme or path); it is
#    validated before any AWS call.
node scripts/migrate-beta-split.mjs --stage pre-move --apply \
  --workload-template <live-workload-original.json> \
  --api-load-balancer-dns-name <live ApiLoadBalancerDnsName> \
  --api-distribution-domain <live ApiDistributionDomainName> \
  --template-bucket cdk-hnb659fds-assets-650880818323-ap-east-1 \
  [--template-region ap-east-1] \
  [--workload-parameters <recorded-parameters.json>]
```

`--output <file>` writes the stage plan/result JSON; it requires a value.

Accept only when the planned change list is exactly the paths below (the origin
and verify rewrites are omitted for values already literal in a post-Stage-A
retry; the current live plan is exactly the two Retain attributes):

- `/Resources/<distributionLogicalId>/Properties/DistributionConfig/Origins/0/DomainName`
  (only when the live origin is the expected same-stack ALB `Fn::GetAtt`)
- `/Resources/<cleanupVerificationTaskDefinition>/Properties/ContainerDefinitions/0/Environment/<index>/Value`
  (the one `VERIFY_API_URL` entry; the value becomes the literal `https://<apiDistributionDomain>`)
- `/Resources/<distributionLogicalId>/DeletionPolicy` (added as `Retain` when absent)
- `/Resources/<distributionLogicalId>/UpdateReplacePolicy` (added as `Retain` when absent)
- `/Resources/<distributionLogicalId>/DependsOn` (removed; only when present)

Any other difference, a missing or duplicate `VERIFY_API_URL` entry, a
verification value that is neither the expected `Fn::Join`/`Fn::GetAtt` nor the
recorded literal URL, a non-`Retain` policy value, or any remaining reference to
the distribution outside its moved outputs refuses the update.

Read back the distribution ID, domain and `Deployed` status and the public
`/health` response. No other Workload property changes and no Service source
commit is needed for this stage.

## Stage B — Refactor preview (no resource mutation)

Eligibility, all required:

- `aws cloudformation describe-type --type RESOURCE --type-name AWS::CloudFront::Distribution`
  reports `provisioningType=FULLY_MUTABLE`.
- Neither stack has a stack policy.
- The moved resource references no `AWS::StackName` or other stack-varying
  pseudo parameter.
- Neither refactor template changes a parameter, condition or mapping relative
  to that stack's live template.

Synthesize Base at the same HEAD with the live origin:

```sh
npx cdk synth AnyWearPlatformStack-beta --quiet \
  -c deployScope=application -c stage=beta -c legacyRoleSource=external \
  -c identityPhase=retired -c ecrImageRetention=true \
  -c artifactDirectory=<verified Service release directory> \
  -c apiOriginDomainName=<live ApiLoadBalancerDnsName>
```

Then build the two templates and create the preview:

`StackDefinition.TemplateBody` has the same 51,200-byte cap as Stage A's
`update-stack` body; the serialized refactor source/target are larger, so the
`--apply` path uploads both templates and passes `TemplateURL` instead (that
field is length-bounded at 5,120, not the template body). The two reviewed keys
under the same private assets bucket are
`migrations/166/preview-<UTC>.template.json` (Workload source) and
`migrations/166/preview-<UTC>-base.template.json` (Base target); both objects are
kept as evidence. The preview apply requires `--template-bucket`, validates it and
the region (`--template-region`, else `AWS_REGION`, else `ap-east-1`) before any
AWS call, and aborts before `create-stack-refactor` if either upload fails. The
same bucket/operator permission and `ap-east-1` region prerequisites as Stage A
apply. Validation-only still needs no bucket and makes no AWS call.

```sh
# Validation only: builds the source/target templates and the one mapping.
node scripts/migrate-beta-split.mjs --stage preview \
  --workload-template <live-workload-original.json> \
  --base-template <live-base-original.json> \
  --base-synth-template <synth>/AnyWearPlatformStack-beta.template.json \
  --distribution-type <describe-type.json> \
  --output <preview-plan.json>

# Separate authorization: uploads both refactor templates, then
# create-stack-refactor validates and records a preview; execution is a separate
# call.
node scripts/migrate-beta-split.mjs --stage preview --apply \
  --workload-template <live-workload-original.json> \
  --base-template <live-base-original.json> \
  --base-synth-template <synth>/AnyWearPlatformStack-beta.template.json \
  --distribution-type <describe-type.json> \
  --template-bucket cdk-hnb659fds-assets-650880818323-ap-east-1 \
  [--template-region ap-east-1] \
  --output <refactor-preview.json>
```

The Workload source is the live template minus the distribution and its two
outputs (`ApiDistributionDomainName`, `ApiBaseUrl`). The Base target is the live
Base template plus exactly the moved distribution and those outputs, taken from
Base's synthesis with `-c apiOriginDomainName=<live ALB DNS>` — never Base's
full post-split synthesis, whose other changes belong to the next normal deploy.
The `--resource-mappings` entry maps the live source logical ID to the pinned
Base destination logical ID in `lib/api-distribution.json`.

Before `create-stack-refactor`, the script recursively scans the constructed
Workload source for any remaining `Fn::GetAtt` to the moved distribution outside
the removed outputs and refuses with the offending path. Stage A's
`VERIFY_API_URL` literal rewrite is what satisfies this guard; an unrewritten or
foreign reference aborts before any API call. The MOVE also requires the source
distribution's `DeletionPolicy`/`UpdateReplacePolicy` to match the Base-pinned
destination's `Retain`; Stage A adds those attributes, so a preview without them
fails the source/destination comparison.

`create-stack-refactor` returns lifecycle `Status=CREATE_IN_PROGRESS`; the
`ExecutionStatus` may remain `UNAVAILABLE` until validation finishes. The apply
path polls `describe-stack-refactor` every 10 seconds, up to 30 attempts (300
seconds total). It proceeds only when `Status` is `CREATE_COMPLETE` **and**
`ExecutionStatus` is `AVAILABLE`; a `CREATE_COMPLETE` with any other execution
status, `CREATE_FAILED`, any other non-`CREATE_IN_PROGRESS` status, or the
timeout refuses with the status/`StatusReason` before any actions read or execute
path. Only after that terminal success does it call `list-stack-refactor-actions`
and validate the preview.

Require `describe-stack-refactor` to report no unsupported resource and no
conflict, and `list-stack-refactor-actions` to show **exactly one MOVE** (the
distribution) with `Entity=RESOURCE`, the reviewed `PhysicalResourceId
E3U35871TUO53L`, and `ResourceMapping.Source`/`Destination` equal to the
Workload/Base stack and logical-ID pair (the live action uses full stack ARNs;
the script normalises the reviewed `arn:aws:cloudformation:ap-east-1:650880818323:stack/<name>/<uuid>`
form to the bare name, and also accepts bare names); no configuration change and
**no CREATE or DELETE**. Any other action, any reported difference or any
eligibility failure aborts before execution: the Workload keeps serving, the
environment is untouched, the migration returns for redesign, and a one-time
endpoint change remains an explicit user decision rather than a silent fallback.

## Stage C — Execute and read back

Only on a clean preview, and only with its own authorization:

```sh
node scripts/migrate-beta-split.mjs --stage execute --apply \
  --describe <describe-stack-refactor.json> \
  --actions <list-stack-refactor-actions.json> \
  --resource-mappings <resource-mappings.json> \
  --output <refactor-execute.json>
```

The readback below is followed by the remaining issue steps as separate
authorizations: update Base (`M4`), create Egress (`M5`), create Runtime (`M6`),
rewire the Base origin to the new ALB and verify `/readyz` plus identity (`M7`).

For **M4** both the Workload ALB and the Runtime stack are absent, so the Base
update takes no live ALB output: its API distribution origin is the literal
`Origin.DomainName` the pre-move update already wrote into the moved distribution
(the value is preserved by the MOVE). `scripts/runtime-operation.mjs`
`readApiOrigin` resolves in this order — the running Runtime stack's
`ApiLoadBalancerDnsName` (hard error if the stack exists but the output is
missing or not a DNS name), the literal origin read back from the Base stack's
Original template, then the legacy Workload output only while Base has no adopted
distribution (pre-MOVE) — and validates each as a domain. Base is read before
Workload so the stopped state after M4 never needs the transitional Workload
read. M7 then rewires the same distribution to the new Runtime ALB DNS.

For **M6**, the Foundation deploy must carry these grants on
`beta-service-deploy-cfn-role`:

- `states:TagResource` and `states:UntagResource` on the fixed cleanup state
  machine
  `arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup`
  because CDK applies the stack's tags on state-machine create/rollback;
- `ecs:DeregisterTaskDefinition` on `*` because the ECS API evaluates that action
  against `*` regardless of the task-definition ARN, so a family-scoped grant does
  not authorize rollback or stack deletion;
- `cloudwatch:PutMetricAlarm`/`DescribeAlarms`/`DeleteAlarms` on
  `arn:aws:cloudwatch:ap-east-1:650880818323:alarm:AnyWearRuntimeStack-beta-*`
  because the Runtime template's two CDK-auto-named queue-depth alarms use that
  prefix, which the existing `alarm:beta-anywear-*` statement does not match (the
  same evaluation that made them undeletable at M3); the nine explicitly named
  `beta-anywear-*` alarms stay covered by that existing statement;
- `elasticloadbalancing:CreateListener`/`DeleteListener`/`ModifyListener` on the
  load-balancer ARN `arn:aws:elasticloadbalancing:ap-east-1:650880818323:loadbalancer/app/beta-anywear-api/*`
  because ELB evaluates `CreateListener` against the load balancer, and the
  listener ARN does not exist at create time;
- `elasticloadbalancing:CreateRule`/`DeleteRule`/`ModifyRule` on the listener ARN
  `arn:aws:elasticloadbalancing:ap-east-1:650880818323:listener/app/beta-anywear-api/*`
  because ELB evaluates `CreateRule` against the listener, and the listener-rule
  ARN does not exist at create time.

All are separate Sid-tagged statements; the existing listener/listener-rule
statements remain for the update/delete paths, and every other Foundation
statement and the family-scoped task-definition statement stay unchanged.

## Abort behavior

Every refusal happens before the mutating call for its stage. A failed preview
mutates nothing and the environment keeps serving. A failed pre-move update is a
no-op unless CloudFormation reports it started; then use the stack's normal
rollback/continue path and record it. A failed execute is an explicit recovery
decision, not an automatic retry. Never run `--no-rollback`, never repeat a stage
without a fresh readback, and never delete the Workload stack until the
distribution readback is clean.

## What this source delivery did not do

No stage of this runbook was executed. No `aws` call, no `update-stack`, no
`create-stack-refactor`, no `execute-stack-refactor`, no stack deletion, no
distribution change and no Beta lifecycle/admission action happened while
delivering the source change. The unit tests run the pure builders and validators
against recorded-shape fixtures only.
