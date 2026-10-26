import * as assert from 'assert';
import { test } from 'node:test';
import { commitFinishedMessage, commitRequestedMessage, rerunMessage, statusOf } from '../src/replies';
import { JobSummary } from '../src/types';

const ORG = 'https://acme.my.salesforce.com';
const job: JobSummary = { id: 'a7qXx0000000777AAA', name: 'SFDX Deploy', number: 'JE-900015', status: 'Error', state: 'failure', promotion: 'P-4411', promotionId: 'a89Xx0000000901AAA' };
const RAW = '{"jobId":"a7qXx0000000777","operation":"resume","status":"In Progress"}';

test('re-run reply: names the promotion as a link and the state, no JSON', () => {
  const t = rerunMessage({ job }, 'U1', RAW, ORG);
  assert.strictEqual(t, `🔄 Re-run requested for <${ORG}/a89Xx0000000901AAA|Promotion P-4411> (JE-900015) by <@U1>: *In Progress*.\nWatch this channel for the result.`);
  assert.ok(!t.includes('{') && !t.includes('jobId'));
});

test('re-run reply: falls back gracefully (no promotion, no org link, unreadable reply)', () => {
  const noPromo = rerunMessage({ job: { ...job, promotion: undefined, promotionId: undefined } }, 'U1', RAW, ORG);
  assert.match(noPromo, /for <https:\/\/acme\.my\.salesforce\.com\/a7qXx0000000777AAA\|JE-900015> by/);
  assert.match(rerunMessage({ job }, 'U1', RAW, undefined), /for \*Promotion P-4411\* \(JE-900015\) by <@U1>: \*In Progress\*/);
  assert.match(rerunMessage({ job }, 'U1', 'not json', ORG), /by <@U1>\.\nWatch/);
  assert.strictEqual(statusOf('{"status":"x<script>"}'), undefined);
  assert.match(rerunMessage({ job: { ...job, promotion: 'P<1>&' } }, 'U1', RAW, ORG), /Promotion P&lt;1&gt;&amp;/);
});

test('commit replies: requested at once with only the components; finished with next-step buttons', () => {
  const comps = [{ type: 'CustomField', name: 'ContentVersion.Is_Owner_Document__c' }, { type: 'ApexClass', name: 'AccountDivisionPortalController' }];
  assert.strictEqual(commitRequestedMessage('US-0000555', comps, 'U1'), 'Commit requested for US-0000555 by <@U1>:\n• `CustomField:ContentVersion.Is_Owner_Document__c`\n• `ApexClass:AccountDivisionPortalController`');
  const f = commitFinishedMessage({ job }, { story: 'US-0000555', storyId: 'a93Xx0000000555AAA', components: comps }, ORG);
  assert.match(f.text, /^✅ Commit finished for US-0000555 \(2 components added\)\. Validate again in Copado/);
  assert.deepStrictEqual(f.buttons.map((b) => [b.label, b.url]), [['Validate in Copado ↗', `${ORG}/a93Xx0000000555AAA`], ['Open promotion ↗', `${ORG}/a89Xx0000000901AAA`]]);
  assert.deepStrictEqual(commitFinishedMessage({ job }, { story: 'US-1', components: comps.slice(0, 1) }, undefined).buttons, [], 'no org link, no buttons');
  assert.match(commitFinishedMessage({ job }, { story: 'US-1', components: comps.slice(0, 1) }, ORG).text, /\(1 component added\)/);
});
