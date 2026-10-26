import { commitActionFor } from './commit';
import { resolveRevalidateAction } from './revalidate';
import { successButtons } from './buttons';
import { Success, describeSuccess } from './describe';
import { analyze } from './triage';
import { Config, FailureReport, JobSummary } from './types';

/**
 * Sample cards with INVENTED names, for testing Slack (formatting, buttons, @-mentions) without a real failure
 * and without posting any real project data to a Slack workspace.
 */
const SAMPLE_ERRORS = [
  "Metadata Validation - ApexClass:InvoiceSyncHandler:No such column 'Billing_Plan__c' on entity 'ACME_Invoice__c'.",
  'ApexClass:InvoiceSyncHandler:Variable does not exist: Billing_Plan__c',
  ...Array.from({ length: 12 }, () => 'ApexClass:InvoiceSyncHandlerTest:Field does not exist: Due_On__c on ACME_Installment__c'),
  ...Array.from({ length: 9 }, () => 'ApexClass:InvoiceSyncHandlerTest:Field does not exist: Outstanding_Amount__c on ACME_Billing_Plan__c'),
].join('\n');

export const SAMPLE_STORY = 'US-0000777';

const sampleJob = (over: Partial<JobSummary>): JobSummary => ({
  id: 'SAMPLE-1',
  name: 'SFDX Deploy (validation) · P-9001 [JE-900001]',
  number: 'JE-900001',
  template: 'SFDX Deploy',
  action: 'PromotionDeployment',
  status: 'Error',
  state: 'failure',
  promotion: 'P-9001',
  story: SAMPLE_STORY,
  stories: [SAMPLE_STORY],
  storyIds: { [SAMPLE_STORY]: 'a93Xx0000000777AAA' },
  promotionId: 'a89Xx0000000901AAA',
  destination: 'qa-demo',
  dryRun: true,
  createdAt: '2026-01-01T12:00:00Z',
  finishedAt: '2026-01-01T12:02:10Z',
  ...over,
});

export function sampleFailure(cfg: Pick<Config, 'storyOwners'> & Partial<Pick<Config, 'commands' | 'allowActions' | 'storyIds'>>): FailureReport {
  const a = analyze([SAMPLE_ERRORS]);
  // same precedence as real failures: an explicit story entry, else the default owner ("*")
  const slackId = cfg.storyOwners?.[SAMPLE_STORY] ?? cfg.storyOwners?.['*'];
  const r: FailureReport = {
    job: sampleJob({}),
    triage: { headline: a.headline, explanation: a.explanation, findings: a.findings, errorCount: a.errorCount, stories: { InvoiceSyncHandler: SAMPLE_STORY, InvoiceSyncHandlerTest: SAMPLE_STORY }, kinds: a.kinds, source: 'rules' },
    owners: [{ component: 'InvoiceSyncHandler, InvoiceSyncHandlerTest', owner: { story: SAMPLE_STORY, slackId } }],
    at: new Date().toISOString(),
  };
  r.commitAction = commitActionFor(r);
  if (cfg.commands) r.revalidateAction = resolveRevalidateAction(r.job, { commands: cfg.commands, allowActions: cfg.allowActions ?? false, storyIds: cfg.storyIds ?? {} });
  return r;
}

export function sampleSuccess(cfg: Pick<Config, 'destinations' | 'orgUrl'>): Success {
  return describeSuccess(sampleJob({ id: 'SAMPLE-2', number: 'JE-900002', status: 'Successful', state: 'success', dryRun: false }), cfg);
}

const SAMPLE_PR = 'https://github.com/example-org/example-repo/compare/qa-demo...promotion/P-9001?expand=1';

export type SampleCard = { kind: 'failure'; label: string; report: FailureReport } | { kind: 'success'; label: string; success: Success };

/**
 * One card for every event ReleaseRadar announces, with invented data, so the buttons of each can be checked in Slack without Copado.
 * The Copado and pull request links are placeholders (your orgUrl if you set one, otherwise an example address).
 */
export function sampleCards(cfg: Pick<Config, 'storyOwners' | 'destinations' | 'orgUrl' | 'storyIds'> & Partial<Pick<Config, 'commands' | 'allowActions'>>): SampleCard[] {
  const withOrg = { destinations: cfg.destinations, orgUrl: cfg.orgUrl ?? 'https://example.my.salesforce.com', storyIds: cfg.storyIds ?? {} };
  const ok = (over: Partial<JobSummary>, pr?: string): Success => {
    const job = sampleJob({ status: 'Successful', state: 'success', ...over });
    const s = describeSuccess(job, withOrg);
    s.buttons = successButtons(job, withOrg, pr);
    return s;
  };
  const failure = (over: Partial<JobSummary>, keepCommit: boolean): FailureReport => {
    const r = sampleFailure(cfg);
    r.job = sampleJob({ ...over });
    if (!keepCommit) {
      delete r.commitAction;
      const a = analyze(['Preflight failed: the component was not found in the source org (sample).']);
      r.triage = { headline: a.headline, explanation: a.explanation, findings: a.findings, errorCount: a.errorCount, stories: {}, kinds: a.kinds, source: 'rules' };
    }
    return r;
  };
  return [
    { kind: 'success', label: 'commit succeeded', success: ok({ id: 'SAMPLE-C1', number: 'JE-900010', name: 'SFDX Commit [JE-900010]', template: 'SFDX Commit', action: 'Commit', dryRun: undefined, destination: undefined, commitMessage: 'US-0000777: add Billing_Plan__c and InvoiceSyncHandler' }, 'https://github.com/example-org/example-repo/compare/main...feature/US-0000777?expand=1') },
    { kind: 'success', label: 'validation succeeded', success: ok({ id: 'SAMPLE-V1', number: 'JE-900011', action: 'PromotionDeployment', dryRun: true }, SAMPLE_PR) },
    { kind: 'failure', label: 'validation failed', report: failure({ id: 'SAMPLE-1' }, true) },
    { kind: 'success', label: 'deployment succeeded', success: ok({ id: 'SAMPLE-2', number: 'JE-900002', name: 'SFDX Deploy [JE-900002]', dryRun: false }, SAMPLE_PR) },
    { kind: 'failure', label: 'deployment failed', report: failure({ id: 'SAMPLE-3', number: 'JE-900003', name: 'SFDX Deploy [JE-900003]', dryRun: false }, true) },
    { kind: 'failure', label: 'commit failed', report: failure({ id: 'SAMPLE-4', number: 'JE-900004', name: 'SFDX Commit [JE-900004]', template: 'SFDX Commit', action: 'Commit', dryRun: undefined, destination: undefined }, false) },
  ];
}
