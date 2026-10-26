import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { ActionClient, ActionDeps, handleInteraction } from '../src/actions';
import { AgentiaClient, normalizeDetail, normalizeJob } from '../src/agentia';
import { commitActionFor, commitMessage, commitStory, metadataTargets, showCommand } from '../src/commit';
import { DEFAULTS } from '../src/config';
import { CollectNotifier } from '../src/notify';
import { handleTransitions } from '../src/pipeline';
import { Registry } from '../src/registry';
import { buildFailureBlocks } from '../src/slack';
import { analyze, triage } from '../src/triage';
import { Config, FailureReport } from '../src/types';

const FAKE = path.join(__dirname, '../../tools/fake-agentia/agentia.js');
const JOB104 = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tools/fake-agentia/fixtures/job-104.json'), 'utf8'));
const FX = path.join(__dirname, '../../fixtures/formats');

const typed = (n: number, last?: string): string =>
  [...Array.from({ length: n }, (_, i) => `ApexClass:Cls${i % 3}:Field does not exist: F${i % 4}__c on ACME_Obj__c`), ...(last ? [last] : [])].join('\n');

// ---------- what can be committed ----------
test('metadata: missing custom fields and a missing Apex class become committable components; standard fields never do', () => {
  const a = analyze([JOB104.errorMessage]);
  const names = a.findings.map((f) => f.metadata && `${f.metadata.type}:${f.metadata.name}`).filter(Boolean).sort();
  assert.deepStrictEqual(names, ['CustomField:ACME_Invoice__c.Discount__c', 'CustomField:ACME_Plan__c.Rate__c']);
  assert.ok(a.findings.some((f) => /Field does not exist: Status|Missing field Account\.Status/.test(f.message) && !f.metadata), 'standard field Account.Status is not committable');
  const lwc = analyze(["Metadata Validation - LightningComponentBundle:orderSummaryPanel:Unable to find Apex action class referenced as 'OrderPanelController'."]);
  assert.deepStrictEqual(lwc.findings[0].metadata, { type: 'ApexClass', name: 'OrderPanelController' });
  assert.strictEqual(analyze(['SyncSchedulerTest-testExecute-System.DmlException: bad value for restricted picklist field: Gold: [Tier__c]']).findings[0].metadata, undefined, 'a picklist value is not a component');
});

test('metadataTargets: de-duplicates, drops names that are not plain identifiers, and caps the list', () => {
  const f = (type: string, name: string) => ({ category: 'missing-dependency' as const, message: 'x', metadata: { type, name } });
  const t = metadataTargets([f('CustomField', 'A__c.B__c'), f('CustomField', 'a__c.b__c'), f('CustomField', 'X; rm -rf /'), f('Custom Field', 'A__c.C__c'), f('CustomField', '--flag'), f('CustomField', 'A__c.D__c')]);
  assert.deepStrictEqual(t.map((x) => x.name), ['A__c.B__c', 'A__c.D__c']);
  const many = Array.from({ length: 80 }, (_, i) => f('CustomField', `O__c.F${i}__c`));
  assert.strictEqual(metadataTargets(many).length, 50);
});

test('commitStory: only an unambiguous owning story is chosen, never a guess', () => {
  const fnd = (...affects: string[]) => [{ category: 'missing-dependency' as const, message: 'x', affects }];
  assert.strictEqual(commitStory(fnd('A', 'B'), { A: 'US-0000001', B: 'US-0000001' }, {}), 'US-0000001');
  assert.strictEqual(commitStory(fnd('A', 'B'), { A: 'US-0000001', B: 'US-0000002' }, { stories: ['US-0000001'] }), undefined, 'two owning stories: refuse');
  assert.strictEqual(commitStory(fnd('A'), {}, { stories: ['US-0000009'] }), 'US-0000009', 'falls back to the only story on the job');
  assert.strictEqual(commitStory(fnd('A'), {}, { stories: ['US-0000009', 'US-0000010'] }), undefined, 'several stories on the job: refuse');
  assert.strictEqual(commitStory(fnd('A'), {}, {}), undefined);
});

test('commitMessage / showCommand are plain and safe to print', () => {
  assert.match(commitMessage({ number: 'JE-900104', id: 'x' }), /JE-900104/);
  assert.strictEqual(showCommand(['cicd', 'cloud', 'commit', '--message', 'a b']), 'agentia cicd cloud commit --message "a b"');
});

// ---------- building the command ----------
const client = (calls: string[][] = []): AgentiaClient => new AgentiaClient(async (argv) => (calls.push(argv), JSON.stringify({ result: { ok: true }, status: 'success' })), DEFAULTS.commands);
const COMPS = [{ type: 'CustomField', name: 'ACME_Invoice__c.Discount__c' }, { type: 'CustomField', name: 'ACME_Plan__c.Rate__c' }];

test('commit command (default, verified live): story RECORD id is positional, one call per component, SFDX category, no shell', () => {
  const cmds = client().commitCommands('us-0000777', COMPS, 'line1\nline2', 'a93Xx0000000777AAA');
  const one = (name: string): string[] => ['cicd', 'cloud', 'commit', 'a93Xx0000000777AAA', '--metadata-type', 'CustomField', '--metadata-name', name, '--metadata-category', 'SFDX', '--message', 'line1 line2', '--wait', '--json'];
  assert.deepStrictEqual(cmds, [one('ACME_Invoice__c.Discount__c'), one('ACME_Plan__c.Rate__c')]);
  assert.ok(cmds.every((c) => c.includes('SFDX')), 'without --metadata-category SFDX Copado skips the deploy');
  assert.ok(!cmds.some((c) => c.includes('US-0000777')), 'the name US-... is rejected by Copado as "Invalid id"');
});

test('commit command: without a record id the default refuses and says how to find it; a {story} template still works', () => {
  assert.throws(() => client().commitCommands('US-0000777', COMPS, 'm'), /needs the story's Copado record id[\s\S]*SELECT Id FROM copado__User_Story__c WHERE Name = 'US-0000777'/);
  const byName = new AgentiaClient(async () => '{}', { ...DEFAULTS.commands, commitMissing: ['commit', '{story}', '{type}', '{name}'] });
  assert.deepStrictEqual(byName.commitCommands('us-0000777', [COMPS[0]], 'm'), [['commit', 'US-0000777', 'CustomField', 'ACME_Invoice__c.Discount__c']]);
});

test('commit command: a batch template ({metadata}/{metadataJson}) still produces a single call; {storyId} needs a record id', () => {
  const batch = new AgentiaClient(async () => '{}', { ...DEFAULTS.commands, commitMissing: ['x', '{metadata}', '{metadataJson}'] }).commitCommands('US-0000777', COMPS, 'm');
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0][1], 'CustomField:ACME_Invoice__c.Discount__c,CustomField:ACME_Plan__c.Rate__c');
  assert.deepStrictEqual(JSON.parse(batch[0][2]), [{ t: 'CustomField', n: 'ACME_Invoice__c.Discount__c', a: 'Add', c: 'SFDX' }, { t: 'CustomField', n: 'ACME_Plan__c.Rate__c', a: 'Add', c: 'SFDX' }]);
  const byId = new AgentiaClient(async () => '{}', { ...DEFAULTS.commands, commitMissing: ['commit', '{storyId}', '{type}', '{name}'] });
  assert.throws(() => byId.commitCommands('US-0000777', COMPS, 'm'), /needs the story's Copado record id/);
  assert.throws(() => byId.commitCommands('US-0000777', COMPS, 'm', 'bad id'), /needs the story's Copado record id/);
  assert.deepStrictEqual(byId.commitCommands('US-0000777', [COMPS[0]], 'm', 'a93Xx0000000001AAA'), [['commit', 'a93Xx0000000001AAA', 'CustomField', 'ACME_Invoice__c.Discount__c']]);
});

test('commit command: refuses a bad story id, odd names, an empty list, and more than 50 components', () => {
  const c = client();
  assert.throws(() => c.commitCommands('US-1; rm -rf', COMPS, 'm', 'a93Xx0000000777AAA'), /not a user story id/);
  assert.throws(() => c.commitCommands('US-0000777', [{ type: 'CustomField', name: 'a b' }], 'm', 'a93Xx0000000777AAA'), /plain metadata component name/);
  assert.throws(() => c.commitCommands('US-0000777', [{ type: 'Custom Field', name: 'A__c.B__c' }], 'm', 'a93Xx0000000777AAA'), /plain metadata component name/);
  assert.throws(() => c.commitCommands('US-0000777', [], 'm', 'a93Xx0000000777AAA'), /Nothing to commit/);
  assert.throws(() => c.commitCommands('US-0000777', Array.from({ length: 51 }, (_, i) => ({ type: 'CustomField', name: `O__c.F${i}__c` })), 'm', 'a93Xx0000000777AAA'), /more than 50/);
});

test('commit run: calls are made one after another; a failure says how many had already succeeded', async () => {
  const seen: string[] = [];
  const failSecond = new AgentiaClient(async (argv) => {
    seen.push(argv[argv.indexOf('--metadata-name') + 1]);
    if (seen.length === 2) throw new Error('component not found in source org');
    return JSON.stringify({ result: { ok: true }, status: 'success' });
  }, DEFAULTS.commands);
  await assert.rejects(() => failSecond.commitMissing('US-0000777', COMPS, 'm', 'a93Xx0000000777AAA'), /1 of 2 commit call\(s\) succeeded before this failed: component not found in source org/);
  assert.deepStrictEqual(seen, ['ACME_Invoice__c.Discount__c', 'ACME_Plan__c.Rate__c']);
});

// ---------- the button ----------
const report = (over: Partial<FailureReport> = {}): FailureReport => {
  const a = analyze([JOB104.errorMessage]);
  const r: FailureReport = {
    job: { id: '104', name: 'SFDX Deploy (validation) · P-9104 [JE-900104]', number: 'JE-900104', status: 'Error', state: 'failure', story: 'US-0000777', stories: ['US-0000777'], storyIds: { 'US-0000777': 'a93Xx0000000777AAA' } },
    triage: { headline: a.headline, explanation: a.explanation, findings: a.findings, errorCount: a.errorCount, stories: a.stories, kinds: a.kinds, source: 'rules' },
    owners: [], at: 'now', ...over,
  };
  return r;
};

test('button: appears only when a commit action exists, names the story, and the confirmation lists exactly what will be committed', () => {
  const none = JSON.stringify(buildFailureBlocks(report()).blocks);
  assert.ok(!none.includes('radar_commit_missing'));
  const r = report();
  r.commitAction = commitActionFor(r);
  assert.ok(r.commitAction);
  const blocks = buildFailureBlocks(r).blocks;
  const btns = (blocks.find((b) => b.type === 'actions') as { elements: Array<Record<string, any>> }).elements;
  const b = btns.find((x) => x.action_id === 'radar_commit_missing') as Record<string, any>;
  assert.strictEqual(b.text.text, 'Commit 2 missing components to US-0000777');
  assert.strictEqual(b.value, '104', 'the button carries only the job id, never the component list');
  assert.match(b.confirm.text.text, /CustomField:ACME_Invoice__c\.Discount__c/);
  assert.ok(b.confirm.text.text.length <= 300 && b.text.text.length <= 75);
  assert.deepStrictEqual(btns.map((x) => x.action_id), ['radar_details', 'radar_commit_missing', 'radar_rerun']);
});

// ---------- the click handler ----------
const SECRET = 's3cret';
const NOW = 1_800_000_000;
const sign = (body: string): Record<string, string> => ({
  'x-slack-request-timestamp': String(NOW),
  'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${NOW}:${body}`).digest('hex')}`,
});
const click = (id: string, user = 'U0ALLOWED', value = '104'): string =>
  'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: user }, response_url: 'https://hooks.slack.com/actions/T/B/x', actions: [{ action_id: id, value }] }));

function setup(over: Partial<Config> = {}, rep: Partial<FailureReport> | 'no-action' = {}) {
  const posts: Array<{ body: any }> = [];
  const calls: Array<{ story: string; comps: string[]; msg: string }> = [];
  const registry = new Registry();
  const r = report(typeof rep === 'string' ? {} : rep);
  if (rep !== 'no-action') r.commitAction = commitActionFor(r);
  registry.set(r);
  const real = client();
  const c: ActionClient = {
    rerun: async () => 'x',
    commitCommands: (s, comps, m, id) => real.commitCommands(s, comps, m, id),
    commitMissing: async (s, comps, m) => (calls.push({ story: s, comps: comps.map((x) => x.name), msg: m }), 'commit job started'),
  };
  const d: ActionDeps = { cfg: { ...DEFAULTS, signingSecret: SECRET, ...over }, registry, client: c, post: async (_u, body) => void posts.push({ body }), nowSeconds: () => NOW };
  return { d, posts, calls, registry, report: r };
}
const run = async (s: ReturnType<typeof setup>, body: string): Promise<string> => {
  const r = handleInteraction(body, sign(body), s.d);
  await r.done;
  return String(s.posts[s.posts.length - 1]?.body.text ?? '');
};

test('click: committing is OFF by default and nothing runs', async () => {
  const s = setup();
  assert.match(await run(s, click('radar_commit_missing')), /disabled/);
  assert.strictEqual(s.calls.length, 0);
});

test('click: enabled but not on the allow-list -> refused', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0OTHER'] });
  assert.match(await run(s, click('radar_commit_missing')), /not on the allow-list/);
  assert.strictEqual(s.calls.length, 0);
});

test('click: allow-listed user gets a DRY RUN by default showing the exact components and command', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0ALLOWED'] });
  const text = await run(s, click('radar_commit_missing'));
  assert.match(text, /Dry run: would commit 2 components into US-0000777/);
  assert.match(text, /CustomField:ACME_Invoice__c\.Discount__c/);
  assert.match(text, /Commands \(2, run one after another\):/);
  assert.match(text, /agentia cicd cloud commit a93Xx0000000777AAA --metadata-type CustomField --metadata-name ACME_Invoice__c\.Discount__c --metadata-category SFDX/);
  assert.strictEqual(s.calls.length, 0);
  assert.strictEqual(s.report.commitRequested?.dryRun, true);
  // a dry run does not block a later live run
  s.d.cfg.dryRunActions = false;
  await run(s, click('radar_commit_missing'));
  assert.strictEqual(s.calls.length, 1);
});

test('click: live run commits exactly the computed components, once; a second click is refused', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0ALLOWED'], dryRunActions: false });
  const text = await run(s, click('radar_commit_missing'));
  // Two replies: one at once ("requested", the components, no JSON), then one when the commit has finished.
  assert.strictEqual(s.posts.length, 2);
  const first = String(s.posts[0].body.text);
  assert.match(first, /^Commit requested for US-0000777 by <@U0ALLOWED>:\n• `CustomField:ACME_Invoice__c.Discount__c`/);
  assert.ok(!first.includes('{') && !first.includes('```'), 'no JSON in the reply');
  assert.match(text, /^✅ Commit finished for US-0000777 \(2 components added\)/);
  assert.ok(!text.includes('{') && !text.includes('```'), 'no JSON in the reply');
  assert.deepStrictEqual(s.calls, [{ story: 'US-0000777', comps: ['ACME_Invoice__c.Discount__c', 'ACME_Plan__c.Rate__c'], msg: 'ReleaseRadar: add components missing from the validation (JE-900104)' }]);
  assert.match(await run(s, click('radar_commit_missing')), /Already requested by <@U0ALLOWED>/);
  assert.strictEqual(s.calls.length, 1, 'double click must not commit twice');
});

test('click: a failed commit is reported, and can be retried', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0ALLOWED'], dryRunActions: false });
  let fail = true;
  s.d.client.commitMissing = async () => { if (fail) throw new Error('component not found in source org'); return 'ok'; };
  assert.match(await run(s, click('radar_commit_missing')), /Commit failed: component not found in source org/);
  assert.strictEqual(s.report.commitRequested, undefined);
  assert.match(String(s.posts[0].body.text), /^Commit requested for US-0000777/, 'acknowledged before it failed');
  fail = false;
  assert.match(await run(s, click('radar_commit_missing')), /Commit finished/);
});

test('click: no unambiguous story/components -> explains instead of guessing', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0ALLOWED'], dryRunActions: false }, 'no-action');
  assert.match(await run(s, click('radar_commit_missing')), /no unambiguous story/);
  assert.strictEqual(s.calls.length, 0);
});

test('click: only jobs ReleaseRadar announced; forged or unsigned requests do nothing', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0ALLOWED'], dryRunActions: false });
  assert.match(await run(s, click('radar_commit_missing', 'U0ALLOWED', '999')), /no longer tracked/);
  const body = click('radar_commit_missing');
  assert.strictEqual(handleInteraction(body, {}, s.d).status, 401);
  assert.strictEqual(s.calls.length, 0);
});

// ---------- pipeline ----------
test('pipeline: the action is attached only when the feature is enabled', async () => {
  const mk = (cfg: Partial<Config>) => {
    const n = new CollectNotifier();
    const cl = { getJob: async (_id: string, fb: unknown) => normalizeDetail(JOB104, fb as never) } as unknown as AgentiaClient;
    return { n, run: () => handleTransitions([{ job: { id: '104', name: 'x', status: 'Error', state: 'failure', story: 'US-0000777', stories: ['US-0000777'], storyIds: { 'US-0000777': 'a93Xx0000000777AAA' } }, to: 'failure' }], { client: cl, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, repoDir: '/nope', ...cfg } }) };
  };
  const off = mk({});
  await off.run();
  assert.strictEqual(off.n.failures[0].commitAction, undefined);
  const on = mk({ allowCommitMissing: true });
  await on.run();
  assert.deepStrictEqual(on.n.failures[0].commitAction, { story: 'US-0000777', storyId: 'a93Xx0000000777AAA', components: COMPS });
});

// ---------- truncated error text ----------
test('truncation: a cut-off last record ("...Field d") is dropped and flagged, not reported as a cause', () => {
  const a = analyze([typed(24, 'ApexClass:Cls1:Field d')]);
  assert.strictEqual(a.truncated, true);
  assert.strictEqual(a.errorCount, 24);
  assert.ok(!a.findings.some((f) => /Field d$/.test(f.message)));
  assert.match(a.explanation, /Copado cut the error text short/);
});

test('truncation: not triggered for short lists, recognisable last records, or the structured deploy report', () => {
  assert.strictEqual(analyze([typed(5, 'ApexClass:Cls1:Field d')]).truncated, false);
  assert.strictEqual(analyze([typed(24, 'ApexClass:Cls1:Variable does not exist: x')]).truncated, false);
  const rep = fs.readFileSync(path.join(FX, 'ValidationResult.sample.json'), 'utf8');
  assert.strictEqual(analyze([rep]).truncated, false);
});

test('truncation reaches the triage result', async () => {
  const job = normalizeDetail({ id: 'z', status: 'Error', errorMessage: `Metadata Validation - ${typed(24, 'ApexClass:Cls1:Field d')}` });
  const t = await triage(job as NonNullable<typeof job>);
  assert.strictEqual(t.truncated, true);
});

// ---------- CLI against the mock binary ----------
const CLI = path.join(__dirname, '../src/cli.js');
function cli(args: string[], env: Record<string, string> = {}) {
  const cfg = path.join(os.tmpdir(), `rr-cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ repoDir: '/nope' }));
  const log = path.join(os.tmpdir(), `rr-log-${Math.random().toString(36).slice(2)}.txt`);
  const r = spawnSync(process.execPath, [CLI, ...args, '--config', cfg], { encoding: 'utf8', env: { ...process.env, AGENTIA_BIN: FAKE, FAKE_LOG: log, ...env } });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
  return { out: r.stdout, err: r.stderr, code: r.status, calls };
}

test('cli commit-missing: dry run prints the plan and runs NO commit', () => {
  const r = cli(['commit-missing', '--job', '104']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Story: US-0000777/);
  assert.match(r.out, /CustomField:ACME_Invoice__c\.Discount__c/);
  assert.match(r.out, /CustomField:ACME_Plan__c\.Rate__c/);
  assert.ok(!/Account\.Status/.test(r.out), 'standard field is excluded');
  assert.match(r.out, /Dry run\. Add --run/);
  assert.ok(!r.calls.some((c) => c[1] === 'cloud'), 'no commit was sent');
});

test('cli commit-missing --run: sends one commit call per component with the computed story', () => {
  const r = cli(['commit-missing', '--job', '104', '--run']);
  assert.strictEqual(r.code, 0);
  const commits = r.calls.filter((c) => c[1] === 'cloud' && c[2] === 'commit');
  assert.strictEqual(commits.length, 2, 'one call per component');
  assert.deepStrictEqual(commits[0].slice(0, 10), ['cicd', 'cloud', 'commit', 'a93Xx0000000777AAA', '--metadata-type', 'CustomField', '--metadata-name', 'ACME_Invoice__c.Discount__c', '--metadata-category', 'SFDX']);
  assert.strictEqual(commits[1][7], 'ACME_Plan__c.Rate__c');
  assert.ok(commits.every((c) => c.includes('--wait')));
  assert.match(r.out, /Commit done[\s\S]*to confirm the failure is gone/);
});

test('cli commit-missing --run: a failing commit exits non-zero with the reason', () => {
  const r = cli(['commit-missing', '--job', '104', '--run'], { FAKE_COMMIT_FAIL: '1' });
  assert.notStrictEqual(r.code, 0);
});

test('cli commit-missing: a failure with nothing committable says so and exits 1', () => {
  const r = cli(['commit-missing', '--job', '101']); // mock job 101: compile/test/coverage problems, no missing custom field
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /Nothing safe to commit automatically/);
});

test('cli doctor --commit-help prints the real help of the commit command so the flags can be set', () => {
  const r = cli(['doctor', '--commit-help']);
  assert.match(r.out, /agentia cicd cloud commit --help/);
  assert.match(r.out, /Usage: agentia cicd cloud commit --story/);
  assert.match(r.out, /commands\.commitMissing = agentia cicd cloud commit \{storyId\} --metadata-type \{type\} --metadata-name \{name\} --metadata-category SFDX/);
});

// ---------- sample mode (test Slack without a real failure) ----------
import { sampleFailure, sampleSuccess } from '../src/sample';

test('sample failure: invented data, root causes with counts, a commit action, and an @-mention only if you configured one', () => {
  const r = sampleFailure({ storyOwners: { 'US-0000777': 'U0DEV12345' } });
  assert.match(r.triage.headline, /23 errors from 3 root causes: 3 missing fields/);
  assert.deepStrictEqual(r.commitAction?.components.map((c) => c.name).sort(), ['ACME_Billing_Plan__c.Outstanding_Amount__c', 'ACME_Installment__c.Due_On__c', 'ACME_Invoice__c.Billing_Plan__c']);
  assert.strictEqual(r.commitAction?.story, 'US-0000777');
  assert.strictEqual(r.owners[0].owner.slackId, 'U0DEV12345');
  assert.strictEqual(sampleFailure({ storyOwners: {} }).owners[0].owner.slackId, undefined);
  assert.strictEqual(sampleFailure({ storyOwners: { '*': 'UDEFAULT1' } }).owners[0].owner.slackId, 'UDEFAULT1', 'the default owner is mentioned on the sample card too');
  assert.strictEqual(sampleFailure({ storyOwners: { '*': 'UDEFAULT1', 'US-0000777': 'UEXPLICIT1' } }).owners[0].owner.slackId, 'UEXPLICIT1', 'an explicit entry wins over the default');
  const json = JSON.stringify(buildFailureBlocks(r));
  assert.match(json, /radar_commit_missing/);
  assert.match(json, /radar_details/);
  assert.match(sampleSuccess({ destinations: { 'qa-demo': 'QA Demo sandbox' }, orgUrl: undefined }).detail, /successfully deployed to QA Demo sandbox/);
});

test('cli serve --sample (console): prints the sample cards, starts the server, and forces dry run', () => {
  const cfg = path.join(os.tmpdir(), `rr-sample-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ port: 0, dryRunActions: false, allowCommitMissing: true }));
  const r = spawnSync(process.execPath, [CLI, 'serve', '--sample', '--notifier', 'console', '--config', cfg], { encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', env: { ...process.env, SLACK_SIGNING_SECRET: 's' } });
  assert.match(r.stdout, /JOB FAILED: SFDX Deploy \(validation\) · P-9001/);
  assert.match(r.stdout, /Commit 3 missing components to US-0000777/);
  assert.match(r.stdout, /\[DEPLOYED\] Deployment succeeded/);
  assert.match(r.stderr, /commit-missing DRY-RUN/, 'even with dryRunActions=false in the config, sample mode forces dry run');
});

// ---------- Slack not configured: say so, tolerate pasted quotes ----------
import { loadConfig } from '../src/config';
import { makeNotifier } from '../src/cli';
import { ConsoleNotifier, SlackNotifier } from '../src/notify';

test('config: quotes and spaces pasted around the webhook / secret are removed', () => {
  const c = loadConfig(undefined, { SLACK_WEBHOOK_URL: "  'https://hooks.slack.com/services/T/B/x' ", SLACK_SIGNING_SECRET: '"abc"' } as NodeJS.ProcessEnv);
  assert.strictEqual(c.slackWebhookUrl, 'https://hooks.slack.com/services/T/B/x');
  assert.strictEqual(c.signingSecret, 'abc');
  assert.strictEqual(loadConfig(undefined, { SLACK_WEBHOOK_URL: '   ' } as NodeJS.ProcessEnv).slackWebhookUrl, undefined);
});

test('notifier: no webhook means a LOUD fallback to the console; explicit slack without a webhook is an error; a non-Slack URL is rejected', () => {
  const logs: string[] = [];
  assert.ok(makeNotifier(undefined, { ...DEFAULTS }, (s) => logs.push(s)) instanceof ConsoleNotifier);
  assert.match(logs[0], /NOT sent to Slack/);
  assert.match(logs[0], /set SLACK_WEBHOOK_URL=/, 'tells cmd users the cmd syntax');
  const quiet: string[] = [];
  makeNotifier('console', { ...DEFAULTS }, (s) => quiet.push(s));
  assert.strictEqual(quiet.length, 0, 'asking for the console explicitly is not a warning');
  assert.throws(() => makeNotifier('slack', { ...DEFAULTS }), /SLACK_WEBHOOK_URL is not set in this window/);
  assert.throws(() => makeNotifier(undefined, { ...DEFAULTS, slackWebhookUrl: 'https://example.com/hook' }), /does not look like a Slack webhook URL/);
  assert.ok(makeNotifier(undefined, { ...DEFAULTS, slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x' }) instanceof SlackNotifier);
});

test('cli serve --sample without a webhook says plainly that nothing was sent to Slack', () => {
  const cfg = path.join(os.tmpdir(), `rr-nohook-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ port: 0 }));
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.SLACK_WEBHOOK_URL;
  const r = spawnSync(process.execPath, [CLI, 'serve', '--sample', '--config', cfg], { encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', env });
  assert.match(r.stderr, /NOTE: SLACK_WEBHOOK_URL is not set in this window/);
  assert.match(r.stderr, /only PRINTED above, not sent to Slack/);
});

// ---------- hand-edited config files ----------
test('config file: a UTF-8 byte-order mark is tolerated; invalid JSON gives a helpful error that names the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cfgfile-'));
  const ok = path.join(dir, 'ok.json');
  fs.writeFileSync(ok, '\uFEFF{ "allowedUsers": ["U1"], "allowCommitMissing": true }');
  const c = loadConfig(ok, {} as NodeJS.ProcessEnv);
  assert.deepStrictEqual([c.allowedUsers, c.allowCommitMissing], [['U1'], true]);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ "allowedUsers": ["U1"], }');
  assert.throws(() => loadConfig(bad, {} as NodeJS.ProcessEnv), (e: Error) => e.message.includes('bad.json is not valid JSON') && /trailing comma/.test(e.message));
});

test('config: a minimal hand-written file works and keeps safe defaults', () => {
  const f = path.join(os.tmpdir(), `rr-min-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ users: { 'a@b.com': 'U1' }, storyOwners: { 'US-0000777': 'U1' }, allowedUsers: ['U1'], allowActions: true, allowCommitMissing: true, destinations: { 'qa-demo': 'QA Demo sandbox' } }));
  const c = loadConfig(f, {} as NodeJS.ProcessEnv);
  assert.strictEqual(c.dryRunActions, true, 'dry run stays on unless explicitly disabled');
  assert.deepStrictEqual(c.successActions, ['all']);
  assert.deepStrictEqual(c.notifyOn, ['failure', 'success']);
  assert.strictEqual(c.repoDir, '.');
});

// ---------- a class-style unknown name is a likely missing Apex class ----------
test('class-style unknown names (PascalCase) suggest an Apex class; field-like and camelCase names do not', () => {
  const meta = (problem: string) => analyze([`Metadata Validation - ApexClass:Handler:${problem}`]).findings[0].metadata;
  assert.deepStrictEqual(meta('Variable does not exist: DiscountCalculatorService'), { type: 'ApexClass', name: 'DiscountCalculatorService' });
  assert.strictEqual(meta('Variable does not exist: customerName'), undefined, 'camelCase is a variable');
  assert.strictEqual(meta('Variable does not exist: Account'), undefined, 'a single capitalised word is not guessed');
  assert.strictEqual(meta('Variable does not exist: Some__c'), undefined);
  assert.strictEqual(meta('Variable does not exist: Foo.Bar'), undefined);
  assert.match(analyze(['Metadata Validation - ApexClass:Handler:Variable does not exist: DiscountCalculatorService']).findings[0].message, /looks like a missing Apex class/);
});

test('a class-style name that is really a missing field is merged into the field, keeping the field component', () => {
  const a = analyze(['Metadata Validation - ApexClass:H:No such column \'Total__c\' on entity \'ACME_Order__c\'.\nApexClass:H:Variable does not exist: Total__c']);
  assert.strictEqual(a.findings.length, 1);
  assert.deepStrictEqual(a.findings[0].metadata, { type: 'CustomField', name: 'ACME_Order__c.Total__c' });
});

test('commit action: a failure caused only by a missing Apex class gets the button for that class', () => {
  const a = analyze(['Metadata Validation - ApexClass:PricingHandler:Variable does not exist: DiscountCalculatorService']);
  const r = report({
    triage: { headline: a.headline, explanation: a.explanation, findings: a.findings, errorCount: a.errorCount, stories: {}, kinds: a.kinds, source: 'rules' },
    job: { id: '105', name: 'x', number: 'JE-900105', status: 'Error', state: 'failure', story: 'US-0000888', stories: ['US-0000888'] },
  });
  assert.deepStrictEqual(commitActionFor(r), { story: 'US-0000888', components: [{ type: 'ApexClass', name: 'DiscountCalculatorService' }] });
});

test('cli commit-missing on a class-style failure plans an ApexClass commit and sends nothing', () => {
  const r = cli(['commit-missing', '--job', '105']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Story: US-0000888 \(a93Xx0000000888AAA\)/);
  assert.match(r.out, /ApexClass:DiscountCalculatorService/);
  assert.match(r.out, /Dry run\. Add --run/);
  assert.ok(!r.calls.some((c) => c[1] === 'cloud'));
});

test('cli commit-missing --run: when the first call fails it stops and says nothing was committed', () => {
  const r = cli(['commit-missing', '--job', '104', '--run'], { FAKE_COMMIT_FAIL: '1' });
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.calls.filter((c) => c[1] === 'cloud' && c[2] === 'commit').length, 1, 'stopped after the first failure');
});

test('commit action carries the story record id when the job lists both ids and names in the same order', () => {
  const j = normalizeJob({ id: 'a1', name: 'JE-900200', status: 'Error', template: { name: 'SFDX Deploy' }, dataJson: JSON.stringify({ userStoryIds: ['a93Xx0000000001AAA', 'a93Xx0000000002AAA'], userStoryBranches: ['feature/US-0000777', 'feature/US-0000778'], action: 'PromotionDeployment' }) });
  assert.deepStrictEqual(j?.storyIds, { 'US-0000777': 'a93Xx0000000001AAA', 'US-0000778': 'a93Xx0000000002AAA' });
  const mismatch = normalizeJob({ id: 'a2', name: 'JE-900201', status: 'Error', dataJson: JSON.stringify({ userStoryIds: ['a93Xx0000000001AAA'], userStoryBranches: ['feature/US-0000777', 'feature/US-0000778'] }) });
  assert.strictEqual(mismatch?.storyIds, undefined, 'lists that do not line up are never guessed');
  const a = analyze(['Metadata Validation - ApexClass:Handler:Variable does not exist: DiscountCalculatorService']);
  const action = commitActionFor({ job: { story: 'US-0000777', stories: ['US-0000777'], storyIds: { 'US-0000777': 'a93Xx0000000001AAA' } }, triage: { findings: a.findings, stories: {} } });
  assert.strictEqual(action?.storyId, 'a93Xx0000000001AAA');
});

test('PMD quality-gate message is recognised (own category), cleaned of trailing JSON junk, and is not "other"', () => {
  for (const raw of ['PMD test failed. Priority 1 violations are 10 or more, which exceeds the allowed limit.', 'PMD test failed. Priority 1 violations are 10 or more, which exceeds the allowed limit.\\"}']) {
    const f = analyze([raw]).findings[0];
    assert.strictEqual(f.category, 'quality-gate');
    assert.strictEqual(f.message, 'PMD quality gate: Priority 1 violations are 10 or more, which exceeds the allowed limit.');
  }
  assert.match(analyze(['PMD test failed. x']).explanation, /quality check/i);
});

// ---------- Copado error JSON must never look like success; secrets must never leave ----------
import { parseEnvelope } from '../src/agentia';
import { resolveCommitAction } from '../src/commit';
import { redact } from '../src/redact';

test('errors: {"error": {...}} is a failure, with the api_key removed from the message', () => {
  const raw = JSON.stringify({ error: { message: 'Copado error: Invalid id: US-1. Request: POST /release/commit via https://na.api.copado.com/json/v1/webhook/cicd-api?api_key=SECRETKEY123' }, transactionId: 't' });
  assert.throws(() => parseEnvelope(raw), (e: Error) => /agentia error: Copado error: Invalid id/.test(e.message) && !e.message.includes('SECRETKEY123') && e.message.includes('api_key=[REDACTED]'));
  assert.throws(() => parseEnvelope(JSON.stringify({ error: { message: 'connect ETIMEDOUT 1.2.3.4:443', code: 'ETIMEDOUT' } })), /ETIMEDOUT/);
  assert.throws(() => parseEnvelope(JSON.stringify({ error: 'plain string failure' })), /plain string failure/);
  // real data with an error-ish word is untouched
  assert.deepStrictEqual(parseEnvelope(JSON.stringify({ result: { ok: 1 }, status: 'success' })), { ok: 1 });
  assert.deepStrictEqual(parseEnvelope(JSON.stringify({ result: { x: 1 }, error: null })), { x: 1 });
  assert.strictEqual((parseEnvelope(JSON.stringify({ id: 'a1', status: 'Error', errorMessage: 'x' })) as { id: string }).id, 'a1');
});

test('redact: api keys, tokens and emails never survive', () => {
  assert.ok(!redact('x?api_key=SECRETKEY123&y=1').includes('SECRETKEY123'));
  assert.ok(!redact('{"api-key": "abc"} apikey=zzz').includes('zzz'));
  assert.ok(!redact('mail me at dev@example.com').includes('dev@'));
});

test('commit run: Copado error JSON stops the loop and is reported as a failure, never "Done"', async () => {
  const errJson = JSON.stringify({ error: { message: 'Copado error: Invalid id. Request via https://x/cicd-api?api_key=SECRETKEY123' } });
  let calls = 0;
  const c = new AgentiaClient(async () => (calls++, errJson), DEFAULTS.commands);
  await assert.rejects(() => c.commitMissing('US-0000777', COMPS, 'm', 'a93Xx0000000777AAA'), (e: Error) => /0 of 2 commit call\(s\) succeeded before this failed/.test(e.message) && !e.message.includes('SECRETKEY123'));
  assert.strictEqual(calls, 1);
});

test('click: a failed commit reply never contains the api key', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0ALLOWED'], dryRunActions: false });
  s.d.client.commitMissing = async () => { throw new Error('boom https://x/cicd-api?api_key=SECRETKEY123'); };
  const text = await run(s, click('radar_commit_missing'));
  assert.match(text, /Commit failed/);
  assert.ok(!text.includes('SECRETKEY123'));
});

test('cli commit-missing --run: Copado error JSON exits non-zero, prints no "Done", and no api key', () => {
  const r = cli(['commit-missing', '--job', '104', '--run'], { FAKE_COMMIT_ERRORJSON: '1' });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!/Done\./.test(r.out), 'a failed commit must not say Done');
  assert.ok(!(r.out + r.err).includes('SECRETKEY123'));
  assert.match(r.err, /api_key=\[REDACTED\]/);
});

// ---------- the button needs the story record id ----------
test('commit action: offered only when the story record id is known (job data, or storyIds in the config)', () => {
  const a = analyze([JOB104.errorMessage]);
  const mk = (storyIds?: Record<string, string>) => ({ job: { story: 'US-0000777', stories: ['US-0000777'], storyIds }, triage: { findings: a.findings, stories: {} } });
  assert.strictEqual(resolveCommitAction(mk(), { ...DEFAULTS, storyIds: {} }), undefined, 'default command needs the id and none is known: no button');
  assert.strictEqual(resolveCommitAction(mk(), { ...DEFAULTS, storyIds: { 'US-0000777': 'a93Xx0000000777AAA' } })?.storyId, 'a93Xx0000000777AAA', 'config fallback');
  assert.strictEqual(resolveCommitAction(mk({ 'US-0000777': 'a93Xx0000000999AAA' }), { ...DEFAULTS, storyIds: { 'US-0000777': 'a93Xx0000000777AAA' } })?.storyId, 'a93Xx0000000999AAA', 'job data wins over the config');
  const byName = { ...DEFAULTS, commands: { ...DEFAULTS.commands, commitMissing: ['commit', '{story}', '{type}', '{name}'] } };
  assert.ok(resolveCommitAction(mk(), byName), 'a command that takes the name does not need an id');
});

test('cli commit-missing without a record id explains how to find it (and asks for nothing unsafe)', () => {
  const cfg = path.join(os.tmpdir(), `rr-noid-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({}));
  // job 101 has no missing component, so use a custom runner-free check on the fixture with ids removed
  const j = JSON.parse(JSON.stringify(JOB104));
  const d = JSON.parse(j.dataJson); delete d.userStoryIds; j.dataJson = JSON.stringify(d);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-fake-'));
  fs.cpSync(path.join(__dirname, '../../tools/fake-agentia'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixtures', 'job-104.json'), JSON.stringify(j));
  const r = spawnSync(process.execPath, [CLI, 'commit-missing', '--job', '104', '--config', cfg], { encoding: 'utf8', env: { ...process.env, AGENTIA_BIN: path.join(dir, 'agentia.js') } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /SELECT Id FROM copado__User_Story__c WHERE Name = 'US-\.\.\.'/);
  assert.match(r.stdout, /"storyIds"/);
});

test('click: the finished-commit reply carries link buttons when the org link is known', async () => {
  const s = setup({ allowCommitMissing: true, allowedUsers: ['U0ALLOWED'], dryRunActions: false, orgUrl: 'https://acme.my.salesforce.com' });
  await run(s, click('radar_commit_missing'));
  const last = s.posts[s.posts.length - 1].body;
  const row = (last.blocks as Array<{ type: string; elements?: Array<{ text: { text: string }; url: string }> }>).find((b) => b.type === 'actions');
  assert.ok(row?.elements?.some((e) => e.text.text === 'Validate in Copado ↗' && e.url.startsWith('https://acme.my.salesforce.com/')));
  assert.strictEqual(s.posts[0].body.blocks, undefined, 'the first, instant reply is plain text');
});
