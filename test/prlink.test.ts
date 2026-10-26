import * as assert from 'assert';
import { test } from 'node:test';
import { createHmac } from 'crypto';
import * as path from 'path';
import { AgentiaClient, defaultRunner, pullRequestUrlFrom } from '../src/agentia';
import { DEFAULTS, loadConfig } from '../src/config';
import { handleInteraction } from '../src/actions';
import { Registry } from '../src/registry';

const GOOD = { gitProvider: 'Github', pullRequestBaseUrl: 'https://github.com/acme/repo/', destinationEnvironmentBranch: 'uat', compareBranch: 'promotion/P-4411', isMerged: true };

test('pull request link: GitHub compare URL from Copado\'s openPullRequest; anything odd gives no link', () => {
  assert.strictEqual(pullRequestUrlFrom(GOOD), 'https://github.com/acme/repo/compare/uat...promotion/P-4411?expand=1');
  assert.strictEqual(pullRequestUrlFrom({ ...GOOD, pullRequestBaseUrl: 'https://github.com/acme/repo' }), 'https://github.com/acme/repo/compare/uat...promotion/P-4411?expand=1');
  for (const bad of [undefined, null, 'x', {}, { ...GOOD, gitProvider: 'Bitbucket' }, { ...GOOD, pullRequestBaseUrl: 'http://github.com/a/b/' }, { ...GOOD, pullRequestBaseUrl: 'javascript:alert(1)' },
    { ...GOOD, compareBranch: 'a b' }, { ...GOOD, compareBranch: 'x"><script>' }, { ...GOOD, destinationEnvironmentBranch: 'a..b' }, { ...GOOD, pullRequestBaseUrl: 'https://x.com/a|b/' }]) {
    assert.strictEqual(pullRequestUrlFrom(bad), undefined, JSON.stringify(bad));
  }
});

test('pull request link: off by default; a failed lookup means no link, never an error', async () => {
  assert.strictEqual(DEFAULTS.pullRequestLinks, false);
  assert.strictEqual(loadConfig(undefined, { RADAR_PR_LINKS: '1' } as NodeJS.ProcessEnv).pullRequestLinks, true);
  const ok = new AgentiaClient(async () => JSON.stringify({ result: { openPullRequest: GOOD } }), DEFAULTS.commands);
  assert.match((await ok.pullRequestUrl('a89Xx0000000901AAA')) ?? '', /compare\/uat\.\.\.promotion\/P-4411/);
  const boom = new AgentiaClient(async () => { throw new Error('nope'); }, DEFAULTS.commands);
  assert.strictEqual(await boom.pullRequestUrl('a89Xx0000000901AAA'), undefined);
  assert.strictEqual(await ok.pullRequestUrl('bad id; rm'), undefined, 'odd ids are never passed to the CLI');
  assert.strictEqual(await ok.pullRequestUrl(undefined), undefined);
});

test('pull request link: clicking the link button does nothing on our side (no "no longer tracked" reply)', () => {
  const secret = 's3cret';
  const body = 'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: 'U1' }, response_url: 'https://hooks.slack.com/actions/x', actions: [{ action_id: 'radar_link_0' }] }));
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  const posts: unknown[] = [];
  const r = handleInteraction(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, {
    cfg: { ...DEFAULTS, signingSecret: secret }, registry: new Registry(), client: new AgentiaClient(async () => '{}', DEFAULTS.commands), post: async (_u, b) => { posts.push(b); },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.done, undefined);
  assert.strictEqual(posts.length, 0);
});

test('pull request link: through the real child-process path (mock agentia)', async () => {
  const fake = path.join(__dirname, '../../tools/fake-agentia/agentia.js');
  const before = process.env.AGENTIA_JS;
  process.env.AGENTIA_JS = fake;
  try {
    const c = new AgentiaClient(defaultRunner, DEFAULTS.commands);
    assert.match((await c.pullRequestUrl('a89Xx0000000104AAA')) ?? '', /^https:\/\/github\.com\/acme\/demo-repo\/compare\/uat\.\.\.promotion\/P-MOCK\?expand=1$/);
  } finally {
    if (before === undefined) delete process.env.AGENTIA_JS; else process.env.AGENTIA_JS = before;
  }
});
