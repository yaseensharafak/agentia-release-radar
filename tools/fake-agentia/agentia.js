#!/usr/bin/env node
/**
 * MOCK `agentia` binary for offline demos and tests. It replays fixtures that I wrote by hand
 * from the documented envelope shape ({result, status, transactionId}); they are NOT recordings of a real org.
 * Replace with real answers via `agentia ... --json > file` once you have access (see README).
 *
 * `cicd job list` returns the next poll in fixtures/sequence.json each time it is called.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const STATE = process.env.FAKE_STATE || path.join(os.tmpdir(), 'radar-fake-state.json');
const args = process.argv.slice(2);
const out = (result, status = 'success') => {
  if (process.env.FAKE_WARN) console.log('(node:1) Warning: linked plugin uses ESM, auto-transpiling');
  console.log(JSON.stringify({ result, status, transactionId: 'fake-' + Date.now() }));
};
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n');
const [g, sub, verb, arg] = args;
if (g === 'cicd' && sub === 'job' && verb === 'list') {
  const seq = read('sequence.json');
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(STATE, 'utf8')).n; } catch {}
  fs.writeFileSync(STATE, JSON.stringify({ n: n + 1 }));
  out({ data: seq[Math.min(n, seq.length - 1)], page: 1, pageSize: 50 });
} else if (g === 'cicd' && sub === 'job' && verb === 'get') {
  const f = `job-${String(arg).replace(/[^\w-]/g, '')}.json`;
  if (!fs.existsSync(path.join(FIX, f))) { console.error('job not found'); process.exit(1); }
  out(read(f));
} else if (g === 'cicd' && sub === 'job' && (verb === 'resume' || verb === 'run')) {
  out({ message: `Job ${arg} ${verb} requested (mock)` });
} else if (g === 'cicd' && sub === 'work' && verb === 'list') {
  out({ data: read('work-list.json') });
} else if (g === 'cicd' && sub === 'promotion' && verb === 'get') {
  if (process.env.FAKE_PROMOTION_GET_FAIL) { console.error('promotion not found (mock)'); process.exit(1); }
  out({ id: String(arg), openPullRequest: { gitProvider: 'Github', pullRequestBaseUrl: 'https://github.com/acme/demo-repo/', destinationEnvironmentBranch: 'uat', compareBranch: 'promotion/P-MOCK', isMerged: false } });
} else if (g === 'cicd' && sub === 'cloud' && verb === 'promote') {
  if (args.includes('--help')) { console.log('Usage: agentia cicd cloud promote [ID] [--validate] [--json]\n(mock help)'); }
  else if (process.env.FAKE_PROMOTE_FAIL) { console.log(JSON.stringify({ error: { message: 'Copado error: promotion could not be created (mock) api_key=SECRETKEY123' } })); process.exit(1); }
  else out({ promotion: { name: 'P-MOCK', status: 'Started' }, args: args.slice(3) });
} else if (g === 'cicd' && sub === 'cloud' && verb === 'commit') {
  if (args.includes('--help')) { console.log('Usage: agentia cicd cloud commit --story <id> --metadata <Type:Name,...> --message <text> [--json]\n(mock help)'); }
  else if (process.env.FAKE_COMMIT_ERRORJSON) { console.log(JSON.stringify({ error: { message: 'Copado error: An Apex error occurred: System.StringException: Invalid id: US-0000777. Request: POST /release/commit via https://na.api.copado.com/json/v1/webhook/cicd-api?api_key=SECRETKEY123' } })); process.exit(1); }
  else if (process.env.FAKE_COMMIT_FAIL) { console.error('Preflight failed: component not found in source org (mock)'); process.exit(1); }
  else out({ message: 'Commit requested (mock)', args: args.slice(3) });
} else if (g === 'ai' && sub === 'agent' && verb === 'ask') {
  if (process.env.FAKE_AI === 'off') { console.error('AI not configured'); process.exit(1); }
  out({ answer: read('ai-answer.json').answer });
} else {
  console.error('mock agentia: unsupported command: ' + args.join(' '));
  process.exit(2);
}
