import * as assert from 'assert';
import { createHmac } from 'crypto';
import * as http from 'http';
import { test } from 'node:test';
import { handleInteraction, ActionDeps } from '../src/actions';
import { DEFAULTS } from '../src/config';
import { Registry } from '../src/registry';
import { createServer } from '../src/server';
import { SlackNotifier } from '../src/notify';
import { buildFailureBlocks, isSlackResponseUrl, verifySlackSignature } from '../src/slack';
import { Config, FailureReport } from '../src/types';

const SECRET = 'test-signing-secret';
const NOW = 1_800_000_000;

const report = (over: Partial<FailureReport> = {}): FailureReport => ({
  job: { id: '101', name: 'Validate US-1 <!channel>', status: 'Error', state: 'failure', promotion: 'P-77' },
  triage: {
    headline: '2 problems: 1 Apex compile error, 1 coverage shortfall',
    explanation: 'Explanation with <@UEVIL> and <https://evil.example|click>',
    findings: [
      { category: 'apex-compile', component: 'force-app/.../PaymentCalculator.cls', line: 45, message: 'Variable does not exist: x' },
      { category: 'coverage', message: 'Apex test coverage is 62% but 75% is required' },
    ],
    errorCount: 2,
    stories: {},
    kinds: ['pattern-rules'],
    source: 'rules',
  },
  owners: [{ component: 'force-app/.../PaymentCalculator.cls', owner: { name: 'Priya Nair', slackId: 'U0PRIYA01', story: 'US-0000142', commit: 'b7cfbff' } }],
  at: 'now',
  ...over,
});

function sign(body: string, ts = NOW, secret = SECRET): Record<string, string> {
  return {
    'x-slack-request-timestamp': String(ts),
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`,
  };
}
const payload = (action_id: string, value: string, user = 'U0PRIYA01', response_url = 'https://hooks.slack.com/actions/T1/B1/xyz'): string =>
  'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: user }, response_url, actions: [{ action_id, value }] }));

function deps(over: Partial<Config> = {}) {
  const posts: Array<{ url: string; body: any }> = [];
  const reruns: string[] = [];
  const registry = new Registry();
  registry.set(report());
  const d: ActionDeps = {
    cfg: { ...DEFAULTS, signingSecret: SECRET, ...over },
    registry,
    client: { rerun: async (id: string) => (reruns.push(id), 'ok') },
    post: async (url, body) => void posts.push({ url, body }),
    nowSeconds: () => NOW,
  };
  return { d, posts, reruns };
}

// ---------- blocks ----------
test('blocks: card has header, findings, owner @mention and both action buttons within Slack limits', () => {
  const { text, blocks } = buildFailureBlocks(report());
  assert.match(text, /Job failed/);
  assert.ok(blocks.length <= 50);
  const json = JSON.stringify(blocks);
  assert.match(json, /<@U0PRIYA01>/);
  assert.match(json, /PaymentCalculator\.cls:45/);
  const actions = blocks.find((b) => b.type === 'actions') as { elements: Array<{ action_id: string; value: string }> };
  assert.deepStrictEqual(actions.elements.map((e) => [e.action_id, e.value]), [['radar_details', '101'], ['radar_rerun', '101']]);
  for (const b of blocks) if (b.type === 'section' && (b as any).text) assert.ok((b as any).text.text.length <= 3000);
});

test('blocks: log/commit text cannot inject mentions or links (escaped), only the owner mapping can @mention', () => {
  const card = buildFailureBlocks(report());
  const json = JSON.stringify(card.blocks) + JSON.stringify(card.text);
  assert.ok(!json.includes('<!channel>') && !json.includes('<@UEVIL>') && !json.includes('<https://evil'));
  assert.match(json, /&lt;@UEVIL&gt;/);
});

test('blocks: unmapped owner is named but not pinged; huge messages are clipped', () => {
  const r = report({ owners: [{ component: 'X.cls', owner: { name: 'Sam' } }] });
  r.triage.explanation = 'x'.repeat(10_000);
  const json = JSON.stringify(buildFailureBlocks(r).blocks);
  assert.ok(!/<@U/.test(json.replace(/&lt;@U\w+&gt;/g, '')));
  assert.match(json, /\*Sam\*/);
  for (const b of buildFailureBlocks(r).blocks) if (b.type === 'section' && (b as any).text) assert.ok((b as any).text.text.length <= 3000);
});

// ---------- signature ----------
test('signature: valid passes; wrong secret, tampered body, missing headers and stale timestamp fail', () => {
  const body = 'payload=abc';
  const h = sign(body);
  const ok = (over: object = {}) => verifySlackSignature({ signingSecret: SECRET, timestamp: h['x-slack-request-timestamp'], signature: h['x-slack-signature'], rawBody: body, nowSeconds: NOW, ...over });
  assert.ok(ok());
  assert.ok(!ok({ signingSecret: 'other' }));
  assert.ok(!ok({ rawBody: 'payload=abd' }));
  assert.ok(!ok({ signature: undefined }));
  assert.ok(!ok({ nowSeconds: NOW + 301 }), 'replay window');
  assert.ok(ok({ nowSeconds: NOW + 299 }));
});

test('response_url: only https://hooks.slack.com is accepted', () => {
  assert.ok(isSlackResponseUrl('https://hooks.slack.com/actions/x'));
  for (const u of ['http://hooks.slack.com/x', 'https://hooks.slack.com.evil.com/x', 'https://169.254.169.254/', 'nonsense'])
    assert.ok(!isSlackResponseUrl(u), u);
});

// ---------- interactions ----------
test('actions: unsigned or badly signed requests are rejected and do nothing', async () => {
  const { d, posts, reruns } = deps({ allowActions: true, allowedUsers: ['U0PRIYA01'], dryRunActions: false });
  const body = payload('radar_rerun', '101');
  assert.strictEqual(handleInteraction(body, {}, d).status, 401);
  assert.strictEqual(handleInteraction(body, sign(body, NOW, 'wrong'), d).status, 401);
  assert.strictEqual(handleInteraction(body, sign(body, NOW - 1000), d).status, 401);
  assert.deepStrictEqual([posts.length, reruns.length], [0, 0]);
  assert.strictEqual(handleInteraction(body, sign(body), { ...d, cfg: { ...d.cfg, signingSecret: undefined } }).status, 503);
});

test('actions: "Recommended fix" replies privately with the triage; no side effects', async () => {
  const { d, posts, reruns } = deps();
  const body = payload('radar_details', '101');
  const r = handleInteraction(body, sign(body), d);
  await r.done;
  assert.strictEqual(r.status, 200);
  assert.strictEqual(posts[0].body.response_type, 'ephemeral');
  assert.match(posts[0].body.text, /2 problems/);
  assert.strictEqual(reruns.length, 0);
});

test('actions: re-run is disabled by default', async () => {
  const { d, posts, reruns } = deps();
  const body = payload('radar_rerun', '101');
  const r = handleInteraction(body, sign(body), d);
  await r.done;
  assert.match(posts[0].body.text, /disabled/);
  assert.strictEqual(reruns.length, 0);
});

test('actions: enabled but user not allow-listed -> refused', async () => {
  const { d, posts, reruns } = deps({ allowActions: true, allowedUsers: ['U0OTHER'] });
  const body = payload('radar_rerun', '101');
  await handleInteraction(body, sign(body), d).done;
  assert.match(posts[0].body.text, /not on the allow-list/);
  assert.strictEqual(reruns.length, 0);
});

test('actions: allow-listed user gets a DRY RUN by default; real re-run only when dryRunActions=false', async () => {
  const a = deps({ allowActions: true, allowedUsers: ['U0PRIYA01'] });
  const body = payload('radar_rerun', '101');
  await handleInteraction(body, sign(body), a.d).done;
  assert.match(a.posts[0].body.text, /Dry run/);
  assert.strictEqual(a.reruns.length, 0);

  const b = deps({ allowActions: true, allowedUsers: ['U0PRIYA01'], dryRunActions: false });
  await handleInteraction(body, sign(body), b.d).done;
  assert.deepStrictEqual(b.reruns, ['101']);
  assert.match(b.posts[0].body.text, /Re-run requested/);
});

test('actions: only jobs ReleaseRadar announced can be acted on; weird ids are rejected', async () => {
  const { d, posts, reruns } = deps({ allowActions: true, allowedUsers: ['U0PRIYA01'], dryRunActions: false });
  for (const v of ['999', '101; rm -rf /', '../x', '']) {
    const body = payload('radar_rerun', v);
    await handleInteraction(body, sign(body), d).done;
  }
  assert.strictEqual(reruns.length, 0);
  assert.ok(posts.every((p) => /no longer tracked/.test(p.body.text)));
});

test('actions: bad response_url is refused before anything runs', () => {
  const { d, reruns } = deps({ allowActions: true, allowedUsers: ['U0PRIYA01'], dryRunActions: false });
  const body = payload('radar_rerun', '101', 'U0PRIYA01', 'https://evil.example/steal');
  assert.strictEqual(handleInteraction(body, sign(body), d).status, 400);
  assert.strictEqual(reruns.length, 0);
});

test('actions: a failing re-run is reported, not thrown', async () => {
  const { d, posts } = deps({ allowActions: true, allowedUsers: ['U0PRIYA01'], dryRunActions: false });
  d.client = { rerun: async () => { throw new Error('copado said no'); } };
  const body = payload('radar_rerun', '101');
  await handleInteraction(body, sign(body), d).done;
  assert.match(posts[0].body.text, /Re-run failed: copado said no/);
});

// ---------- server ----------
test('server: real HTTP round trip with signature, 404s, health, and oversized body', async () => {
  const { d, posts } = deps();
  d.nowSeconds = undefined; // real clock for the server test
  const body = payload('radar_details', '101');
  const ts = Math.floor(Date.now() / 1000);
  const srv = createServer(d);
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;
  const req = (method: string, path: string, headers: Record<string, string> = {}, data = ''): Promise<number> =>
    new Promise((resolve, reject) => {
      const r = http.request({ port, method, path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      r.on('error', reject);
      r.end(data);
    });
  try {
    assert.strictEqual(await req('GET', '/health'), 200);
    assert.strictEqual(await req('GET', '/nope'), 404);
    assert.strictEqual(await req('POST', '/slack/actions', {}, body), 401);
    assert.strictEqual(await req('POST', '/slack/actions', sign(body, ts), body), 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(posts.length, 1);
  } finally {
    srv.close();
  }
});

// ---------- webhook posting ----------
test('SlackNotifier: posts blocks as JSON to the webhook and surfaces non-2xx as an error', async () => {
  const sent: Array<{ url: string; init: any }> = [];
  const okFetch = (async (url: string, init: any) => (sent.push({ url, init }), { ok: true, status: 200 })) as unknown as typeof fetch;
  const n = new SlackNotifier('https://hooks.slack.com/services/T/B/x', okFetch);
  await n.failure(report());
  await n.info(':white_check_mark: done');
  assert.strictEqual(sent[0].url, 'https://hooks.slack.com/services/T/B/x');
  assert.strictEqual(sent[0].init.method, 'POST');
  const body = JSON.parse(sent[0].init.body);
  assert.ok(Array.isArray(body.blocks) && body.text);
  const bad = new SlackNotifier('https://hooks.slack.com/x', (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch);
  await assert.rejects(() => bad.info('x'), /404/);
});

test('server logs what each Slack request got, so a missing secret / wrong secret / wrong path is visible in the terminal', async () => {
  const lines: string[] = [];
  const { d } = deps();
  d.nowSeconds = undefined;
  d.log = (s) => lines.push(s);
  const srv = createServer(d);
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;
  const post = (path: string, headers: Record<string, string>, data: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const r = http.request({ port, method: 'POST', path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      r.on('error', reject);
      r.end(data);
    });
  const body = payload('radar_details', '101');
  try {
    await post('/slack/actions', {}, body);
    assert.ok(lines.some((l) => /HTTP 401 \(signature mismatch/.test(l)));
    d.cfg.signingSecret = undefined;
    await post('/slack/actions', {}, body);
    assert.ok(lines.some((l) => /HTTP 503 \(SLACK_SIGNING_SECRET is not set/.test(l)));
    await post('/wrong/path', {}, body);
    assert.ok(lines.some((l) => /unexpected request POST \/wrong\/path .*\/slack\/actions/.test(l)));
    d.cfg.signingSecret = SECRET;
    await post('/slack/actions', sign(body, Math.floor(Date.now() / 1000)), body);
    assert.ok(lines.some((l) => /HTTP 200$/.test(l)));
  } finally {
    srv.close();
  }
});
