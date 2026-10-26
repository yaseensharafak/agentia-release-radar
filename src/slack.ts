import { createHmac, timingSafeEqual } from 'crypto';
import { Success } from './describe';
import { revalidateLabel } from './revalidate';
import { FailureReport, LinkButton, Owner } from './types';

type Block = Record<string, unknown>;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Neutralise Slack control sequences coming from logs/commit data (mentions, links, mrkdwn). */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function ownerLabel(o: Owner): string {
  const who = o.slackId ? `<@${o.slackId}>` : o.name ? `*${esc(o.name)}*` : undefined;
  return [who, o.story ? esc(o.story) : undefined, o.commit ? `commit \`${esc(o.commit)}\`` : undefined].filter(Boolean).join(' · ');
}

const list = (xs: string[], max: number): string => (xs.length > max ? `${xs.slice(0, max).join(', ')} +${xs.length - max} more` : xs.join(', '));

/** "Commit N missing components to US-..." with a confirmation that names exactly what will be committed. */
function commitButton(jobId: string, a: { story: string; components: Array<{ type: string; name: string }> }): Block {
  const n = a.components.length;
  return {
    type: 'button',
    action_id: 'radar_commit_missing',
    text: { type: 'plain_text', text: clip(`Commit ${n} missing component${n > 1 ? 's' : ''} to ${a.story}`, 75) },
    value: jobId,
    style: 'primary',
    confirm: {
      title: { type: 'plain_text', text: clip(`Commit to ${a.story}?`, 100) },
      text: {
        type: 'mrkdwn',
        text: clip(`Copado will commit *${esc(list(a.components.map((c) => `${c.type}:${c.name}`), 4))}* from the story's source org into ${esc(a.story)}. Cloud-flow stories only. Re-validate afterwards.`, 290),
      },
      confirm: { type: 'plain_text', text: 'Commit' },
      deny: { type: 'plain_text', text: 'Cancel' },
    },
  };
}

function revalidateButton(jobId: string, a: NonNullable<FailureReport['revalidateAction']>): Block {
  return {
    type: 'button',
    action_id: 'radar_revalidate',
    text: { type: 'plain_text', text: revalidateLabel(a) },
    value: jobId,
    confirm: {
      title: { type: 'plain_text', text: 'Start a new validation?' },
      text: { type: 'mrkdwn', text: 'Copado will re-create the validation promotion branch from the story\'s latest commits and validate again (check-only), so new commits are included.' },
      confirm: { type: 'plain_text', text: 'Re-validate' },
      deny: { type: 'plain_text', text: 'Cancel' },
    },
  };
}

function rerunButton(jobId: string): Block {
  return {
    type: 'button',
    action_id: 'radar_rerun',
    text: { type: 'plain_text', text: 'Re-run job' },
    value: jobId,
    confirm: {
      title: { type: 'plain_text', text: 'Re-run this job?' },
      text: { type: 'mrkdwn', text: 'This asks Copado to resume the outstanding steps of this same job execution. It does not include new commits (use Re-validate for that).' },
      confirm: { type: 'plain_text', text: 'Re-run' },
      deny: { type: 'plain_text', text: 'Cancel' },
    },
  };
}

export function buildFailureBlocks(r: FailureReport): { text: string; blocks: Block[] } {
  const where = (f: { component?: string; line?: number }): string =>
    f.component ? `\`${esc(f.component)}${f.line ? `:${f.line}` : ''}\`` : '';
  const more = (f: { count?: number; affects?: string[] }): string =>
    f.count && f.count > 1 ? ` · ${f.count} errors${f.affects && f.affects.length > 1 ? ` in ${f.affects.length} components` : ''}` : '';
  const findings = r.triage.findings
    .slice(0, 6)
    .map((f) => `• ${where(f)} ${esc(clip(f.message, 200))}${more(f)}`.trim())
    .join('\n');
  const owners = r.owners.map((o) => `• \`${esc(o.component)}\` → ${ownerLabel(o.owner)}`).join('\n');

  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(`Job failed: ${r.job.name}`.replace(/[<>]/g, ''), 150) } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status*\n${esc(r.job.status)}` },
        { type: 'mrkdwn', text: `*Job*\n\`${esc(r.job.id)}\`` },
        ...(r.job.promotion ? [{ type: 'mrkdwn', text: `*Promotion*\n${esc(r.job.promotion)}` }] : []),
        ...(r.job.story ? [{ type: 'mrkdwn', text: `*Story*\n${esc(r.job.story)}` }] : []),
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: clip(`*${esc(r.triage.headline)}*\n${esc(r.triage.explanation)}`, 2900) } },
  ];
  if (findings) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*Root causes*\n${findings}`, 2900) } });
  if (owners) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: clip(`*Story / owner*\n${owners}`, 2900) },
    });
  }
  const failLinks = (r.links ?? []).map(mrkdwnLink).filter((x): x is string => !!x);
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: [r.triage.source === 'ai+rules' ? 'Explanation: AI-generated from the log. Verify before acting.' : 'Explanation: rule-based (no AI used).', ...failLinks].join('  ·  '),
      },
    ],
  });
  blocks.push({
    type: 'actions',
    block_id: `radar_${r.job.id}`.slice(0, 255),
    elements: [
      { type: 'button', action_id: 'radar_details', text: { type: 'plain_text', text: 'Recommended fix' }, value: r.job.id },
      ...(r.commitAction ? [commitButton(r.job.id, r.commitAction)] : []),
      ...(r.revalidateAction ? [revalidateButton(r.job.id, r.revalidateAction)] : []),
      ...(r.hideRerun ? [] : [rerunButton(r.job.id)]),
    ],
  });
  return { text: esc(`Job failed: ${r.job.name}. ${r.triage.headline}`), blocks: blocks.slice(0, 50) };
}

export function buildInfoBlocks(text: string): { text: string; blocks: Block[] } {
  return { text: esc(text), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(esc(text), 2900) } }] };
}

export function detailsText(r: FailureReport): string {
  const lines = [`*${esc(r.triage.headline)}*`, esc(r.triage.explanation)];
  for (const f of r.triage.findings) lines.push(`• [${f.category}] ${f.component ? `\`${esc(f.component)}${f.line ? `:${f.line}` : ''}\` ` : ''}${esc(f.message)}${f.count && f.count > 1 ? ` (${f.count} errors)` : ''}`);
  return clip(lines.join('\n'), 2900);
}

export async function postJson(url: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Slack responded ${res.status}`);
}

/** https://api.slack.com/authentication/verifying-requests-from-slack */
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp?: string;
  signature?: string;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  if (!timestamp || !signature) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300) return false; // replay window
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack only ever gives hooks.slack.com response URLs. Refuse anything else (SSRF guard). */
export const isSlackResponseUrl = (u: string): boolean => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
};

/** `<url|label>` only for plain https URLs; anything else is dropped, never passed through. */
const mrkdwnLink = (l: { label: string; url: string }): string | undefined =>
  /^https:\/\/[^\s<>|]+$/.test(l.url) ? `<${l.url}|${esc(l.label).replace(/\|/g, '/')}>` : undefined;

/**
 * One row of link buttons (they only open a page; ReleaseRadar does nothing when they are clicked). https only, at most 5,
 * unique action ids, labels within Slack's 75 characters.
 */
export function linkRow(buttons: LinkButton[] | undefined): Block | undefined {
  const els = (buttons ?? [])
    .filter((b) => /^https:\/\/[^\s<>|"]+$/.test(b.url) && b.url.length <= 3000 && b.label.trim())
    .slice(0, 5)
    .map((b, i) => ({
      type: 'button',
      action_id: `radar_link_${i}`,
      text: { type: 'plain_text', text: clip(b.label.replace(/[<>]/g, ''), 75) },
      url: b.url,
      ...(b.primary ? { style: 'primary' } : {}),
    }));
  return els.length ? { type: 'actions', elements: els } : undefined;
}

export function buildSuccessBlocks(s: Success): { text: string; blocks: Block[] } {
  const links = s.links.map(mrkdwnLink).filter((x): x is string => !!x);
  const small = [esc(s.meta), ...links].filter(Boolean).join('  ·  ');
  const blocks: Block[] = [
    { type: 'section', text: { type: 'mrkdwn', text: clip(`${s.emoji} *${esc(s.title)}*${s.detail ? `\n${esc(s.detail)}` : ''}`, 2900) } },
  ];
  if (small) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(small, 2900) }] });
  const row = linkRow(s.buttons);
  if (row) blocks.push(row);
  return { text: esc(s.detail ? `${s.title}: ${s.detail}` : s.title), blocks };
}
