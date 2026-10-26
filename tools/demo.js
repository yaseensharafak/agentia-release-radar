#!/usr/bin/env node
// Offline demo against the MOCK agentia binary. Cross-platform (no sh, no rm, no env-prefix syntax).
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const repo = path.join(os.tmpdir(), 'radar-demo-repo');
execFileSync(process.execPath, [path.join(__dirname, 'make-demo-repo.js'), repo], { stdio: 'ignore' });

const cfg = path.join(os.tmpdir(), 'radar-demo-config.json');
fs.writeFileSync(
  cfg,
  JSON.stringify({
    repoDir: repo,
    users: { 'priya@example.com': 'U0PRIYA01', 'marcus@example.com': 'U0MARCUS1' },
    notifyOn: ['failure', 'success'],
  }),
);
const state = path.join(os.tmpdir(), 'radar-fake-state.json');
fs.rmSync(state, { force: true });

const r = spawnSync(
  process.execPath,
  [path.join(root, 'dist', 'src', 'cli.js'), 'watch', '--config', cfg, '--notifier', 'console', '--interval', '1', '--max-polls', '3', '--ai'],
  { stdio: 'inherit', env: { ...process.env, AGENTIA_BIN: path.join(__dirname, 'fake-agentia', 'agentia.js'), FAKE_STATE: state } },
);
process.exit(r.status === null ? 1 : r.status);
