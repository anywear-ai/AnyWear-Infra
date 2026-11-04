# Runbooks

A runbook is a procedure a person or an agent executes against a changing system: it states the
inputs, the steps, the decision points, the verification and the exit criteria. It does not record
the outcome of one execution — that belongs to the issue that ran it and to the pull requests it
delivered.

These are this repository's procedures. They drive the reviewed entry points in the
[operations catalog](../../README.md#operations) or the AWS and CDK CLIs, and none of them changes
source.

| Runbook | Use it when |
| --- | --- |
| [Reviewed Beta infrastructure operations](beta-infrastructure.md) | you are dispatching or reading a reviewed Beta operation and need its inputs, the schema-boundary gate that runs before a Runtime mutation, admission, and the evidence and follow-up decision for a red run |
| [One-time Beta split migration](beta-split-migration.md) | you need the executed #166 split as evidence; it is a historical, Deployment-gated record that runs nothing by itself |
| [Infrastructure cutover and recovery](cutover-and-recovery.md) | a #54 cutover or recovery is required, including reading or recovering a direct artifact identity |
| [Database recovery drill](database-recovery-drill.md) | you need a stage's recovery targets, or you are running the drill that proves a restore is possible |
| [Beta stop and start](beta-stop-start-runbook.md) | Beta is being stopped or started by hand for an extended idle: two stop dispatches, two start dispatches in order, the edge-origin repoint the `deploy-runtime` run performs, the cold-database schema gate, the E2E reconcile to silence, and the check that separates a running, a starting and a stopped Beta |
