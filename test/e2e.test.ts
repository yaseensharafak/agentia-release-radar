import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AgentiaClient, defaultRunner } from '../src/agentia';
import { pollOnce } from '../src/cli';
import { DEFAULTS } from '../src/config';
import { ConsoleNotifier } from '../src/notify';
import { JobTracker } from '../src/poller';
import { Registry } from '../src/registry';
import { Config } from '../src/types';

const FAKE = path.join(__dirname, '../../tools/fake-agentia/agentia.js');

function setup(over: Partial<Config> = {}, env: Record<string, string> = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-e2e-'));
  execFileSync(process.execPath, [path.join(__dirname, '../../tools/make-demo-repo.js'), repo], { stdio: 'ignore' });
  const state = path.join(os.tmpdir(), `radar-state-${Math.random().toString(36).slice(2)}.json`);
  process.env.AGENTIA_BIN = FAKE;
  process.env.FAKE_STATE = state;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const cfg: Config = { ...DEFAULTS, repoDir: repo, users: { 'priya@example.com': 'U0PRIYA01', 'marcus@example.com': 'U0MARCUS1' }, ...over };
  const lines: string[] = [];
  const registry = new Registry();
  const client = new AgentiaClient(defaultRunner, cfg.commands);
  const deps = { client, notifier: new ConsoleNotifier((s) => lines.push(s)), registry, cfg };
  return { deps, client, lines, registry, cleanup: () => { for (const k of ['AGENTIA_BIN', 'FAKE_STATE', 'FAKE_WARN', 'FAKE_AI']) delete process.env[k]; } };
}

test('e2e: poll 1 baseline, poll 2 failure -> triage card with owners, poll 3 success; through the real child-process path', async () => {
  const s = setup({ aiEnabled: false }, { FAKE_WARN: '1' });
  try {
    const t = new JobTracker();
    assert.strictEqual(await pollOnce(s.client, t, s.deps, false), 0, 'baseline: no alerts for existing jobs');
    assert.strictEqual(s.lines.length, 0);

    assert.ok((await pollOnce(s.client, t, s.deps, false)) >= 1);
    const card = s.lines.join('\n');
    assert.match(card, /JOB FAILED: Validate US-0000142 to UAT/);
    assert.match(card, /PaymentCalculator\.cls:45/);
    assert.match(card, /PaymentCalculatorTest\.testMonthlyBenefit:31/);
    assert.match(card, /62%/);
    assert.match(card, /Claim__c\.Appeal_Status__c/);
    assert.match(card, /@U0PRIYA01 · US-0000142/, 'Priya owns PaymentCalculator and its test');
    assert.match(card, /@U0MARCUS1 · US-0000151/, 'Marcus owns the Appeal_Status__c field');
    assert.match(card, /rules/);
    assert.ok(!/abcdef1234567890|dev@example\.com/.test(card), 'secrets in the raw log never appear on the card');
    assert.ok(s.registry.get('101'), 'failure registered so buttons can act on it');
    assert.ok(s.lines.some((l) => /succeeded/.test(l)) === false, 'job 102 was already successful at baseline');

    await pollOnce(s.client, t, s.deps, false);
    assert.ok(s.lines.some((l) => /Validate US-0000151 to UAT succeeded/.test(l)));
  } finally {
    s.cleanup();
  }
});

test('e2e: with AI enabled the summary comes from the agent and the card says so; if AI is down it falls back to rules', async () => {
  const withAi = setup({ aiEnabled: true });
  try {
    const t = new JobTracker();
    await pollOnce(withAi.client, t, withAi.deps, false);
    await pollOnce(withAi.client, t, withAi.deps, false);
    const card = withAi.lines.join('\n');
    assert.match(card, /MOCK AI ANSWER/);
    assert.match(card, /AI \(verify\)/);
  } finally {
    withAi.cleanup();
  }
  const down = setup({ aiEnabled: true }, { FAKE_AI: 'off' });
  try {
    const t = new JobTracker();
    await pollOnce(down.client, t, down.deps, false);
    await pollOnce(down.client, t, down.deps, false);
    const card = down.lines.join('\n');
    assert.ok(!/MOCK AI ANSWER/.test(card));
    assert.match(card, /Apex compile error/);
  } finally {
    down.cleanup();
  }
});

test('e2e: --include-existing reports a job that is already failed when the radar starts', async () => {
  const s = setup();
  try {
    fs.writeFileSync(process.env.FAKE_STATE as string, JSON.stringify({ n: 1 })); // start at poll 2
    const n = await pollOnce(s.client, new JobTracker(), s.deps, true);
    assert.ok(n >= 1);
    assert.match(s.lines.join('\n'), /JOB FAILED/);
  } finally {
    s.cleanup();
  }
});

test('e2e: a job that cannot be read does not stop the others', async () => {
  const s = setup();
  try {
    const bad = new AgentiaClient(async (argv) => {
      if (argv.includes('get')) throw new Error('boom');
      return defaultRunner(argv);
    }, DEFAULTS.commands);
    const logs: string[] = [];
    const t = new JobTracker();
    const deps = { ...s.deps, client: bad, log: (m: string) => logs.push(m) };
    await pollOnce(bad, t, deps, false);
    await pollOnce(bad, t, deps, false);
    assert.ok(logs.some((l) => /could not process job 101/.test(l)));
    assert.ok(!s.lines.some((l) => /JOB FAILED/.test(l)));
  } finally {
    s.cleanup();
  }
});

test('cli: `once --notifier json` prints structured results on stdout for agents (real process)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-cli-'));
  execFileSync(process.execPath, [path.join(__dirname, '../../tools/make-demo-repo.js'), repo], { stdio: 'ignore' });
  const cfgFile = path.join(repo, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: repo, users: { 'priya@example.com': 'U0PRIYA01' } }));
  const state = path.join(os.tmpdir(), `radar-cli-state-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(state, JSON.stringify({ n: 1 })); // start at the poll where job 101 has failed
  const out = execFileSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'once', '--include-existing', '--notifier', 'json', '--config', cfgFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AGENTIA_BIN: FAKE, FAKE_STATE: state },
  });
  const j = JSON.parse(out);
  assert.strictEqual(j.failures.length, 1);
  assert.strictEqual(j.failures[0].job.id, '101');
  assert.strictEqual(j.failures[0].triage.findings.length, 5);
  assert.ok(j.failures[0].owners.some((o: any) => o.owner.slackId === 'U0PRIYA01'));
});

test('cli: `triage <file>` works on a saved job JSON and on a raw text log', () => {
  const cli = path.join(__dirname, '../src/cli.js');
  const fixture = path.join(__dirname, '../../tools/fake-agentia/fixtures/job-101.json');
  const out = execFileSync(process.execPath, [cli, 'triage', fixture], { encoding: 'utf8' });
  assert.match(out, /5 problems/);
  assert.match(out, /PaymentCalculator\.cls:45/);
  const rawFile = path.join(os.tmpdir(), `radar-raw-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(rawFile, 'x.cls  Variable does not exist: y (3:4)\nsomething else');
  assert.match(execFileSync(process.execPath, [cli, 'triage', rawFile], { encoding: 'utf8' }), /1 problem: 1 Apex compile error/);
  fs.writeFileSync(rawFile, 'all quiet');
  assert.match(execFileSync(process.execPath, [cli, 'triage', rawFile], { encoding: 'utf8' }), /No known pattern matched/);
});

test('cli: `triage` reads a UTF-16 LE file (what Windows PowerShell 5.1 "> file" produces)', () => {
  const cli = path.join(__dirname, '../src/cli.js');
  const fixture = fs.readFileSync(path.join(__dirname, '../../tools/fake-agentia/fixtures/job-101.json'), 'utf8');
  const f = path.join(os.tmpdir(), `radar-utf16-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fixture, 'utf16le')]));
  assert.match(execFileSync(process.execPath, [cli, 'triage', f], { encoding: 'utf8' }), /5 problems/);
});

test('cli: `triage --show` prints which formats were recognised and the text the pattern rules scanned', () => {
  const cli = path.join(__dirname, '../src/cli.js');
  const fixture = path.join(__dirname, '../../tools/fake-agentia/fixtures/job-101.json');
  const out = execFileSync(process.execPath, [cli, 'triage', fixture, '--show'], { encoding: 'utf8' });
  assert.match(out, /free text the pattern rules scanned/);
  assert.match(out, /formats recognised: pattern-rules/);
  assert.match(out, /Component Failures \[2\]/);
});
