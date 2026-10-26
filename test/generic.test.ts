import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { AgentiaClient, extractPerson, matchesStory } from '../src/agentia';
import { loadConfig, DEFAULTS } from '../src/config';
import { describeSuccess, destinationName } from '../src/describe';
import { CollectNotifier } from '../src/notify';
import { ownersForTriage } from '../src/owners';
import { handleTransitions } from '../src/pipeline';
import { Registry } from '../src/registry';
import { Config, JobSummary } from '../src/types';

const FIX = path.join(__dirname, '../../tools/fake-agentia/fixtures');
const WORK = JSON.parse(fs.readFileSync(path.join(FIX, 'work-list.json'), 'utf8'));
const JOB104 = JSON.parse(fs.readFileSync(path.join(FIX, 'job-104.json'), 'utf8'));
const FAKE = path.join(__dirname, '../../tools/fake-agentia/agentia.js');
const CLI = path.join(__dirname, '../src/cli.js');

// ---------- destination: works with no config; friendly names are optional and can use patterns ----------
test('destination: with no mapping the branch name itself is shown, for any destination', () => {
  assert.strictEqual(destinationName('qa1', undefined), 'qa1');
  assert.strictEqual(destinationName('anything-at-all', {}), 'anything-at-all');
  assert.strictEqual(destinationName(undefined, { x: 'y' }), undefined);
});

test('destination: exact, case-insensitive and * patterns map to friendly names; regex characters in a pattern are harmless', () => {
  const m = { 'qa1': 'QA1 sandbox', 'uat*': 'UAT', '*prod*': 'Production', 'a.b*': 'Dotted' };
  assert.strictEqual(destinationName('qa1', m), 'QA1 sandbox');
  assert.strictEqual(destinationName('QA1', m), 'QA1 sandbox');
  assert.strictEqual(destinationName('uat2', m), 'UAT');
  assert.strictEqual(destinationName('release-prod-eu', m), 'Production');
  assert.strictEqual(destinationName('a.bz', m), 'Dotted');
  assert.strictEqual(destinationName('axb', m), 'axb', 'the dot in a pattern is literal, not "any character"');
  assert.strictEqual(destinationName('dev9', m), 'dev9');
});

test('success message uses the friendly name when mapped and the branch otherwise', () => {
  const job: JobSummary = { id: 'a', name: 'n', status: 's', state: 'success', action: 'PromotionDeployment', dryRun: false, destination: 'uat7', stories: ['US-0000001'] };
  assert.match(describeSuccess(job, { destinations: { 'uat*': 'UAT' }, orgUrl: undefined }).detail, /successfully deployed to UAT\./);
  assert.match(describeSuccess(job, { destinations: {}, orgUrl: undefined }).detail, /successfully deployed to uat7\./);
});

// ---------- user story: shown for every job; one default owner covers all stories ----------
test('config: defaultOwner becomes the "*" story owner, and explicit stories still win', () => {
  const f = path.join(os.tmpdir(), `rr-def-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ defaultOwner: 'UDEFAULT1', storyOwners: { 'US-0000001': 'UEXPLICIT1' } }));
  const c = loadConfig(f, {} as NodeJS.ProcessEnv);
  assert.deepStrictEqual(c.storyOwners, { '*': 'UDEFAULT1', 'US-0000001': 'UEXPLICIT1' });
});

const fnd = (...affects: string[]) => [{ category: 'missing-dependency' as const, message: 'x', affects }];

test('owners: any story is mentioned through the default owner with no per-story config', () => {
  const o = ownersForTriage('/nope', fnd('A'), { A: 'US-0000042' }, {}, { '*': 'UDEFAULT1' }, 'x');
  assert.deepStrictEqual([o[0].owner.story, o[0].owner.slackId], ['US-0000042', 'UDEFAULT1']);
  const none = ownersForTriage('/nope', fnd('A'), { A: 'US-0000042' }, {}, {}, 'x');
  assert.strictEqual(none[0].owner.slackId, undefined, 'no default and no mapping: story shown, nobody pinged');
});

test('owners: precedence is explicit story entry, then the developer found in Copado, then the default', () => {
  const people = { 'US-0000042': { name: 'Dana', slackId: 'UDANA' } };
  const base = (owners: Record<string, string>) => ownersForTriage('/nope', fnd('A'), { A: 'US-0000042' }, {}, owners, 'x', 5, undefined, people)[0].owner;
  assert.strictEqual(base({ 'US-0000042': 'UEXPLICIT', '*': 'UDEFAULT' }).slackId, 'UEXPLICIT');
  assert.strictEqual(base({ '*': 'UDEFAULT' }).slackId, 'UDANA');
  assert.strictEqual(base({ '*': 'UDEFAULT' }).name, 'Dana');
  assert.strictEqual(ownersForTriage('/nope', fnd('A'), { A: 'US-0000099' }, {}, { '*': 'UDEFAULT' }, 'x', 5, undefined, people)[0].owner.slackId, 'UDEFAULT');
});

test('owners: the story-only fallback (a failure naming no component) also uses developer and default', () => {
  const o = ownersForTriage('/nope', [{ category: 'coverage', message: 'x' }], {}, {}, { '*': 'UDEFAULT' }, 'x', 5, 'US-0000042', { 'US-0000042': { name: 'Dana' } });
  assert.deepStrictEqual([o[0].owner.name, o[0].owner.slackId, o[0].owner.story], ['Dana', 'UDEFAULT', 'US-0000042']);
});

// ---------- optional developer lookup ----------
test('story developer: found from an object, from a plain string, or reported unknown; matching ignores case', () => {
  assert.deepStrictEqual(extractPerson(WORK[0]), { name: 'Dana Developer', email: 'dana@example.com' });
  assert.deepStrictEqual(extractPerson(WORK[1]), { name: 'Sam Developer' });
  assert.deepStrictEqual(extractPerson({ owner: 'x@y.com' }), { email: 'x@y.com' });
  assert.strictEqual(extractPerson(WORK[2]), undefined);
  assert.ok(matchesStory(WORK[0], 'us-0000777'));
  assert.ok(!matchesStory(WORK[0], 'US-0000778'));
});

test('story developer: OFF unless commands.storyInfo is set; cached; failures mean unknown, never an error', async () => {
  let calls = 0;
  const runner = async () => (calls++, JSON.stringify({ result: { data: WORK }, status: 'success' }));
  const off = new AgentiaClient(runner, DEFAULTS.commands);
  assert.strictEqual(await off.storyPerson('US-0000777'), undefined);
  assert.strictEqual(calls, 0, 'nothing is called when the feature is not configured');
  const on = new AgentiaClient(runner, { ...DEFAULTS.commands, storyInfo: ['cicd', 'work', 'list', '--json'] });
  assert.deepStrictEqual(await on.storyPerson('US-0000777'), { name: 'Dana Developer', email: 'dana@example.com' });
  await on.storyPerson('US-0000777');
  assert.strictEqual(calls, 1, 'second lookup is cached');
  assert.strictEqual(await on.storyPerson('not-a-story; rm -rf'), undefined);
  const broken = new AgentiaClient(async () => { throw new Error('boom'); }, { ...DEFAULTS.commands, storyInfo: ['x'] });
  assert.strictEqual(await broken.storyPerson('US-0000777'), undefined);
});

test('pipeline: with the lookup on, the developer is mapped to Slack through your users map; without a mapping they are named but not pinged', async () => {
  const runner = async (argv: string[]) => {
    if (argv[1] === 'work') return JSON.stringify({ result: { data: WORK }, status: 'success' });
    return JSON.stringify({ result: JOB104, status: 'success' });
  };
  const run = async (users: Record<string, string>, extra: Partial<Config> = {}) => {
    const commands = { ...DEFAULTS.commands, storyInfo: ['cicd', 'work', 'list', '--json'] };
    const client = new AgentiaClient(runner, commands);
    const n = new CollectNotifier();
    await handleTransitions([{ job: { id: '104', name: 'x', status: 'Error', state: 'failure', story: 'US-0000777', stories: ['US-0000777'] }, to: 'failure' }], { client, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, commands, repoDir: '/nope', users, ...extra } });
    return n.failures[0].owners[0].owner;
  };
  const mapped = await run({ 'dana@example.com': 'UDANA00001' });
  assert.deepStrictEqual([mapped.name, mapped.slackId, mapped.story], ['Dana Developer', 'UDANA00001', 'US-0000777']);
  const byName = await run({ 'Dana Developer': 'UDANA00002' });
  assert.strictEqual(byName.slackId, 'UDANA00002');
  const unmapped = await run({});
  assert.deepStrictEqual([unmapped.name, unmapped.slackId], ['Dana Developer', undefined]);
  const withDefault = await run({}, { storyOwners: { '*': 'UDEFAULT1' } });
  assert.strictEqual(withDefault.slackId, 'UDEFAULT1');
});

test('pipeline: without commands.storyInfo no lookup is attempted at all', async () => {
  let workCalls = 0;
  const runner = async (argv: string[]) => (argv[1] === 'work' ? (workCalls++, '{}') : JSON.stringify({ result: JOB104, status: 'success' }));
  const client = new AgentiaClient(runner, DEFAULTS.commands);
  const n = new CollectNotifier();
  await handleTransitions([{ job: { id: '104', name: 'x', status: 'Error', state: 'failure', story: 'US-0000777', stories: ['US-0000777'] }, to: 'failure' }], { client, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, repoDir: '/nope' } });
  assert.strictEqual(workCalls, 0);
  assert.strictEqual(n.failures[0].owners[0].owner.story, 'US-0000777');
});

// ---------- doctor --story ----------
function doctorStory(story: string) {
  const cfg = path.join(os.tmpdir(), `rr-ds-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfg, JSON.stringify({}));
  return spawnSync(process.execPath, [CLI, 'doctor', '--story', story, '--config', cfg], { encoding: 'utf8', env: { ...process.env, AGENTIA_BIN: FAKE } }).stdout;
}

test('doctor --story shows what Copado returns and whether a developer was recognised', () => {
  assert.match(doctorStory('US-0000777'), /developer: Dana Developer dana@example\.com/);
  assert.match(doctorStory('US-0000777'), /\(a suggestion; set commands\.storyInfo to use it\)/);
  assert.match(doctorStory('US-0000779'), /no developer\/owner field recognised/);
  assert.match(doctorStory('US-9999999'), /not found in the output/);
});
