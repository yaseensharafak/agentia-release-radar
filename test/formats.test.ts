import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { normalizeDetail } from '../src/agentia';
import { parseTypedLines } from '../src/evidence';
import { buildFailureBlocks } from '../src/slack';
import { ownersForTriage } from '../src/owners';
import { analyze, loadCustomRules, triage } from '../src/triage';
import { FailureReport } from '../src/types';

const FX = path.join(__dirname, '../../fixtures/formats');
const read = (f: string): string => fs.readFileSync(path.join(FX, f), 'utf8');
const REPORT = read('ValidationResult.sample.json');
const VIEWER = read('ResultViewer.sample.json');
const LOG = read('FunctionLog.sample.txt');

test('formats: the deploy report (structured JSON) gives 33 errors from 4 root causes, variables merged into their fields', () => {
  const a = analyze([REPORT]);
  assert.deepStrictEqual(a.kinds, ['deploy-report']);
  assert.strictEqual(a.errorCount, 33, 'each failure counted exactly once (no double counting while walking the JSON)');
  assert.strictEqual(a.findings.length, 4);
  const by = Object.fromEntries(a.findings.map((f) => [f.message, f.count]));
  assert.deepStrictEqual(by, {
    'Missing field ACME_Billing_Plan__c.Outstanding_Amount__c': 12, // 1 column + 1 variable + 9 test + 1 SELECT
    'Missing field ACME_Installment__c.Due_On__c': 12,
    'Missing field ACME_Invoice__c.Billing_Plan__c': 8, // 1 column + 1 variable + 6 test
    'Unknown name LegacyNotifier (looks like a missing Apex class)': 1,
  });
  assert.match(a.headline, /33 errors from 4 root causes: 3 missing fields, 1 unknown variable/);
  assert.match(a.explanation, /add the missing field metadata/i);
});

test('formats: Copado result viewer and function log (Type:Name:Problem text) give the same answer as the report', () => {
  const sig = (x: ReturnType<typeof analyze>) => JSON.stringify(x.findings.map((f) => [f.message, f.count]).sort());
  const base = sig(analyze([REPORT]));
  assert.strictEqual(sig(analyze([VIEWER])), base);
  assert.strictEqual(sig(analyze([LOG])), base, 'the log prints the list 3 times; copies must be counted once');
  assert.strictEqual(analyze([VIEWER]).errorCount, 33);
  assert.strictEqual(analyze([LOG]).errorCount, 33);
});

test('formats: passing all three artifacts together never double counts, and finds the story', () => {
  const a = analyze([REPORT, VIEWER, LOG]);
  assert.strictEqual(a.errorCount, 33);
  assert.deepStrictEqual(a.stories, { InvoiceSyncHandler: 'US-0000123', InvoiceSyncHandlerTest: 'US-0000123' });
  assert.ok(a.kinds.includes('deploy-report') && a.kinds.includes('copado-result') && a.kinds.includes('copado-function-log'));
});

test('formats: multi-line SOQL error blocks fold into one error and resolve to the missing field', () => {
  const errs = parseTypedLines(
    'ApexClass:Foo:SELECT Bar__c FROM Obj__c\n       ^\nERROR at Row:1:Column:8\nNo such column \'Bar__c\' on entity \'Obj__c\'. Please reference your WSDL.\nApexClass:Foo:Variable does not exist: X',
  );
  assert.strictEqual(errs.length, 2);
  assert.match(errs[0].problem, /No such column 'Bar__c' on entity 'Obj__c'/);
});

test('formats: literal backslash-n separators (as Copado stores them) are split into records', () => {
  const errs = parseTypedLines('Metadata Validation - ApexClass:A:Variable does not exist: x\\nApexClass:B:Variable does not exist: y');
  assert.deepStrictEqual(errs.map((e) => e.name), ['A', 'B']);
});

test('formats: free text with no recognisable structure falls back to pattern rules, and says so', () => {
  const a = analyze(['force-app/main/default/classes/Foo.cls  Variable does not exist: x (3:5)']);
  assert.deepStrictEqual(a.kinds, ['pattern-rules']);
  assert.strictEqual(a.findings[0].component, 'force-app/main/default/classes/Foo.cls');
});

test('formats: runTestResult failures and coverage warnings from the deploy report become findings', () => {
  const rep = { result: { details: { componentFailures: [], runTestResult: {
    failures: [{ name: 'FooTest', methodName: 'works', message: 'System.AssertException: Assertion Failed', stackTrace: 'Class.FooTest.works: line 12, column 1' }],
    codeCoverageWarnings: [{ name: 'Foo', message: 'Average test coverage across all Apex Classes and Triggers is 62%, at least 75% required' }] } } } };
  const a = analyze([JSON.stringify(rep)]);
  assert.strictEqual(a.findings.length, 2);
  assert.deepStrictEqual([a.findings[0].category, a.findings[0].component, a.findings[0].line], ['apex-test', 'FooTest.works', 12]);
  assert.strictEqual(a.findings[1].category, 'coverage');
});

test('triage(): finds a deploy report embedded as a JSON string inside an Agentia job step', async () => {
  const job = normalizeDetail({ id: '9', status: 'Error', steps: [{ name: 'Deploy', status: 'Error', result: REPORT }] });
  assert.ok(job);
  const t = await triage(job as NonNullable<typeof job>);
  assert.strictEqual(t.errorCount, 33);
  assert.strictEqual(t.findings.length, 4);
  assert.ok(t.kinds.includes('deploy-report'));
});

// ---------- custom rules (data, not code) ----------
test('custom rules: a JSON file adds a pattern with no code change; bad rules are reported, not ignored', () => {
  const f = path.join(os.tmpdir(), `rules-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify([
    { pattern: 'CUSTOM-ERR-(?<line>\\d+):\\s*(?<component>\\w+)\\s*(?<message>.+)$', category: 'validation' },
    { pattern: '([unclosed', category: 'validation' },
    { pattern: 'x', category: 'not-a-category' },
  ]));
  const { rules, problems } = loadCustomRules(f);
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(problems.length, 2);
  const a = analyze(['CUSTOM-ERR-42: Widget something broke'], { rules });
  assert.deepStrictEqual([a.findings[0].category, a.findings[0].component, a.findings[0].line, a.findings[0].message], ['validation', 'Widget', 42, 'something broke']);
  assert.deepStrictEqual(loadCustomRules(path.join(os.tmpdir(), 'nope.json')), { rules: [], problems: [] });
});

// ---------- owners from the story map ----------
test('owners: the story comes from Copado\'s own list; the Slack id from storyOwners; no git needed', () => {
  const a = analyze([REPORT, LOG]);
  const owners = ownersForTriage('/does/not/exist', a.findings, a.stories, {}, { 'US-0000123': 'U0DEV12345' }, '\\bUS-\\d+\\b');
  assert.strictEqual(owners.length, 1, 'both classes share one story so they collapse to one entry');
  assert.deepStrictEqual([owners[0].owner.story, owners[0].owner.slackId], ['US-0000123', 'U0DEV12345']);
  assert.match(owners[0].component, /InvoiceSyncHandler/);
});

// ---------- Slack card ----------
test('slack: card shows root causes with counts and the story owner mention', async () => {
  const a = analyze([REPORT, LOG]);
  const report: FailureReport = {
    job: { id: '9', name: 'Validate', status: 'Error', state: 'failure' },
    triage: { headline: a.headline, explanation: a.explanation, findings: a.findings, errorCount: a.errorCount, stories: a.stories, kinds: a.kinds, source: 'rules' },
    owners: ownersForTriage('/nope', a.findings, a.stories, {}, { 'US-0000123': 'U0DEV12345' }, '\\bUS-\\d+\\b'),
    at: 'now',
  };
  const json = JSON.stringify(buildFailureBlocks(report));
  assert.match(json, /33 errors from 4 root causes/);
  assert.match(json, /12 errors in 2 components/);
  assert.match(json, /<@U0DEV12345> · US-0000123/);
});

// ---------- privacy + CLI ----------
// Client identifiers must never be written into this repo, not even in a test. The denylist therefore lives in an
// untracked local file (.denylist.local, one token per line) or the RADAR_DENYLIST environment variable (comma separated).
const DENY = (process.env.RADAR_DENYLIST ?? (fs.existsSync(path.join(__dirname, '../../.denylist.local')) ? fs.readFileSync(path.join(__dirname, '../../.denylist.local'), 'utf8') : ''))
  .split(/[\n,]/)
  .map((s) => s.trim())
  .filter(Boolean);
const FIXTURE_TEXT = [REPORT, VIEWER, LOG, read('../../triage-rules.example.json')].join('\n');

test('fixtures look synthetic: no repo URLs, org hostnames or Salesforce user ids, and they use the invented names', () => {
  assert.ok(!/git@github\.com:\w/.test(FIXTURE_TEXT) && !/https?:\/\/github\.com\/\w/.test(FIXTURE_TEXT), 'no repository URLs');
  assert.ok(!/\.(my\.salesforce|lightning\.force)\.com/.test(FIXTURE_TEXT), 'no org hostnames');
  assert.ok(!/\b005[A-Za-z0-9]{12,15}\b/.test(FIXTURE_TEXT), 'no Salesforce user ids');
  assert.ok(FIXTURE_TEXT.includes('ACME_') && FIXTURE_TEXT.includes('InvoiceSyncHandler'));
});

test('fixtures contain none of YOUR client identifiers (enable by creating .denylist.local or setting RADAR_DENYLIST)', { skip: DENY.length === 0 && 'no denylist configured' }, () => {
  for (const bad of DENY) assert.ok(!FIXTURE_TEXT.toLowerCase().includes(bad.toLowerCase()), `fixture must not contain "${bad}"`);
});

test('cli: `triage` takes several files and a whole folder (the Result record attachments)', () => {
  const cli = path.join(__dirname, '../src/cli.js');
  const out = execFileSync(process.execPath, [cli, 'triage', path.join(FX, 'ValidationResult.sample.json'), path.join(FX, 'FunctionLog.sample.txt'), '--show'], { encoding: 'utf8' });
  assert.match(out, /formats recognised: deploy-report, copado-function-log/);
  assert.match(out, /33 errors from 4 root causes/);
  assert.match(out, /stories: US-0000123/);
  const dirOut = execFileSync(process.execPath, [cli, 'triage', FX], { encoding: 'utf8' });
  assert.match(dirOut, /33 errors from 4 root causes/);
});

// ---------- real Agentia job shapes (sanitised samples of `job list` / `job get` output) ----------
import { asList, normalizeDetail as normalizeDetail2, normalizeJob, parseEnvelope } from '../src/agentia';
import { handleTransitions } from '../src/pipeline';
import { CollectNotifier } from '../src/notify';
import { DEFAULTS } from '../src/config';
import { Registry } from '../src/registry';
import { AgentiaClient } from '../src/agentia';

const LIST = read('JobList.sample.json');
const JOBS = asList(parseEnvelope(LIST)).map((j) => normalizeJob(j));

test('job list: readable names, promotion, story, action and error text come out of the real shape', () => {
  assert.strictEqual(JOBS.length, 10);
  const failedDeploy = JOBS.find((j) => j?.number === 'JE-900007');
  assert.strictEqual(failedDeploy?.name, 'SFDX Deploy (validation) · P-8999 [JE-900007]');
  assert.deepStrictEqual([failedDeploy?.story, failedDeploy?.action, failedDeploy?.state, failedDeploy?.promotion], ['US-0000903', 'PromotionDeployment', 'failure', 'P-8999']);
  assert.match(failedDeploy?.errorMessage ?? '', /Unable to find Apex action class/);
  const live = JOBS.find((j) => j?.number === 'JE-900003');
  assert.strictEqual(live?.name, 'SFDX Deploy · P-8990 [JE-900003]', 'a non-dry-run deploy is not labelled "validation"');
  assert.deepStrictEqual(JOBS.find((j) => j?.number === 'JE-900002')?.resultIds, ['a8IXx0000000002AAA']);
});

test('job errors: each real failure wording is classified, none falls into "other"', () => {
  const byNumber = (n: string) => analyze([JOBS.find((j) => j?.number === n)?.errorMessage ?? '']);
  const lwc = byNumber('JE-900007');
  assert.deepStrictEqual([lwc.findings[0].category, lwc.findings[0].message], ['missing-dependency', 'Missing Apex class OrderPanelController (referenced by a Lightning component)']);
  const pick = byNumber('JE-900003');
  assert.match(pick.findings[0].message, /"Platinum" is not an allowed picklist value for Tier__c/);
  assert.strictEqual(pick.findings[0].component, 'SyncSchedulerTest.testExecute');
  assert.match(pick.explanation, /Add the missing picklist value/);
  assert.match(byNumber('JE-900002').findings[0].message, /code coverage is below 90%/);
  assert.strictEqual(byNumber('JE-900002').findings[0].category, 'coverage');
  assert.match(byNumber('JE-900001').findings[0].message, /unit test method is failing/);
  for (const n of ['JE-900007', 'JE-900003', 'JE-900002', 'JE-900001']) assert.ok(byNumber(n).findings.every((f) => f.category !== 'other'), n);
});

test('job get: the same message appearing at job level and step level is counted once', async () => {
  const detail = normalizeJob(JSON.parse(read('JobGet.failed.sample.json')).result);
  assert.ok(detail);
  const job = normalizeDetail2(JSON.parse(read('JobGet.failed.sample.json')).result, detail);
  assert.ok(job && job.steps.length === 2);
  const t = await triage(job as NonNullable<typeof job>);
  assert.strictEqual(t.errorCount, 1, 'job-level and step-level copies must not double count');
  assert.strictEqual(t.findings.length, 1);
});

test('watch: by default EVERY kind of success is announced (validation, deploy, promote, commit, quality check); failures always are', async () => {
  const n = new CollectNotifier();
  const client = { getJob: async (_id: string, fb: unknown) => normalizeDetail2({ id: 'x', status: 'Error', errorMessage: 'Metadata Validation - ApexClass:A:Variable does not exist: x' }, fb as never) } as unknown as AgentiaClient;
  const done = JOBS.filter((j): j is NonNullable<typeof j> => !!j).map((job) => (job.state === 'running' ? { ...job, state: 'success' as const, status: 'Successful' } : job));
  const transitions = done.map((job) => ({ job, to: job.state }));
  await handleTransitions(transitions, { client, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, repoDir: '/nope' } });
  const titles = n.successes.map((s) => s.title);
  assert.strictEqual(n.successes.length, 6);
  assert.ok(titles.includes('Validation succeeded') && titles.includes('Promotion step completed') && titles.includes('Commit succeeded'));
  assert.ok(titles.includes('Deployment succeeded') && titles.some((t) => t.startsWith('Quality check passed')));
  assert.strictEqual(n.failures.length, 4, 'every failed job is announced, including quality gates');
});

test('watch: successActions narrows what is announced as success', async () => {
  const n = new CollectNotifier();
  const client = {} as unknown as AgentiaClient;
  const done = JOBS.filter((j): j is NonNullable<typeof j> => !!j && j.state === 'success');
  await handleTransitions(done.map((job) => ({ job, to: 'success' as const })), { client, notifier: n, registry: new Registry(), cfg: { ...DEFAULTS, successActions: ['PromotionDeployment'] } });
  assert.deepStrictEqual(n.successes.map((s) => s.job.action), ['PromotionDeployment', 'PromotionDeployment']);
  const n2 = new CollectNotifier();
  await handleTransitions(done.map((job) => ({ job, to: 'success' as const })), { client, notifier: n2, registry: new Registry(), cfg: { ...DEFAULTS, successActions: [] } });
  assert.strictEqual(n2.successes.length, 0, 'an empty list silences success (except jobs with no action)');
});

// ---------- success wording ----------
import { describeSuccess, duration, formatDuration, jobLinks, safeBase } from '../src/describe';
import { buildSuccessBlocks } from '../src/slack';
const J = (n: string) => JOBS.find((j) => j?.number === n) as NonNullable<(typeof JOBS)[number]>;
const CFG = { destinations: {}, orgUrl: undefined } as const;

test('success wording: validation, real deployment, promote, commit and quality check each read naturally', () => {
  const val = describeSuccess(J('JE-900008'), CFG);
  assert.deepStrictEqual([val.title, val.emoji], ['Validation succeeded', ':white_check_mark:']);
  assert.match(val.detail, /US-0000902 validated against qa-demo\. Nothing was deployed\./);
  assert.match(val.meta, /Promotion P-9000 · JE-900008 · ~1m 5s/);

  const dep = describeSuccess(J('JE-900010'), CFG);
  assert.deepStrictEqual([dep.title, dep.emoji], ['Deployment succeeded', ':rocket:']);
  assert.match(dep.detail, /US-0000906, US-0000907 successfully deployed to qa-demo\./);
  assert.match(dep.meta, /~3m 12s/);

  assert.strictEqual(describeSuccess(J('JE-900006'), CFG).title, 'Promotion step completed');
  assert.match(describeSuccess(J('JE-900006'), CFG).detail, /Promotion P-9000 is ready for qa-demo \(validation run\)\./);
  assert.strictEqual(describeSuccess(J('JE-900004'), CFG).title, 'Commit succeeded');
  assert.match(describeSuccess(J('JE-900005'), CFG).title, /^Quality check passed: Run PMD$/);
});

test('success wording: destinations map turns a branch into a friendly environment name', () => {
  const s = describeSuccess(J('JE-900010'), { destinations: { 'qa-demo': 'QA Demo sandbox' }, orgUrl: undefined });
  assert.strictEqual(s.title, 'Deployment succeeded');
  assert.match(s.detail, /successfully deployed to QA Demo sandbox\./);
});

test('success wording: back-promotion, and a job with no known action, get sensible text', () => {
  const back = describeSuccess({ ...J('JE-900006'), isBackPromotion: true }, CFG);
  assert.strictEqual(back.title, 'Back-promotion step completed');
  const other = describeSuccess({ id: 'x', name: 'Weird job', status: 'Successful', state: 'success' }, CFG);
  assert.strictEqual(other.title, 'Weird job succeeded');
});

test('durations are rough and only shown when the timestamps make sense', () => {
  assert.deepStrictEqual([formatDuration(4000), formatDuration(65000), formatDuration(3_723_000)], ['4s', '1m 5s', '1h 2m']);
  assert.strictEqual(duration({ id: 'x', name: 'x', status: 's', state: 'success', createdAt: '2026-01-01T12:05:00Z', finishedAt: '2026-01-01T12:00:00Z' }), undefined);
  assert.strictEqual(duration({ id: 'x', name: 'x', status: 's', state: 'success' }), undefined);
});

test('links: only an https org URL produces "open in Copado" links; anything odd is ignored', () => {
  assert.strictEqual(safeBase('https://example.my.salesforce.com/'), 'https://example.my.salesforce.com');
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'https://a.com/x|y', 'https://a.com/ >', 'not a url', undefined]) assert.strictEqual(safeBase(bad), undefined, String(bad));
  const links = jobLinks(J('JE-900008'), 'https://example.my.salesforce.com');
  assert.deepStrictEqual(links.map((l) => l.label), ['Open promotion P-9000', 'Open job']);
  assert.match(links[0].url, /^https:\/\/example\.my\.salesforce\.com\/a89Xx0000000009AAA$/);
  assert.deepStrictEqual(jobLinks(J('JE-900008'), undefined), []);
});

test('slack success card: headline, detail, small print and links; hostile text is escaped', () => {
  const s = describeSuccess({ ...J('JE-900004'), commitMessage: 'fix <!channel> & <@UEVIL> <https://evil.example|click>' }, CFG);
  const card = JSON.stringify(buildSuccessBlocks(s));
  assert.ok(!card.includes('<!channel>') && !card.includes('<@UEVIL>') && !card.includes('<https://evil'));
  assert.match(card, /Commit succeeded/);
  const ok = buildSuccessBlocks(describeSuccess(J('JE-900008'), { destinations: {}, orgUrl: 'https://example.my.salesforce.com' }));
  assert.match(JSON.stringify(ok), /<https:\/\/example\.my\.salesforce\.com\/a89Xx0000000009AAA\|Open promotion P-9000>/);
  assert.match(ok.text, /Validation succeeded/);
});

test('owners: when the function log is not available the job\'s own story is used', () => {
  const a = analyze(['Metadata Validation - ApexClass:Foo:Variable does not exist: x']);
  const owners = ownersForTriage('/nope', a.findings, {}, {}, { 'US-0000903': 'U0DEV12345' }, '\\bUS-\\d+\\b', 5, 'US-0000903');
  assert.deepStrictEqual([owners[0]?.owner.story, owners[0]?.owner.slackId], ['US-0000903', 'U0DEV12345']);
});

test('cli: a missing triage path gives a clear message and a non-zero exit, not a stack trace', () => {
  const cli = path.join(__dirname, '../src/cli.js');
  let err = '';
  let code = 0;
  try {
    execFileSync(process.execPath, [cli, 'triage', 'definitely-not-here'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = (e as { status: number }).status;
    err = String((e as { stderr: string }).stderr);
  }
  assert.strictEqual(code, 1);
  assert.match(err, /Not found: definitely-not-here/);
  assert.ok(!/ENOENT|at Object/.test(err));
});

// ---------- gaps found in a real `watch` run ----------
import { ConsoleNotifier } from '../src/notify';
import { ownerLabel } from '../src/slack';

test('quality-gate failure (no component named): the job\'s story is still the owner, mentionable via storyOwners', () => {
  const a = analyze(['- Your user story code coverage is below the expected threshold of 90%. Please increase code coverage.']);
  assert.strictEqual(a.findings[0].component, undefined);
  const owners = ownersForTriage('/nope', a.findings, {}, {}, { 'US-0000905': 'U0DEV12345' }, 'x', 5, 'US-0000905');
  assert.deepStrictEqual([owners[0].owner.story, owners[0].owner.slackId], ['US-0000905', 'U0DEV12345']);
  assert.strictEqual(ownersForTriage('/nope', a.findings, {}, {}, {}, 'x', 5).length, 0, 'no story and no component means no owner, honestly');
});

test('owner label never prints "unknown": no name and no Slack id shows just the story', () => {
  assert.strictEqual(ownerLabel({ story: 'US-1' }), 'US-1');
  assert.match(ownerLabel({ story: 'US-1', slackId: 'U1' }), /^<@U1> · US-1$/);
});

test('console card shows the job\'s story and promotion', async () => {
  const lines: string[] = [];
  await new ConsoleNotifier((s) => lines.push(s)).failure({
    job: { id: '1', name: 'SFDX Run Apex Tests [JE-1]', status: 'Error', state: 'failure', story: 'US-0000905', promotion: 'P-8980' },
    triage: { headline: 'h', explanation: 'e', findings: [], errorCount: 0, stories: {}, kinds: [], source: 'rules' },
    owners: [], at: 'now',
  });
  assert.match(lines.join('\n'), /Story: US-0000905 {3}Promotion: P-8980/);
});

test('job with no template still gets an informative name from its action and promotion', () => {
  const j = normalizeJob({ id: 'a1', name: 'JE-900010', status: 'Successful', dataJson: JSON.stringify({ action: 'PromotionDeployment', promotionBranchName: 'promotion/P-9005', deploymentDryRun: true }) });
  assert.strictEqual(j?.name, 'PromotionDeployment (validation) · P-9005 [JE-900010]');
  assert.strictEqual(normalizeJob({ id: 'a2', name: 'Plain job', status: 'Error' })?.name, 'Plain job', 'mock/legacy shapes keep their own name');
});

test('success with no detail (unknown job kind) has no dangling colon and a sensible reference', async () => {
  const lines: string[] = [];
  const s = describeSuccess({ id: 'a1b2c3', name: 'Validate things', status: 'Successful', state: 'success' }, CFG);
  await new ConsoleNotifier((x) => lines.push(x)).success(s);
  assert.strictEqual(lines[0], '[OK] Validate things succeeded   (job a1b2c3)');
  assert.strictEqual(buildSuccessBlocks(s).text, 'Validate things succeeded');
});
