# Beta Stop and Start

Stop deletes two stacks; start recreates them in reverse order. Everything runs through
`AnyWear-Infra`'s `mutate.yml` — no console clicks, no local CDK. Starting Beta needs the
owner's explicit go-ahead; stopping does not.

This procedure is the **extended-idle** case, not Beta's normal state. Beta normally runs with `AnyWearEgressStack-beta` and `AnyWearRuntimeStack-beta` in place; stop is for a long idle period, and finishing start restores every resource to that normal state, in order (egress, then runtime).

## Stop (~8 min)

```sh
gh workflow run mutate.yml -R git-malu/AnyWear-Infra --ref main \
  -f operation=stop-runtime -f identity_phase=roles-added
# wait for green, then
gh workflow run mutate.yml -R git-malu/AnyWear-Infra --ref main -f operation=delete-egress
```

## Start (order matters)

Two dispatches. The runtime dispatch recreates the stack, repoints the API `CloudFront`
distribution's origin at the load balancer it just created, and then reads `/health`.

```sh
# the artifact to bring Beta up on. A stopped Beta keeps no stack that records it, so name
# it explicitly; the last green deploy-runtime run's summary prints the artifact identity it deployed.
SERVICE_ARTIFACT_TAG="service-artifacts-<commit>"
SERVICE_COMMIT="<commit>"

# 1. egress, reusing the retained EIP
gh workflow run mutate.yml -R git-malu/AnyWear-Infra --ref main \
  -f operation=deploy-egress -f nat_eip_allocation_id="$(aws ec2 describe-addresses \
      --region ap-east-1 --query 'Addresses[0].AllocationId' --output text)"

# 2. runtime — creates the stack, repoints the edge, bakes for 5 minutes, ends green
gh workflow run mutate.yml -R git-malu/AnyWear-Infra --ref main \
  -f operation=deploy-runtime -f identity_phase=roles-added \
  -f service_artifact_tag="$SERVICE_ARTIFACT_TAG" -f service_commit="$SERVICE_COMMIT"
```

**Why the runtime dispatch repoints the edge.** Issue #166 moved the distribution into the Platform
stack with a CloudFormation stack refactor, and a same-stack `Fn::GetAtt` origin is what made
the resource unmovable, so the origin cannot be a reference to the load balancer resource. The
design makes it a parameter of the Platform stack instead: the value stays recorded on the stack
that owns the distribution, and a `deploy-runtime` run sets that parameter to the load balancer
it just created — a new load balancer gets a new DNS name — before its `/health` read and its
bake. Its step log prints the old and the new origin, and the Platform stack's `LastUpdatedTime`
moves. There is no separate `deploy-platform` step in the start.

**Cold database.** The first `deploy-runtime` after a multi-day stop waits at the schema gate for
Aurora to resume from 0 ACU. The `schema-journal` one-shot's connect budget is 300 seconds (the
Service's `SCHEMA_JOURNAL_CONNECT_TIMEOUT_SECONDS`) — well above the "30 seconds or longer" that
AWS documents for a cluster paused more than 24 hours — so an ordinary resume records
`result=compatible` and the run continues. A resume that outlasts the budget refuses as
`reader-connect-timeout` and says the database did not answer in time: dispatch the run again,
because that attempt already started the resume. A refusal that names a schema reason
(`live-version-unproven`, `below-minimum-version`, `journal-entry-differs`,
`applied-beyond-release`, `below-minimum-migration-count`) is a code or migration decision that a
retry cannot change. A Service image released before issue #252 exits 3 on a connect timeout and
still reads as `reader-failed` with the `CONNECT_TIMEOUT` line in its task log.

## Optional: the daily E2E reconcile

While Beta is stopped the 03:17 UTC reconcile fails (it reads `/health` first). Nothing
accumulates and nothing is charged — it is dashboard noise only. Silence it if the stop
lasts more than a day:

```sh
gh workflow disable reconcile-schedule.yml -R git-malu/AnyWear-E2E   # after stopping
gh workflow enable  reconcile-schedule.yml -R git-malu/AnyWear-E2E   # after a green reconcile
```

## Check

| | Running | Starting, or edge unrepointed | Stopped |
| --- | --- | --- | --- |
| `curl -s -o /dev/null -w '%{http_code}' https://d1pfqujqt29n11.cloudfront.net/health` | 200 | 502 while a start's `deploy-runtime` runs, or after its edge repair failed | 502 |
| `AnyWearRuntimeStack-beta` status | `CREATE_COMPLETE` or `UPDATE_COMPLETE` | `CREATE_COMPLETE` or `UPDATE_COMPLETE`, and its `ApiLoadBalancerDnsName` differs from the distribution's origin | does not exist |

A 502 alone is not `Stopped`: read the Runtime stack's existence with it. That repair needs the
Platform stack's origin parameter installed, which one `deploy-platform` does; before that install,
a `deploy-runtime` dispatch refuses by name instead of repointing anything. Once it is
installed, a 502 with the Runtime stack existing and the parameter differing is repaired by
dispatching `deploy-runtime` again — it sets the parameter and re-reads `/health`.

## Three things that bite

- `stop-runtime` without `identity_phase=roles-added` is rejected — the default is `retired`.
- The runtime dispatch repoints the distribution's origin itself; do not insert a
  `deploy-platform` between the two dispatches, and do not read a 502 during the run as a
  failure of the start.
- The EIP must survive the stop; without it the next start gets a new outbound address.

Stacks, gates and evidence: [Beta infrastructure runbook](https://github.com/git-malu/AnyWear-Infra/blob/main/docs/runbooks/beta-infrastructure.md).
Costs: [Beta cost controls](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/finOps/beta-cost-controls.md).
