import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AgentiaClient, asList, classify, fill, normalizeDetail, normalizeJob, parseEnvelope, resolveAgentia } from '../src/agentia';
import { DEFAULTS } from '../src/config';
import { JobTracker } from '../src/poller';
import { ownerOf, ownersFor, resolvePath } from '../src/owners';
import { buildPrompt, extractFindings, headline, redact, triage } from '../src/triage';
import { JobSummary } from '../src/types';

const job = (id: string, status: string): JobSummary => ({ id, name: `J${id}`, status, state: classify(status) });

// ---------- agentia envelope ----------
test('envelope: parses {result,status}, tolerates a leading warning line, unwraps list pages', () => {
  const out = '(node) Warning: linked plugin\n' + JSON.stringify({ result: { data: [{ id: 1 }] }, status: 'success', transactionId: 't' });
  assert.deepStrictEqual(asList(parseEnvelope(out)), [{ id: 1 }]);
  assert.deepStrictEqual(asList(parseEnvelope('[{"id":2}]')), [{ id: 2 }]);
});

test('envelope: error status becomes an exception; no JSON is an error', () => {
  assert.throws(() => parseEnvelope(JSON.stringify({ status: 'error', message: 'boom' })), /boom/);
  assert.throws(() => parseEnvelope('nothing here'), /No JSON/);
});

test('envelope: a bare failed job record (status "Error") is data, not an error envelope', () => {
  const rec = parseEnvelope(JSON.stringify({ id: '1', status: 'Error', steps: [] })) as { id: string };
  assert.strictEqual(rec.id, '1');
  const wrapped = parseEnvelope(JSON.stringify({ result: { id: '2', status: 'Error' }, status: 'success' })) as { id: string };
  assert.strictEqual(wrapped.id, '2');
});

test('classify: maps Copado-style statuses', () => {
  assert.strictEqual(classify('Successful'), 'success');
  assert.strictEqual(classify('Error'), 'failure');
  assert.strictEqual(classify('Failed'), 'failure');
  assert.strictEqual(classify('In Progress'), 'running');
  assert.strictEqual(classify('Cancelled'), 'cancelled');
  assert.strictEqual(classify(undefined), 'unknown');
});

test('normalize: reads jobs and steps under alternative field names', () => {
  const j = normalizeJob({ Id: 'a1', Name: 'Deploy', Status: 'Error', userStoryName: 'US-1' });
  assert.deepStrictEqual([j?.id, j?.state, j?.story], ['a1', 'failure', 'US-1']);
  const d = normalizeDetail({ id: 'a1', status: 'Error', jobSteps: [{ stepName: 'S', status: 'Error', output: 'bad' }] });
  assert.strictEqual(d?.steps[0].log, 'bad');
  assert.strictEqual(normalizeJob({ nope: true }), undefined);
});

test('fill: substitutes placeholders into argv without a shell', () => {
  assert.deepStrictEqual(fill(['ai', 'ask', '{prompt}'], { prompt: 'a; rm -rf / $(x)' }), ['ai', 'ask', 'a; rm -rf / $(x)']);
});

// ---------- poller ----------
test('poller: first poll is a baseline, later changes are reported once', () => {
  const t = new JobTracker();
  assert.strictEqual(t.update([job('1', 'In Progress')]).length, 0);
  assert.strictEqual(t.update([job('1', 'In Progress')]).length, 0);
  const ev = t.update([job('1', 'Error'), job('2', 'In Progress')]);
  assert.deepStrictEqual(ev.map((e) => [e.job.id, e.from, e.to]), [['1', 'running', 'failure'], ['2', undefined, 'running']]);
  assert.strictEqual(t.update([job('1', 'Error')]).length, 0, 'no duplicate alert');
});

test('poller: includeExisting reports jobs that are already failed at start', () => {
  const ev = new JobTracker().update([job('9', 'Error')], { includeExisting: true });
  assert.strictEqual(ev.length, 1);
});

// ---------- triage ----------
const LOG = [
  'force-app/main/default/classes/PaymentCalculator.cls  Method does not exist or incorrect signature: void countNewMonths() from the type PaymentHelper (45:13)',
  'Error: force-app/main/default/classes/PaymentHelper.cls -- Variable does not exist: mockPaymentId (line 12, column 9)',
  'PaymentCalculatorTest.testMonthlyBenefit -- System.AssertException: Assertion Failed: Expected: 450, Actual: 420 -- Class.PaymentCalculatorTest.testMonthlyBenefit: line 31, column 1',
  'Average test coverage across all Apex Classes and Triggers is 62%, at least 75% required',
  'In field: fieldPermissions - no CustomField named Claim__c.Appeal_Status__c found',
  'System.SObjectException: SObject row was retrieved via SOQL without querying the requested field: Case.Reason__c',
  'Deployment failed.',
].join('\n');

test('triage: extracts component, line and category from realistic deployment output', () => {
  const f = extractFindings(LOG);
  const by = (c: string) => f.filter((x) => x.category === c);
  assert.strictEqual(by('apex-compile').length, 2);
  assert.deepStrictEqual([by('apex-compile')[0].component, by('apex-compile')[0].line, by('apex-compile')[0].column],
    ['force-app/main/default/classes/PaymentCalculator.cls', 45, 13]);
  assert.strictEqual(by('apex-compile')[1].line, 12, 'also parses "(line 12, column 9)"');
  assert.deepStrictEqual([by('apex-test')[0].component, by('apex-test')[0].line], ['PaymentCalculatorTest.testMonthlyBenefit', 31]);
  assert.match(by('coverage')[0].message, /62%.*75%/);
  assert.strictEqual(by('missing-dependency')[0].component, 'Claim__c.Appeal_Status__c');
  assert.strictEqual(by('permissions')[0].component, 'Case.Reason__c');
  assert.ok(!f.some((x) => x.message === 'Deployment failed.'), 'status noise is not a finding');
});

test('triage: unknown failures fall back to error-looking lines; empty log says so honestly', () => {
  const f = extractFindings('starting\nUnexpected exception while contacting the org\nbye');
  assert.strictEqual(f[0].category, 'other');
  assert.match(headline([]), /no recognizable error pattern/);
});

test('redact: removes tokens, session ids and emails before text leaves the machine', () => {
  const r = redact('Bearer abcdef1234567890abcdef1234567890 and access_token=xyz123 user dev@example.com 00Dxx0000001234AB!AQEAQabcdefghijklmnopqrstuvwxyz');
  assert.ok(!/abcdef1234567890|xyz123|dev@example|AQEAQ/.test(r), r);
});

test('triage: AI answer replaces the explanation but findings stay rule-based; AI failure degrades to rules', async () => {
  const SECRET_LINE = 'request failed: auth Bearer abcdef1234567890abcdef1234567890 for dev@example.com';
  const detail = { ...job('1', 'Error'), steps: [{ name: 'Deploy', status: 'Error', state: 'failure' as const, log: `${LOG}\n${SECRET_LINE}` }], log: '' };
  let seenPrompt = '';
  const withAi = await triage(detail, async (p) => ((seenPrompt = p), 'Plain English answer.'));
  assert.strictEqual(withAi.source, 'ai+rules');
  assert.strictEqual(withAi.explanation, 'Plain English answer.');
  assert.ok(withAi.findings.length >= 5);
  assert.match(seenPrompt, /request failed/, 'the line with the secrets IS in the excerpt...');
  assert.ok(!/abcdef1234567890|dev@example\.com/.test(seenPrompt), '...but redacted before it reaches the AI agent');
  const noAi = await triage(detail, async () => undefined);
  assert.strictEqual(noAi.source, 'rules');
  assert.match(noAi.explanation, /Apex compile error/);
  assert.match(buildPrompt(detail, noAi.findings, 'x'), /Do not invent component names/);
});

// ---------- owners ----------
function demoRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-repo-'));
  execFileSync(process.execPath, [path.join(__dirname, '../../tools/make-demo-repo.js'), d], { stdio: 'ignore' });
  return d;
}
const USERS = { 'priya@example.com': 'U0PRIYA01', 'Marcus Lee': 'U0MARCUS1' };

test('owners: resolves paths, bare class names, test classes and Object.Field names', () => {
  const d = demoRepo();
  assert.match(resolvePath(d, 'force-app/main/default/classes/PaymentHelper.cls') ?? '', /PaymentHelper\.cls$/);
  assert.match(resolvePath(d, 'PaymentCalculator') ?? '', /PaymentCalculator\.cls$/);
  assert.match(resolvePath(d, 'Claim__c.Appeal_Status__c') ?? '', /Claim__c\/fields\/Appeal_Status__c\.field-meta\.xml$/);
  assert.strictEqual(resolvePath(d, 'Nope'), undefined);
});

test('owners: last committer, story id and Slack id (by email or by name)', () => {
  const d = demoRepo();
  const o = ownerOf(d, 'PaymentCalculator', USERS, DEFAULTS.storyRegex);
  assert.deepStrictEqual([o?.name, o?.story, o?.slackId], ['Priya Nair', 'US-0000142', 'U0PRIYA01']);
  const m = ownerOf(d, 'PaymentHelper', USERS, DEFAULTS.storyRegex);
  assert.deepStrictEqual([m?.story, m?.slackId], ['US-0000138', 'U0MARCUS1']);
});

test('owners: hostile component text from a log is never used as a git pathspec', () => {
  const d = demoRepo();
  assert.strictEqual(resolvePath(d, ':(top)*'), undefined);
  assert.strictEqual(resolvePath(d, '$(touch /tmp/pwned)'), undefined);
  assert.strictEqual(resolvePath(d, '../../etc/passwd'), undefined);
});

test('owners: one owner per component, test method maps to its class', () => {
  const d = demoRepo();
  const f = extractFindings(LOG);
  const owners = ownersFor(d, f, USERS, DEFAULTS.storyRegex);
  const comps = owners.map((o) => o.component);
  assert.ok(comps.includes('PaymentCalculatorTest.testMonthlyBenefit'));
  assert.ok(comps.includes('Claim__c.Appeal_Status__c'));
  assert.strictEqual(new Set(comps).size, comps.length);
});

test('client: reads a list and a job through an injected runner', async () => {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return argv.includes('list')
      ? JSON.stringify({ result: { data: [{ id: '7', status: 'Error', name: 'X' }] }, status: 'success' })
      : JSON.stringify({ result: { id: '7', status: 'Error', steps: [{ name: 's', status: 'Error', log: 'boom' }] }, status: 'success' });
  };
  const c = new AgentiaClient(run, DEFAULTS.commands);
  assert.strictEqual((await c.listJobs()).jobs[0].state, 'failure');
  assert.strictEqual((await c.getJob('7')).steps[0].log, 'boom');
  assert.deepStrictEqual(calls[1], ['cicd', 'job', 'get', '7', '--json']);
  const broken = new AgentiaClient(async () => { throw new Error('no ai'); }, DEFAULTS.commands);
  assert.strictEqual(await broken.ask('hi'), undefined);
});

// ---------- launching the agentia CLI (cross-platform) ----------
test('resolveAgentia: AGENTIA_JS and AGENTIA_BIN(.js) run through node; plain bin is used as-is; default is "agentia"', () => {
  assert.deepStrictEqual(resolveAgentia({ AGENTIA_JS: '/x/run.js' }, 'linux'), { cmd: process.execPath, prefix: ['/x/run.js'] });
  assert.deepStrictEqual(resolveAgentia({ AGENTIA_BIN: '/x/fake.js' }, 'win32'), { cmd: process.execPath, prefix: ['/x/fake.js'] });
  assert.deepStrictEqual(resolveAgentia({ AGENTIA_BIN: '/usr/bin/agentia' }, 'linux'), { cmd: '/usr/bin/agentia', prefix: [] });
  assert.deepStrictEqual(resolveAgentia({}, 'linux'), { cmd: 'agentia', prefix: [] });
});

test('resolveAgentia (Windows): finds the JS file launched by the npm agentia.cmd shim; falls back safely when it cannot', () => {
  const shim = [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@copado\\agentia-cli\\bin\\run.js" %*',
  ].join('\r\n');
  const wanted = 'C:\\npm\\node_modules\\@copado\\agentia-cli\\bin\\run.js';
  const exists = (p: string) => p === 'C:\\npm\\agentia.cmd' || p === wanted;
  const r = resolveAgentia({ PATH: 'C:\\Windows;C:\\npm' }, 'win32', exists, () => shim);
  assert.deepStrictEqual(r, { cmd: process.execPath, prefix: [wanted] });
  assert.deepStrictEqual(resolveAgentia({ PATH: 'C:\\npm' }, 'win32', () => false, () => shim), { cmd: 'agentia', prefix: [] });
  assert.deepStrictEqual(resolveAgentia({ PATH: 'C:\\npm' }, 'win32', exists, () => 'unrecognised shim'), { cmd: 'agentia', prefix: [] });
});

// ---------- table-style output (sf CLI "Component Failures" / "Test Failures" rows) ----------
test('triage: parses table rows where the component is a bare name and columns are space-separated', () => {
  const f = extractFindings([
    'Component Failures [1]',
    ' Type  Name         Problem',
    ' Error  DemoBroken    Variable does not exist: undefinedVar (4:20)',
    'Test Failures [1]',
    ' DemoMathTest  addsTwoNumbers  System.AssertException: Assertion Failed: expected 2 + 2 to be 4: Expected: 4, Actual: 5  Class.DemoMathTest.addsTwoNumbers: line 5, column 1',
    ' DemoMathTest.otherTest  System.AssertException: Assertion Failed: Expected: 1, Actual: 2',
  ].join('\n'));
  const compile = f.find((x) => x.category === 'apex-compile');
  assert.deepStrictEqual([compile?.component, compile?.line, compile?.column], ['DemoBroken', 4, 20]);
  const tests = f.filter((x) => x.category === 'apex-test');
  assert.strictEqual(tests.length, 2);
  assert.deepStrictEqual([tests[0].component, tests[0].line], ['DemoMathTest.addsTwoNumbers', 5]);
  assert.strictEqual(tests[1].component, 'DemoMathTest.otherTest');
});

test('triage: table rule does not turn ordinary log lines into findings', () => {
  assert.strictEqual(extractFindings('Deploying metadata to UAT  in progress (2:3)\nAll good').filter((x) => x.category !== 'other').length, 0);
});
