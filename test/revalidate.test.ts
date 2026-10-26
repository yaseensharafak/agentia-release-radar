import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { ActionClient, ActionDeps, handleInteraction } from '../src/actions';
import { AgentiaClient, normalizeDetail } from '../src/agentia';
import { commitActionFor } from '../src/commit';
import { DEFAULTS, loadConfig } from '../src/config';
import { CollectNotifier } from '../src/notify';
import { handleTransitions } from '../src/pipeline';
import { Registry } from '../src/registry';
import { resolveRevalidateAction, revalidateContext, revalidateLabel } from '../src/revalidate';
import { sampleFailure } from '../src/sample';
import { buildFailureBlocks } from '../src/slack';
import { analyze } from '../src/triage';
import { Config, FailureReport } from '../src/types';

const FAKE = path.join(__dirname, '../../tools/fake-agentia/agentia.js');
const CLI = path.join(__dirname, '../src/cli.js');
const JOB104 = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tools/fake-agentia/fixtures/job-104.json'), 'utf8'));
const SID = 'a93Xx0000000777AAA';
const PID = 'a89Xx0000000104AAA';
// A template for TESTS only: the real flags of `agentia cicd cloud promote` must be read from its --help.
const REVAL = ['cicd', 'cloud', 'promote', '{storyId}', '--validate', '--json'];
const withReval = (extra: Partial<Config> = {}): Config => ({ ...DEFAULTS, allowActions: true, allowedUsers: ['U0ALLOWED'], commands: { ...DEFAULTS.commands, revalidate: REVAL }, ...extra });

// ---------- the command ----------
test('revalidate command: the default follows the real `cloud promote --help`; disabled (null or []) refuses with a pointer to the help', () => {
  const def = new AgentiaClient(async () => '{}', DEFAULTS.commands);
  assert.deepStrictEqual(def.revalidateCommand({ storyId: SID, promotionId: PID }), ['cicd', 'cloud', 'promote', SID, '--promotion-id', PID, '--deploy', '--recreate-promotion-branch', '--yes', '--wait', '--json']);
  for (const off of [undefined, [] as string[]]) {
    const c = new AgentiaClient(async () => '{}', { ...DEFAULTS.commands, revalidate: off });
    assert.throws(() => c.revalidateCommand({ storyId: SID }), /disabled or not configured[\s\S]*cli-help cicd cloud promote/);
  }
});

test('revalidate command: fills only what the template uses, and refuses missing or odd ids', () => {
  const mk = (tpl: string[]) => new AgentiaClient(async () => '{}', { ...DEFAULTS.commands, revalidate: tpl });
  assert.deepStrictEqual(mk(REVAL).revalidateCommand({ storyId: SID }), ['cicd', 'cloud', 'promote', SID, '--validate', '--json']);
  assert.throws(() => mk(REVAL).revalidateCommand({}), /needs the story's Copado record id/);
  assert.throws(() => mk(REVAL).revalidateCommand({ storyId: 'bad id; rm' }), /needs the story's Copado record id/);
  assert.deepStrictEqual(mk(['promote', '{promotionId}']).revalidateCommand({ promotionId: PID }), ['promote', PID], 'a promotion-level command needs no story');
  assert.throws(() => mk(['promote', '{promotionId}']).revalidateCommand({}), /needs the promotion record id/);
  assert.deepStrictEqual(mk(['p', '{story}', '{message}']).revalidateCommand({ story: 'us-0000777', message: 'a\nb' }), ['p', 'US-0000777', 'a b']);
  assert.throws(() => mk(['p', '{story}']).revalidateCommand({ story: 'x; rm' }), /single user story id/);
});

test('revalidate run: an error reply is a failure, never success, and carries no api key', async () => {
  const c = new AgentiaClient(async () => JSON.stringify({ error: { message: 'nope https://x/cicd-api?api_key=SECRETKEY123' } }), { ...DEFAULTS.commands, revalidate: REVAL });
  await assert.rejects(() => c.revalidate({ storyId: SID }), (e: Error) => /agentia error: nope/.test(e.message) && !e.message.includes('SECRETKEY123'));
  const ok = new AgentiaClient(async () => JSON.stringify({ result: { promotion: 'P-1' }, status: 'success' }), { ...DEFAULTS.commands, revalidate: REVAL });
  assert.match(await ok.revalidate({ storyId: SID }), /P-1/);
});

// ---------- when the action is offered ----------
const job = { story: 'US-0000777', stories: ['US-0000777'], storyIds: { 'US-0000777': SID }, promotionId: PID, promotion: 'P-9104', dryRun: true };

test('revalidate action: offered only when configured AND re-run actions are allowed AND the ids the command needs are known', () => {
  assert.strictEqual(resolveRevalidateAction(job, { ...DEFAULTS }), undefined, 'actions not allowed by default');
  assert.strictEqual(resolveRevalidateAction(job, withReval({ commands: { ...DEFAULTS.commands, revalidate: undefined } })), undefined, 'disabled (null)');
  assert.strictEqual(resolveRevalidateAction(job, withReval({ commands: { ...DEFAULTS.commands, revalidate: [] } })), undefined, 'disabled ([])');
  assert.strictEqual(resolveRevalidateAction({ ...job, dryRun: false }, withReval()), undefined, 'a REAL deployment is never re-run with --deploy');
  assert.strictEqual(resolveRevalidateAction({ ...job, dryRun: undefined }, withReval()), undefined, 'unknown kind of job: not offered');
  assert.strictEqual(resolveRevalidateAction(job, withReval({ allowActions: false })), undefined, 'actions not allowed');
  assert.deepStrictEqual(resolveRevalidateAction(job, withReval()), { story: 'US-0000777', storyId: SID, promotionId: PID, promotion: 'P-9104' });
  assert.strictEqual(resolveRevalidateAction({ ...job, promotionId: undefined }, { ...withReval(), commands: { ...DEFAULTS.commands } }), undefined, 'the default command needs the promotion id too');
  assert.strictEqual(resolveRevalidateAction({ ...job, storyIds: undefined }, withReval()), undefined, 'needs a record id and none is known');
  assert.strictEqual(resolveRevalidateAction({ ...job, storyIds: undefined }, withReval({ storyIds: { 'US-0000777': SID } }))?.storyId, SID, 'config fallback');
  assert.strictEqual(resolveRevalidateAction({ ...job, stories: ['US-1', 'US-2'] }, withReval()), undefined, 'two stories: no guess');
  const byPromo = withReval({ commands: { ...DEFAULTS.commands, revalidate: ['promote', '{promotionId}'] } });
  assert.ok(resolveRevalidateAction({ ...job, stories: ['US-1', 'US-2'], storyIds: undefined }, byPromo), 'a promotion-level command works with several stories');
  assert.strictEqual(revalidateContext({ story: 'US-0000777' }, { storyIds: {} }).story, 'US-0000777');
  assert.ok(revalidateLabel({ story: 'US-0000777' }).length <= 75);
  assert.strictEqual(revalidateLabel({ promotion: 'P-9104' }), 'Re-validate promotion P-9104');
});

const report = (over: Partial<FailureReport> = {}): FailureReport => {
  const a = analyze([JOB104.errorMessage]);
  const r: FailureReport = {
    job: { id: '104', name: 'SFDX Deploy (validation) · P-9104 [JE-900104]', number: 'JE-900104', status: 'Error', state: 'failure', ...job },
    triage: { headline: a.headline, explanation: a.explanation, findings: a.findings, errorCount: a.errorCount, stories: a.stories, kinds: a.kinds, source: 'rules' },
    owners: [], at: 'now', ...over,
  };
  r.commitAction = commitActionFor(r);
  r.revalidateAction = resolveRevalidateAction(r.job, withReval());
  return r;
};

test('button: Re-validate appears only when the action exists, carries only the job id, and sits between Commit and Re-run', () => {
  const none = report({}); none.revalidateAction = undefined;
  assert.ok(!JSON.stringify(buildFailureBlocks(none).blocks).includes('radar_revalidate'));
  const btns = (buildFailureBlocks(report()).blocks.find((b) => b.type === 'actions') as { elements: Array<Record<string, any>> }).elements;
  assert.deepStrictEqual(btns.map((b) => b.action_id), ['radar_details', 'radar_commit_missing', 'radar_revalidate', 'radar_rerun']);
  const b = btns[2];
  assert.strictEqual(b.text.text, 'Re-validate US-0000777');
  assert.strictEqual(b.value, '104');
  assert.match(b.confirm.text.text, /new commits are included/);
  assert.match(b.confirm.text.text, /check-only/);
});

// ---------- the click handler ----------
const SECRET = 's3cret';
const NOW = 1_800_000_000;
const sign = (body: string): Record<string, string> => ({ 'x-slack-request-timestamp': String(NOW), 'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${NOW}:${body}`).digest('hex')}` });
const click = (id: string, user = 'U0ALLOWED', value = '104'): string => 'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: user }, response_url: 'https://hooks.slack.com/actions/T/B/x', actions: [{ action_id: id, value }] }));

function setup(over: Partial<Config> = {}, mutate?: (r: FailureReport) => void) {
  const posts: string[] = [];
  const calls = { reval: 0, commit: 0, rerun: 0, ctx: [] as unknown[] };
  const registry = new Registry();
  const r = report();
  mutate?.(r);
  registry.set(r);
  const real = new AgentiaClient(async () => '{}', { ...DEFAULTS.commands, revalidate: REVAL });
  const client: ActionClient = {
    rerun: async () => (calls.rerun++, 'rerun ok'),
    commitCommands: (s, c, m, id) => real.commitCommands(s, c, m, id),
    commitMissing: async () => (calls.commit++, 'commit ok'),
    revalidateCommand: (ctx) => real.revalidateCommand(ctx),
    revalidate: async (ctx) => (calls.reval++, calls.ctx.push(ctx), 'revalidate ok'),
  };
  const d: ActionDeps = { cfg: withReval({ signingSecret: SECRET, allowCommitMissing: true, ...over }), registry, client, post: async (_u, body) => void posts.push(String((body as { text: string }).text)), nowSeconds: () => NOW };
  return { d, posts, calls, report: r };
}
const run = async (s: ReturnType<typeof setup>, body: string): Promise<string> => { const r = handleInteraction(body, sign(body), s.d); await r.done; return s.posts[s.posts.length - 1] ?? ''; };

test('click re-validate: disabled, not allow-listed, or not configured -> refused, nothing runs', async () => {
  assert.match(await run(setup({ allowActions: false }), click('radar_revalidate')), /disabled/);
  assert.match(await run(setup({ allowedUsers: ['U0OTHER'] }), click('radar_revalidate')), /not on the allow-list/);
  const s = setup({}, (r) => { r.revalidateAction = undefined; });
  assert.match(await run(s, click('radar_revalidate')), /not configured for this failure/);
  assert.strictEqual(s.calls.reval, 0);
});

test('click re-validate: DRY RUN by default shows the exact command; a live run happens once; a failure can be retried', async () => {
  const dry = setup();
  const text = await run(dry, click('radar_revalidate'));
  assert.match(text, /Dry run: would re-create the validation promotion branch and validate again \(Re-validate US-0000777\)/);
  assert.match(text, new RegExp(`agentia cicd cloud promote ${SID} --validate --json`));
  assert.strictEqual(dry.calls.reval, 0);

  const live = setup({ dryRunActions: false });
  assert.match(await run(live, click('radar_revalidate')), /Re-validation requested by <@U0ALLOWED>/);
  assert.match(await run(live, click('radar_revalidate')), /Already requested/);
  assert.strictEqual(live.calls.reval, 1, 'no duplicate validation from a double click');

  const flaky = setup({ dryRunActions: false });
  let fail = true;
  flaky.d.client.revalidate = async () => { if (fail) throw new Error('api_key=SECRETKEY123 timeout'); return 'ok'; };
  const failText = await run(flaky, click('radar_revalidate'));
  assert.match(failText, /Re-validation failed/);
  assert.ok(!failText.includes('SECRETKEY123'));
  fail = false;
  assert.match(await run(flaky, click('radar_revalidate')), /Re-validation requested/);
});

// ---------- per-action live switches ----------
test('liveActions: commit can be LIVE while re-run and re-validate stay DRY RUN', async () => {
  const s = setup({ liveActions: ['commit'] });
  assert.match(await run(s, click('radar_commit_missing')), /Commit finished/);
  assert.match(await run(s, click('radar_rerun')), /Dry run: would ask Copado to re-run/);
  assert.match(await run(s, click('radar_revalidate')), /Dry run: would re-create the validation promotion branch/);
  assert.deepStrictEqual([s.calls.commit, s.calls.rerun, s.calls.reval], [1, 0, 0]);
});

test('liveActions: re-run live only; dryRunActions=false still makes everything live (old behaviour)', async () => {
  const a = setup({ liveActions: ['rerun'] });
  assert.match(await run(a, click('radar_rerun')), /Re-run requested for/);
  assert.strictEqual(a.calls.rerun, 1);
  const all = setup({ dryRunActions: false });
  await run(all, click('radar_rerun')); await run(all, click('radar_revalidate'));
  assert.deepStrictEqual([all.calls.rerun, all.calls.reval], [1, 1]);
});

test('config: RADAR_LIVE_ACTIONS (env) lists live actions, case-insensitively', () => {
  assert.deepStrictEqual(loadConfig(undefined, { RADAR_LIVE_ACTIONS: ' Commit, rerun ' } as NodeJS.ProcessEnv).liveActions, ['commit', 'rerun']);
  // Defaults must not depend on a radar.config.json that happens to sit in the working directory
  // (a real one with "liveActions": ["commit"] made this test fail on a developer machine).
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-nocfg-'));
  const here = process.cwd();
  process.chdir(empty);
  try {
    assert.deepStrictEqual(loadConfig(undefined, {} as NodeJS.ProcessEnv).liveActions, []);
    assert.strictEqual(loadConfig(undefined, {} as NodeJS.ProcessEnv).autoRevalidate, false);
  } finally {
    process.chdir(here);
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// ---------- automatic re-validation after a live commit ----------
test('autoRevalidate: after a live commit it starts one new validation; in dry mode it only shows the command; off by default', async () => {
  const live = setup({ liveActions: ['commit', 'revalidate'], autoRevalidate: true });
  await run(live, click('radar_commit_missing'));
  assert.strictEqual(live.calls.commit, 1);
  assert.strictEqual(live.calls.reval, 1);
  assert.ok(live.posts.some((p) => /Re-validation requested/.test(p)));
  assert.deepStrictEqual((live.calls.ctx[0] as { storyId: string }).storyId, SID);

  const dry = setup({ liveActions: ['commit'], autoRevalidate: true });
  await run(dry, click('radar_commit_missing'));
  assert.strictEqual(dry.calls.reval, 0);
  assert.ok(dry.posts.some((p) => /Dry run: would now re-validate/.test(p)));

  const off = setup({ liveActions: ['commit', 'revalidate'] });
  await run(off, click('radar_commit_missing'));
  assert.strictEqual(off.calls.reval, 0);
  assert.match(off.posts[off.posts.length - 1], /Use the Re-validate button/);
});

// ---------- pipeline + sample ----------
test('pipeline: the Re-validate action is attached only when configured and allowed', async () => {
  const mk = async (cfg: Config) => {
    const client = new AgentiaClient(async () => JSON.stringify({ result: JOB104, status: 'success' }), cfg.commands);
    const n = new CollectNotifier();
    await handleTransitions([{ job: { id: '104', name: 'x', status: 'Error', state: 'failure', story: 'US-0000777', stories: ['US-0000777'], storyIds: { 'US-0000777': SID }, promotionId: PID }, to: 'failure' }], { client, notifier: n, registry: new Registry(), cfg: { ...cfg, repoDir: '/nope' } });
    return n.failures[0].revalidateAction;
  };
  assert.strictEqual(await mk({ ...DEFAULTS }), undefined);
  assert.strictEqual((await mk(withReval()))?.storyId, SID);
});

test('sample card shows the Re-validate button when re-run actions are allowed, and not when the command is disabled', () => {
  assert.strictEqual(sampleFailure({ storyOwners: {} }).revalidateAction, undefined, 'no config given');
  assert.strictEqual(sampleFailure({ storyOwners: {}, commands: DEFAULTS.commands, allowActions: false }).revalidateAction, undefined, 'actions not allowed');
  assert.strictEqual(sampleFailure({ storyOwners: {}, commands: { ...DEFAULTS.commands, revalidate: undefined }, allowActions: true }).revalidateAction, undefined, 'disabled');
  const r = sampleFailure({ storyOwners: {}, commands: DEFAULTS.commands, allowActions: true });
  assert.strictEqual(r.revalidateAction?.story, 'US-0000777');
  assert.match(JSON.stringify(buildFailureBlocks(r).blocks), /radar_revalidate/);
});

// ---------- CLI against the mock binary ----------
function cli(args: string[], cfgObj: object = {}, env: Record<string, string> = {}) {
  const cfg = path.join(os.tmpdir(), `rr-rv-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ repoDir: '/nope', ...cfgObj }));
  const log = path.join(os.tmpdir(), `rr-rvlog-${Math.random().toString(36).slice(2)}.txt`);
  const r = spawnSync(process.execPath, [CLI, ...args, '--config', cfg], { encoding: 'utf8', env: { ...process.env, AGENTIA_BIN: FAKE, FAKE_LOG: log, ...env } });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
  return { out: r.stdout, err: r.stderr, code: r.status, calls };
}
const CFG = { commands: { revalidate: REVAL } };

test('cli cli-help: prints the real help of any agentia command, and rejects odd input', () => {
  const r = cli(['cli-help', 'cicd', 'cloud', 'promote']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Usage: agentia cicd cloud promote/);
  assert.strictEqual(cli(['cli-help', 'cicd; rm', 'x']).code, 1);
  assert.strictEqual(cli(['cli-help']).code, 1);
});

test('cli revalidate: dry run shows the command and sends nothing; --run sends exactly one call with the story record id', () => {
  const dry = cli(['revalidate', '--job', '104'], CFG);
  assert.strictEqual(dry.code, 0);
  assert.match(dry.out, new RegExp(`Story: US-0000777 \\(${SID}\\)   Promotion: P-9104 \\(${PID}\\)`));
  assert.match(dry.out, new RegExp(`Command: agentia cicd cloud promote ${SID} --validate --json`));
  assert.match(dry.out, /Dry run\. Add --run/);
  assert.ok(!dry.calls.some((c) => c[2] === 'promote'));
  const live = cli(['revalidate', '--job', '104', '--run'], CFG);
  assert.strictEqual(live.code, 0);
  const promotes = live.calls.filter((c) => c[1] === 'cloud' && c[2] === 'promote');
  assert.strictEqual(promotes.length, 1);
  assert.deepStrictEqual(promotes[0], ['cicd', 'cloud', 'promote', SID, '--validate', '--json']);
  assert.match(live.out, /Re-validation finished or was requested/);
});

test('cli revalidate: disabled -> clear error; Copado error JSON -> non-zero, no success message, no api key', () => {
  const unconfigured = cli(['revalidate', '--job', '104'], { commands: { revalidate: null } });
  assert.notStrictEqual(unconfigured.code, 0);
  assert.match(unconfigured.err, /disabled or not configured/);
  const failing = cli(['revalidate', '--job', '104', '--run'], CFG, { FAKE_PROMOTE_FAIL: '1' });
  assert.notStrictEqual(failing.code, 0);
  assert.ok(!/Re-validation finished or was requested/.test(failing.out));
  assert.ok(!(failing.out + failing.err).includes('SECRETKEY123'));
});

test('cli commit-missing --run --revalidate: commits first, then starts the validation; without --revalidate it only advises', () => {
  const both = cli(['commit-missing', '--job', '104', '--run', '--revalidate'], CFG);
  assert.strictEqual(both.code, 0);
  const order = both.calls.filter((c) => c[1] === 'cloud').map((c) => c[2]);
  assert.deepStrictEqual(order, ['commit', 'commit', 'promote'], 'two component commits, then one validation');
  assert.match(both.out, /Re-validation requested\. Watch for the result/);
  const plain = cli(['commit-missing', '--job', '104', '--run'], CFG);
  assert.ok(!plain.calls.some((c) => c[2] === 'promote'));
  assert.match(plain.out, /Add --revalidate \(or run: revalidate --job <id> --run\)/);
  const auto = cli(['commit-missing', '--job', '104', '--run'], { ...CFG, autoRevalidate: true });
  assert.ok(auto.calls.some((c) => c[2] === 'promote'), 'autoRevalidate in the config starts it without the flag');
});

test('cli commit-missing --run --revalidate: if the commit fails, no validation is started', () => {
  const r = cli(['commit-missing', '--job', '104', '--run', '--revalidate'], CFG, { FAKE_COMMIT_FAIL: '1' });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!r.calls.some((c) => c[2] === 'promote'));
});

test('cli revalidate (default command from the real help): plans and runs the exact cloud promote call for a validation', () => {
  const dry = cli(['revalidate', '--job', '104']);
  assert.strictEqual(dry.code, 0);
  assert.match(dry.out, new RegExp(`Command: agentia cicd cloud promote ${SID} --promotion-id ${PID} --deploy --recreate-promotion-branch --yes --wait --json`));
  assert.match(dry.out, /check-only, because the failed job was a validation/);
  assert.ok(!dry.calls.some((c) => c[2] === 'promote'));
  const live = cli(['revalidate', '--job', '104', '--run']);
  assert.strictEqual(live.code, 0);
  const p = live.calls.filter((c) => c[1] === 'cloud' && c[2] === 'promote');
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual(p[0], ['cicd', 'cloud', 'promote', SID, '--promotion-id', PID, '--deploy', '--recreate-promotion-branch', '--yes', '--wait', '--json']);
});

test('cli revalidate refuses a REAL deployment failure (the command would deploy), and commit-missing --revalidate commits but does not promote it', () => {
  const r = cli(['revalidate', '--job', '106', '--run']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /not a validation[\s\S]*ReleaseRadar refuses/);
  assert.ok(!r.calls.some((c) => c[2] === 'promote'), 'nothing was promoted or deployed');
  const c = cli(['commit-missing', '--job', '106', '--run', '--revalidate']);
  assert.strictEqual(c.code, 0);
  assert.ok(c.calls.some((x) => x[2] === 'commit'), 'the commit itself is still fine');
  assert.ok(!c.calls.some((x) => x[2] === 'promote'));
  assert.match(c.out, /not a validation, so re-validate in Copado by hand/);
});

test('Slack: a failed REAL deployment gets no Re-validate button even with everything enabled', async () => {
  const j106 = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tools/fake-agentia/fixtures/job-106.json'), 'utf8'));
  const client = new AgentiaClient(async () => JSON.stringify({ result: j106, status: 'success' }), DEFAULTS.commands);
  const n = new CollectNotifier();
  await handleTransitions([{ job: { id: '106', name: 'x', status: 'Error', state: 'failure', story: 'US-0000777', stories: ['US-0000777'], storyIds: { 'US-0000777': SID }, promotionId: 'a89Xx0000000106AAA', dryRun: false }, to: 'failure' }], { client, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, allowActions: true, repoDir: '/nope' } });
  assert.strictEqual(n.failures[0].revalidateAction, undefined);
});
