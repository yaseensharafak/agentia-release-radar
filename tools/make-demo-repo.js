#!/usr/bin/env node
// Builds a small local git repo whose history matches the mock failure log, so owner tagging can be demoed.
// Cross-platform (Windows, macOS, Linux): uses only node and git.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'radar-demo-repo'));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'force-app', 'main', 'default', 'classes'), { recursive: true });
fs.mkdirSync(path.join(dir, 'force-app', 'main', 'default', 'objects', 'Claim__c', 'fields'), { recursive: true });

const git = (args, env = {}) =>
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...env } });
const put = (rel, text) => fs.writeFileSync(path.join(dir, ...rel.split('/')), text + '\n');
const commit = (name, email, msg) => {
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg], {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
  });
};

git(['init', '-q', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);

put('force-app/main/default/classes/PaymentHelper.cls', 'public class PaymentHelper {}');
commit('Marcus Lee', 'marcus@example.com', 'US-0000138 refactor PaymentHelper');

put('force-app/main/default/classes/PaymentCalculator.cls', 'public class PaymentCalculator {}');
put('force-app/main/default/classes/PaymentCalculatorTest.cls', '@isTest public class PaymentCalculatorTest {}');
commit('Priya Nair', 'priya@example.com', 'US-0000142 use countNewMonths in calculator');

put('force-app/main/default/objects/Claim__c/fields/Appeal_Status__c.field-meta.xml', '<CustomField/>');
commit('Marcus Lee', 'marcus@example.com', 'US-0000151 add appeal status field');

console.log(dir);
