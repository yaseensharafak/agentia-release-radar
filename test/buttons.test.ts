import * as assert from 'assert';
import { test } from 'node:test';
import { eventKind, successButtons, wantsPullRequest } from '../src/buttons';
import { DEFAULTS } from '../src/config';
import { describeSuccess } from '../src/describe';
import { AgentiaClient, featureBranchPullRequestUrl, parseStoryDetails } from '../src/agentia';
import { CollectNotifier } from '../src/notify';
import { handleTransitions } from '../src/pipeline';
import { Registry } from '../src/registry';
import { sampleCards } from '../src/sample';
import { buildFailureBlocks, buildSuccessBlocks, linkRow } from '../src/slack';
import { Config, JobSummary } from '../src/types';

const ORG = 'https://acme.my.salesforce.com';
const SID = 'a93Xx0000000777AAA';
const PID = 'a89Xx0000000901AAA';
const PR = 'https://github.com/acme/repo/compare/uat...promotion/P-1?expand=1';
const base: JobSummary = { id: 'a7q000000000001AAA', name: 'job', status: 'Successful', state: 'success', story: 'US-1', stories: ['US-1'], storyIds: { 'US-1': SID }, promotionId: PID, promotion: 'P-1' };
const cfg = { orgUrl: ORG, storyIds: {} };
const labels = (j: Partial<JobSummary>, pr?: string): string[] => successButtons({ ...base, ...j }, cfg, pr).map((b) => b.label);
const urls = (j: Partial<JobSummary>, pr?: string): string[] => successButtons({ ...base, ...j }, cfg, pr).map((b) => b.url);

test('event kind: commit, validation, deployment, promotion step, quality check', () => {
  assert.strictEqual(eventKind({ action: 'Commit' }), 'commit');
  assert.strictEqual(eventKind({ action: 'PromotionDeployment', dryRun: true }), 'validation');
  assert.strictEqual(eventKind({ action: 'PromotionDeployment', dryRun: false }), 'deployment');
  assert.strictEqual(eventKind({ action: 'Promotion' }), 'promotion');
  assert.strictEqual(eventKind({ action: 'Test' }), 'quality');
  assert.strictEqual(eventKind({}), 'other');
  assert.strictEqual(wantsPullRequest({ action: 'PromotionDeployment', dryRun: true }), true);
  assert.strictEqual(wantsPullRequest({ action: 'Commit' }), false);
});

test('success buttons per event: only links that exist, pointing at the right Copado record', () => {
  assert.deepStrictEqual(labels({ action: 'Commit' }), ['Validate in Copado ↗']);
  assert.deepStrictEqual(labels({ action: 'Commit' }, PR), ['Open pull request ↗', 'Validate in Copado ↗']);
  assert.deepStrictEqual(urls({ action: 'Commit' }), [`${ORG}/${SID}`], 'the story page, where Validate is');
  assert.deepStrictEqual(labels({ action: 'PromotionDeployment', dryRun: true }, PR), ['Open pull request ↗', 'Promote in Copado ↗']);
  assert.deepStrictEqual(urls({ action: 'PromotionDeployment', dryRun: true }, PR), [PR, `${ORG}/${PID}`], 'the promotion page, where Promote is');
  assert.deepStrictEqual(labels({ action: 'PromotionDeployment', dryRun: false }, PR), ['Open pull request ↗', 'Validate next environment ↗']);
  assert.deepStrictEqual(labels({ action: 'Promotion' }), ['Open promotion ↗']);
  assert.deepStrictEqual(labels({ action: 'Test' }), [], 'a quality check passing needs no next step');
  assert.deepStrictEqual(labels({}), []);
});

test('success buttons: never a dead end when something is unknown', () => {
  const none = (j: Partial<JobSummary>, c: Pick<Config, 'orgUrl' | 'storyIds'>, pr?: string) => successButtons({ ...base, ...j }, c, pr);
  assert.deepStrictEqual(none({ action: 'Commit' }, { storyIds: {} }), [], 'no orgUrl: no Copado link');
  assert.deepStrictEqual(none({ action: 'Commit' }, { orgUrl: 'http://insecure.example', storyIds: {} }), [], 'https only');
  assert.deepStrictEqual(none({ action: 'Commit', storyIds: undefined }, cfg), [], 'story record id unknown');
  assert.strictEqual(none({ action: 'Commit', storyIds: undefined }, { orgUrl: ORG, storyIds: { 'US-1': SID } })[0]?.url, `${ORG}/${SID}`, 'config fallback');
  assert.deepStrictEqual(none({ action: 'Commit', stories: ['US-1', 'US-2'] }, cfg), [], 'two stories: no guess');
  assert.deepStrictEqual(none({ action: 'PromotionDeployment', dryRun: true, promotionId: undefined }, cfg, PR).map((b) => b.label), ['Open pull request ↗'], 'no promotion id: only what is known');
  assert.deepStrictEqual(none({ action: 'PromotionDeployment', dryRun: true }, { storyIds: {} }, PR).map((b) => b.label), ['Open pull request ↗'], 'pull request works without orgUrl');
});

test('slack: link buttons are one row with unique ids, https only, within limits; no row when there are none', () => {
  assert.strictEqual(linkRow(undefined), undefined);
  assert.strictEqual(linkRow([{ label: 'x', url: 'javascript:alert(1)' }, { label: 'y', url: 'http://a.b' }, { label: 'z', url: 'https://a.b/<script>' }]), undefined);
  const row = linkRow(Array.from({ length: 8 }, (_v, i) => ({ label: `Button ${i} `.repeat(20), url: `https://a.b/${i}`, primary: i === 0 }))) as { elements: Array<{ action_id: string; text: { text: string }; style?: string }> };
  assert.strictEqual(row.elements.length, 5);
  assert.strictEqual(new Set(row.elements.map((e) => e.action_id)).size, 5);
  assert.ok(row.elements.every((e) => e.text.text.length <= 75));
  assert.strictEqual(row.elements[0].style, 'primary');
  const s = describeSuccess({ ...base, action: 'PromotionDeployment', dryRun: true }, { destinations: {}, orgUrl: ORG });
  assert.ok(!JSON.stringify(buildSuccessBlocks(s).blocks).includes('radar_link'), 'no buttons, no row');
  s.buttons = successButtons({ ...base, action: 'PromotionDeployment', dryRun: true }, cfg, PR);
  const blocks = buildSuccessBlocks(s).blocks as Array<{ type: string; elements?: Array<{ url?: string }> }>;
  assert.strictEqual(blocks[blocks.length - 1].type, 'actions');
  assert.deepStrictEqual(blocks[blocks.length - 1].elements?.map((e) => e.url), [PR, `${ORG}/${PID}`]);
});

test('failure card: Re-run is shown unless re-run actions are switched off; Commit missing stays', () => {
  const cards = sampleCards({ storyOwners: {}, destinations: {}, storyIds: {} });
  const fail = cards.find((c) => c.kind === 'failure' && c.label === 'validation failed');
  assert.ok(fail && fail.kind === 'failure');
  const ids = (r: typeof fail.report) => (buildFailureBlocks(r).blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>).filter((b) => b.type === 'actions').flatMap((b) => b.elements ?? []).map((e) => e.action_id);
  assert.deepStrictEqual(ids(fail.report), ['radar_details', 'radar_commit_missing', 'radar_rerun']);
  assert.deepStrictEqual(ids({ ...fail.report, hideRerun: true }), ['radar_details', 'radar_commit_missing']);
});

test('sample cards: one per event, each with the buttons its event should have', () => {
  const cards = sampleCards({ storyOwners: {}, destinations: {}, storyIds: {} });
  assert.deepStrictEqual(cards.map((c) => c.label), ['commit succeeded', 'validation succeeded', 'validation failed', 'deployment succeeded', 'deployment failed', 'commit failed']);
  const successLabels = (label: string) => { const c = cards.find((x) => x.label === label); return c && c.kind === 'success' ? (c.success.buttons ?? []).map((b) => b.label) : []; };
  assert.deepStrictEqual(successLabels('commit succeeded'), ['Open pull request ↗', 'Validate in Copado ↗']);
  assert.deepStrictEqual(successLabels('validation succeeded'), ['Open pull request ↗', 'Promote in Copado ↗']);
  assert.deepStrictEqual(successLabels('deployment succeeded'), ['Open pull request ↗', 'Validate next environment ↗']);
  const commitFail = cards.find((c) => c.label === 'commit failed');
  assert.ok(commitFail && commitFail.kind === 'failure' && !commitFail.report.commitAction, 'a failed commit offers Re-run, not "commit missing"');
  const ids = new Set(cards.filter((c) => c.kind === 'failure').map((c) => (c as { report: { job: { id: string } } }).report.job.id));
  assert.strictEqual(ids.size, 3, 'each failure card is its own job, so each can be acted on');
});

test('pipeline: success cards get their buttons (pull request only when asked for); failure cards hide Re-run when actions are off', async () => {
  const detail = { id: 'x', name: 'x', status: 'Error', steps: [] };
  const client = new AgentiaClient(async (argv) => (argv.includes('promotion') ? JSON.stringify({ result: { openPullRequest: { gitProvider: 'Github', pullRequestBaseUrl: 'https://github.com/acme/repo/', destinationEnvironmentBranch: 'uat', compareBranch: 'promotion/P-1' } } }) : JSON.stringify({ result: detail })), DEFAULTS.commands);
  const run = async (c: Config, job: JobSummary, to: 'success' | 'failure') => {
    const n = new CollectNotifier();
    await handleTransitions([{ job, to }], { client, notifier: n, registry: new Registry(), cfg: { ...c, repoDir: '/nope' } });
    return n;
  };
  const val: JobSummary = { ...base, action: 'PromotionDeployment', dryRun: true };
  const off = await run({ ...DEFAULTS, orgUrl: ORG }, val, 'success');
  assert.deepStrictEqual(off.successes[0].buttons?.map((b) => b.label), ['Promote in Copado ↗'], 'pull request lookup is off by default');
  const on = await run({ ...DEFAULTS, orgUrl: ORG, pullRequestLinks: true }, val, 'success');
  assert.deepStrictEqual(on.successes[0].buttons?.map((b) => b.label), ['Open pull request ↗', 'Promote in Copado ↗']);
  const commit = await run({ ...DEFAULTS, orgUrl: ORG, pullRequestLinks: true }, { ...base, action: 'Commit' }, 'success');
  assert.deepStrictEqual(commit.successes[0].buttons?.map((b) => b.label), ['Validate in Copado ↗']);
  assert.strictEqual((await run({ ...DEFAULTS }, { ...val, state: 'failure', status: 'Error' }, 'failure')).failures[0].hideRerun, true);
  assert.strictEqual((await run({ ...DEFAULTS, allowActions: true }, { ...val, state: 'failure', status: 'Error' }, 'failure')).failures[0].hideRerun, undefined);
});

test('serve --sample: even with liveActions set, sample buttons stay dry (nothing real can run)', () => {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const f = path.join(os.tmpdir(), `rr-sample-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ allowActions: true, allowCommitMissing: true, allowedUsers: ['U1'], liveActions: ['commit', 'rerun'], port: 3998 }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'serve', '--sample', '--notifier', 'console', '--config', f], { env: { ...process.env, SLACK_SIGNING_SECRET: 'x' }, encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL' });
  assert.match(r.stderr, /re-run DRY-RUN/);
  assert.match(r.stderr, /commit-missing DRY-RUN/);
});

test('story record id: found from JSON or the plain text `work status` prints; a wrong story or odd name is never trusted; failures mean unknown', async () => {
  const mk = (out: string | Error, calls: string[][] = []) => new AgentiaClient(async (argv) => { calls.push(argv); if (out instanceof Error) throw out; return out; }, DEFAULTS.commands);
  assert.strictEqual(await mk(JSON.stringify({ result: { id: SID, name: 'US-0000555' }, status: 0 })).storyRecordId('US-0000555'), SID);
  assert.strictEqual(await mk(JSON.stringify({ result: { workItem: { id: SID, name: 'US-0000555' } }, status: 0 })).storyRecordId('US-0000555'), SID);
  const text = 'Fetching status for US-0000555... done\nID: a93Xx0000000555AAA\nName: US-0000555\nTitle: Delta\n';
  assert.strictEqual(await mk(text).storyRecordId('US-0000555'), 'a93Xx0000000555AAA');
  assert.strictEqual(await mk(text.replace('ID: a93Xx0000000555AAA\nName: US-0000555', 'Name: US-0000555\nID: a93Xx0000000555AAA')).storyRecordId('US-0000555'), 'a93Xx0000000555AAA');
  assert.strictEqual(await mk(text).storyRecordId('US-0000001'), undefined, 'a different story is never accepted');
  assert.strictEqual(await mk(JSON.stringify({ result: { id: SID, name: 'US-9' } })).storyRecordId('US-0000555'), undefined);
  assert.strictEqual(await mk(new Error('boom')).storyRecordId('US-0000555'), undefined);
  const calls: string[][] = [];
  assert.strictEqual(await mk('x; calc', calls).storyRecordId('US-1; calc'), undefined);
  assert.strictEqual(calls.length, 0, 'odd names never reach the CLI');
  const c2: string[][] = [];
  const cl = mk(text, c2);
  await cl.storyRecordId('US-0000555');
  await cl.storyRecordId('us-0000555');
  assert.strictEqual(c2.length, 1, 'asked once per story');
  assert.deepStrictEqual(c2[0], ['cicd', 'work', 'status', 'US-0000555', '--json']);
  assert.strictEqual(await new AgentiaClient(async () => text, { ...DEFAULTS.commands, storyLookup: null }).storyRecordId('US-0000555'), undefined, 'can be switched off');
});

test('pipeline: a commit card whose job does not carry the story record id still gets "Validate in Copado" (looked up by name)', async () => {
  const client = new AgentiaClient(async (argv) => (argv.includes('status') ? 'ID: a93Xx0000000555AAA\nName: US-0000555\n' : JSON.stringify({ result: { id: 'x', name: 'x', status: 'Error', steps: [] } })), DEFAULTS.commands);
  const n = new CollectNotifier();
  const job: JobSummary = { id: 'a7q000000000009AAA', name: 'c', status: 'Successful', state: 'success', action: 'Commit', story: 'US-0000555', stories: ['US-0000555'] };
  await handleTransitions([{ job, to: 'success' }], { client, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, orgUrl: ORG } });
  assert.deepStrictEqual(n.successes[0].buttons?.map((b) => b.url), [`${ORG}/a93Xx0000000555AAA`]);
  const m = new CollectNotifier();
  await handleTransitions([{ job, to: 'success' }], { client: new AgentiaClient(async () => { throw new Error('no'); }, DEFAULTS.commands), notifier: m, registry: new Registry(), cfg: { ...DEFAULTS, orgUrl: ORG } });
  assert.deepStrictEqual(m.successes[0].buttons, [], 'lookup failed: no button rather than a broken one');
});

const STATUS_TEXT = [
  'Fetching status for US-0000555... done', 'ID: a93Xx0000000555AAA', 'Name: US-0000555', 'Title: Delta deployment from QA1 to UAT',
  'Status: SIT Dev Test', 'Project Pipeline Main Branch: main', 'Project Pipeline Pull Request Base URL: https://github.com/acme-corp/demo-sf-repo/',
  'Release ID:', 'Release Base Branch:', 'Release Project Pipeline Pull Request Base URL:', 'Base Branch: main', 'Excluded From CBM: false',
].join('\n');

test('story details: id, base branch and repository from the text or JSON of `work status`; other stories are never accepted', () => {
  assert.deepStrictEqual(parseStoryDetails(STATUS_TEXT, 'US-0000555'), { id: 'a93Xx0000000555AAA', baseBranch: 'main', prBaseUrl: 'https://github.com/acme-corp/demo-sf-repo/' });
  assert.strictEqual(parseStoryDetails(STATUS_TEXT, 'US-0000001'), undefined);
  const json = JSON.stringify({ result: { id: 'a93Xx0000000555AAA', name: 'US-0000555', baseBranch: 'develop', projectPipelinePullRequestBaseUrl: 'https://github.com/o/r/', releaseBaseBranch: 'wrong' } });
  assert.deepStrictEqual(parseStoryDetails(json, 'US-0000555'), { id: 'a93Xx0000000555AAA', baseBranch: 'develop', prBaseUrl: 'https://github.com/o/r/' });
  assert.strictEqual(parseStoryDetails('garbage', 'US-1'), undefined);
});

test('pull request for a commit: the story\'s own branch against its base branch; GitHub only; odd values give no link', () => {
  const ok = 'https://github.com/acme-corp/demo-sf-repo/';
  assert.strictEqual(featureBranchPullRequestUrl(ok, 'main', 'US-0000555'), 'https://github.com/acme-corp/demo-sf-repo/compare/main...feature/US-0000555?expand=1');
  for (const [b, br, st] of [[undefined, 'main', 'US-1'], [ok, undefined, 'US-1'], [ok, 'main', undefined], ['http://github.com/a/b/', 'main', 'US-1'], ['https://gitlab.com/a/b/', 'main', 'US-1'],
    [ok, 'a..b', 'US-1'], [ok, 'ma in', 'US-1'], [ok, 'main', 'US-1;x'], ['https://github.com/a/b/extra/', 'main', 'US-1']] as Array<[string | undefined, string | undefined, string | undefined]>) {
    assert.strictEqual(featureBranchPullRequestUrl(b, br, st), undefined, JSON.stringify([b, br, st]));
  }
});

test('pipeline: a commit card gets Open pull request (story branch) and Validate in Copado, from one lookup', async () => {
  const calls: string[][] = [];
  const client = new AgentiaClient(async (argv) => { calls.push(argv); return argv.includes('status') ? STATUS_TEXT : JSON.stringify({ result: { id: 'x', name: 'x', status: 'Error', steps: [] } }); }, DEFAULTS.commands);
  const job: JobSummary = { id: 'a7q000000000009AAA', name: 'c', status: 'Successful', state: 'success', action: 'Commit', story: 'US-0000555', stories: ['US-0000555'] };
  const n = new CollectNotifier();
  await handleTransitions([{ job, to: 'success' }], { client, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, orgUrl: ORG, pullRequestLinks: true } });
  assert.deepStrictEqual(n.successes[0].buttons?.map((b) => [b.label, b.url]), [
    ['Open pull request ↗', 'https://github.com/acme-corp/demo-sf-repo/compare/main...feature/US-0000555?expand=1'],
    ['Validate in Copado ↗', `${ORG}/a93Xx0000000555AAA`],
  ]);
  assert.strictEqual(calls.filter((c) => c.includes('status')).length, 1);
  const off = new CollectNotifier();
  await handleTransitions([{ job, to: 'success' }], { client, notifier: off, registry: new Registry(), cfg: { ...DEFAULTS, orgUrl: ORG } });
  assert.deepStrictEqual(off.successes[0].buttons?.map((b) => b.label), ['Validate in Copado ↗'], 'pull request links stay off unless enabled');
});
