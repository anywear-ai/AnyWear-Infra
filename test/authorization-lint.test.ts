import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as path from 'node:path';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FoundationStack } from '../lib/foundation-stack';
import { PlatformStack } from '../lib/platform-stack';
import type { ArtifactInputs } from '../lib/artifact-inputs';
import runtimePolicies from './fixtures/runtime-policy.json';
import baselineJson from './fixtures/authorization-lint-baseline.json';

// The IaC policy lint (#165, narrowed by #214). cdk-nag's AwsSolutions-IAM5 is
// the only wildcard rule source: the test synthesizes the two stacks that carry
// the Beta IAM surface, compares the finding set with the pinned baseline in both
// directions, and compares the number of wildcard-bearing policy statements per
// stack. The count guard exists because cdk-nag reports one finding id per
// wildcard form per stack: a new statement that reuses a pinned form adds no id,
// so only the count can fail it. The lint is credential-free and runs in-process
// in `npm run check`.

const ACCOUNT = '650880818323';
const REGION = 'ap-east-1';
const artifactInputs: ArtifactInputs = {
  lambdas: {
    'pre-sign-up': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
    'post-confirmation': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
  },
  runtimePolicy: runtimePolicies,
};

export interface LintFinding {
  stack: string;
  id: string;
  reason: string;
}

export interface LintBaseline {
  schema_version: number;
  record_type: string;
  source: string;
  templates: Array<{ stack: string; wildcard_statement_count: number }>;
  findings: LintFinding[];
}

export interface LintObservation {
  findings: Record<string, string[]>;
  counts: Record<string, number>;
}

const baseline = baselineJson as LintBaseline;

function synthesize(): Array<{ name: string; stack: cdk.Stack; template: any }> {
  const foundationApp = new cdk.App();
  const foundation = new FoundationStack(foundationApp, 'AnyWearFoundationStack', {
    env: { account: ACCOUNT, region: REGION }, identityPhase: 'roles-added', legacyRoleSource: 'cdk' });
  const platformApp = new cdk.App();
  const platform = new PlatformStack(platformApp, 'AnyWearPlatformStack-beta', {
    stage: 'beta', artifactInputs, identityPhase: 'roles-added',
    env: { account: ACCOUNT, region: REGION } });
  return [
    { name: 'AnyWearFoundationStack', stack: foundation, template: Template.fromStack(foundation).toJSON() },
    { name: 'AnyWearPlatformStack-beta', stack: platform, template: Template.fromStack(platform).toJSON() },
  ];
}

// The cdk-nag finding ids render partition tokens differently from the
// synthesized ARNs; normalize before comparing.
export const normalizeFinding = (finding: string): string => finding.replaceAll('arn:<AWS::Partition>', 'arn:aws');

const findingIds = (app: cdk.App): string[] => (new AwsSolutionsChecks(app).validateScope(app).violations ?? [])
  .filter((violation) => violation.ruleName.startsWith('AwsSolutions-IAM5'))
  .map((violation) => (violation.ruleName.includes('[')
    ? violation.ruleName.slice(violation.ruleName.indexOf('[') + 1, -1) : ''))
  .map(normalizeFinding);

// One integer per stack: every statement in every AWS::IAM::Policy,
// AWS::IAM::ManagedPolicy and role-inline policy document whose Action or
// Resource carries a `*`. It only counts: no per-statement suppression, no
// condition expectation, no managed-policy review and no second artifact.
export function wildcardStatementCount(template: any): number {
  let count = 0;
  for (const resource of Object.values(template.Resources) as any[]) {
    const documents: any[] = [];
    if ((resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy')
      && resource.Properties?.PolicyDocument) documents.push(resource.Properties.PolicyDocument);
    for (const policy of Array.isArray(resource.Properties?.Policies) ? resource.Properties.Policies : []) {
      if (policy.PolicyDocument) documents.push(policy.PolicyDocument);
    }
    for (const document of documents) {
      for (const statement of [document.Statement].flat() as any[]) {
        const actions = [statement.Action].flat().filter(Boolean);
        const resources = [statement.Resource].flat().filter(Boolean);
        const wildcardAction = actions.some((action) => typeof action === 'string' && action.includes('*'));
        const wildcardResource = resources.some((value) => JSON.stringify(value).includes('*'));
        if (wildcardAction || wildcardResource) count += 1;
      }
    }
  }
  return count;
}

// The whole comparison, pure so the negative cases can be exercised without
// mutating the synthesized stacks or the fixture. Empty means the stack matches;
// every other entry names the mismatch a reviewer must resolve.
export function compareLint(pinned: LintBaseline, observed: LintObservation): string[] {
  const problems: string[] = [];
  const stacks = pinned.templates.map((template) => template.stack);
  for (const stack of Object.keys(observed.findings)) {
    if (!stacks.includes(stack)) problems.push(`${stack}: observation for a stack outside the pinned baseline`);
  }
  for (const template of pinned.templates) {
    const ids = pinned.findings.filter((finding) => finding.stack === template.stack).map((finding) => finding.id);
    if (new Set(ids).size !== ids.length) problems.push(`${template.stack}: duplicate baseline entry`);
    const actual = [...(observed.findings[template.stack] ?? [])].sort();
    const pinnedIds = [...ids].sort();
    for (const id of actual) {
      if (!pinnedIds.includes(id)) problems.push(`${template.stack}: new AwsSolutions-IAM5 finding not in the baseline: ${id}`);
    }
    for (const id of pinnedIds) {
      if (!actual.includes(id)) problems.push(`${template.stack}: stale baseline entry no longer reported by cdk-nag: ${id}`);
    }
    const count = observed.counts[template.stack];
    if (count !== template.wildcard_statement_count) {
      problems.push(`${template.stack}: wildcard-bearing statement count ${count} does not match the pinned ${template.wildcard_statement_count}`);
    }
  }
  return problems;
}

const entries = synthesize();
const observed: LintObservation = { findings: {}, counts: {} };
for (const { name, stack, template } of entries) {
  observed.findings[name] = findingIds(stack.node.root as cdk.App);
  observed.counts[name] = wildcardStatementCount(template);
}

describe('IaC policy lint (#165)', () => {
  it('pins the AwsSolutions-IAM5 findings and the wildcard-statement counts for both stacks', () => {
    expect(compareLint(baseline, observed)).toEqual([]);
    expect(baseline.schema_version).toBe(1);
    expect(baseline.record_type).toBe('anywear_authorization_lint_baseline');
    expect(baseline.templates.map((template) => template.stack)).toEqual(['AnyWearFoundationStack', 'AnyWearPlatformStack-beta']);
    // The baseline covers both stacks and every entry names the stack it belongs to.
    for (const finding of baseline.findings) expect(baseline.templates.map((template) => template.stack)).toContain(finding.stack);
    expect(new Set(baseline.findings.map((finding) => `${finding.stack}|${finding.id}`)).size).toBe(baseline.findings.length);
    // Every entry carries a reviewed reason; a terse or placeholder one is caught here.
    for (const finding of baseline.findings) expect(finding.reason.length).toBeGreaterThan(60);
  });

  it('fails on a new finding id, on a reused form (count only) and on a deleted baseline entry', () => {
    // Synthetic observations derived from the baseline: no real stack is mutated.
    const exact: LintObservation = {
      findings: Object.fromEntries(baseline.templates.map((template) => [template.stack,
        baseline.findings.filter((finding) => finding.stack === template.stack).map((finding) => finding.id)])),
      counts: Object.fromEntries(baseline.templates.map((template) => [template.stack, template.wildcard_statement_count])),
    };
    expect(compareLint(baseline, exact)).toEqual([]);

    // A wildcard form the baseline does not name is a new finding id, on either stack.
    for (const stack of ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta']) {
      const newForm = structuredClone(exact);
      newForm.findings[stack].push('Resource::arn:aws:s3:::unreviewed-bucket/*');
      expect(compareLint(baseline, newForm)).toEqual([
        `${stack}: new AwsSolutions-IAM5 finding not in the baseline: Resource::arn:aws:s3:::unreviewed-bucket/*`,
      ]);
    }

    // A new statement that reuses a pinned form adds no id; only the count moves,
    // on either stack.
    for (const template of baseline.templates) {
      const reusedForm = structuredClone(exact);
      reusedForm.counts[template.stack] = template.wildcard_statement_count + 1;
      expect(compareLint(baseline, reusedForm)).toEqual([
        `${template.stack}: wildcard-bearing statement count ${template.wildcard_statement_count + 1} does not match the pinned ${template.wildcard_statement_count}`,
      ]);
    }

    // A wildcard removed from a stack while the baseline entry stays is stale.
    const stale = structuredClone(exact);
    stale.findings.AnyWearFoundationStack = stale.findings.AnyWearFoundationStack.filter((id) => id !== 'Resource::*');
    // Keep the pinned count so only the stale-entry mismatch is asserted here.
    expect(compareLint(baseline, stale)).toEqual([
      'AnyWearFoundationStack: stale baseline entry no longer reported by cdk-nag: Resource::*',
    ]);

    // Deleting the baseline entry instead leaves the real finding unbaselined, so
    // the check fails in the other direction as well.
    const deletedEntry = structuredClone(baseline);
    deletedEntry.findings = deletedEntry.findings.filter((finding) => !(finding.stack === 'AnyWearFoundationStack'
      && finding.id === 'Resource::*'));
    expect(compareLint(deletedEntry, exact)).toEqual([
      'AnyWearFoundationStack: new AwsSolutions-IAM5 finding not in the baseline: Resource::*',
    ]);
  });

  it('fails when one wildcard statement is injected into either real synthesized stack', () => {
    // Inject into a clone of each real synthesized template, never the stack, the
    // fixture or the recorded observation. The injected statement reuses the
    // bare-`*` form already pinned for both stacks, so the cdk-nag finding-id set
    // cannot move and only the per-stack count can fail the check.
    for (const { name, template } of entries) {
      const pinned = baseline.templates.find((entry) => entry.stack === name)?.wildcard_statement_count;
      expect(pinned).toBeGreaterThan(0);
      expect(baseline.findings.some((finding) => finding.stack === name && finding.id === 'Resource::*')).toBe(true);
      expect(wildcardStatementCount(template)).toBe(pinned);
      const injected = structuredClone(template);
      injected.Resources.AuthorizationLintInjectedPolicy = {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Action: 'ecs:DeregisterTaskDefinition', Resource: '*' }],
          },
          PolicyName: 'authorization-lint-injected-policy',
        },
      };
      const injectedCount = wildcardStatementCount(injected);
      expect(injectedCount).toBe((pinned as number) + 1);
      const problems = compareLint(baseline, { findings: observed.findings,
        counts: { ...observed.counts, [name]: injectedCount } });
      expect(problems).toEqual([
        `${name}: wildcard-bearing statement count ${(pinned as number) + 1} does not match the pinned ${pinned}`,
      ]);
      // Count-only failure: the id set comparison stays quiet.
      expect(problems.join('\n')).not.toMatch(/new AwsSolutions-IAM5 finding|stale baseline entry/);
      // The recorded state is untouched by the clone or the comparison.
      expect(wildcardStatementCount(template)).toBe(pinned);
      expect(observed.counts[name]).toBe(pinned);
    }
  });

  it('reports a synthetic new wildcard on a control stack as a cdk-nag finding', () => {
    // The negative control: a wildcard the baseline does not carry must surface
    // from cdk-nag itself, not only from the fixture comparison.
    const app = new cdk.App();
    const control = new cdk.Stack(app, 'AuthorizationLintControlStack', { env: { account: ACCOUNT, region: REGION } });
    const role = new cdk.aws_iam.Role(control, 'ControlRole', {
      roleName: 'authorization-lint-control-role',
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3:GetObject'], resources: ['arn:aws:s3:::authorization-lint-control-bucket/*'] }));
    const ids = findingIds(app);
    expect(ids).toContain('Resource::arn:aws:s3:::authorization-lint-control-bucket/*');
    const controlCount = wildcardStatementCount(Template.fromStack(control).toJSON());
    expect(controlCount).toBe(1);
    expect(compareLint(baseline, { findings: { [control.stackName]: ids }, counts: { [control.stackName]: controlCount } }))
      .toContain('AuthorizationLintControlStack: observation for a stack outside the pinned baseline');
  });
});
