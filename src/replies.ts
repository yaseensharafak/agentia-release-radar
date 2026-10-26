import { safeBase } from './describe';
import { Component, FailureReport, LinkButton } from './types';

/** Slack mrkdwn needs & < > escaped in text we put around links. */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ID = /^[A-Za-z0-9]{15,18}$/;

/** The plain status word Copado answered with ("In Progress"), if the reply was the usual {"status": "..."} JSON. */
export function statusOf(raw: string): string | undefined {
  try {
    const st = (JSON.parse(raw) as { status?: unknown }).status;
    return typeof st === 'string' && /^[\w .-]{1,40}$/.test(st) ? st : undefined;
  } catch {
    return undefined;
  }
}

/** "Promotion P-4411" (a link to the promotion in Copado when we can), or the job's own name. */
function subject(report: Pick<FailureReport, 'job'>, orgUrl: string | undefined): string {
  const j = report.job;
  const base = safeBase(orgUrl);
  const label = j.promotion ? `Promotion ${j.promotion}` : j.number ?? j.name ?? j.id;
  const target = base && j.promotionId && ID.test(j.promotionId) ? j.promotionId : base && ID.test(j.id) ? j.id : undefined;
  return target && base ? `<${base}/${target}|${esc(label)}>` : `*${esc(label)}*`;
}

/** Reply to a live Re-run: names the promotion (hyperlinked) and the state Copado reported. No JSON. */
export function rerunMessage(report: Pick<FailureReport, 'job'>, user: string, rawReply: string, orgUrl: string | undefined): string {
  const j = report.job;
  const num = j.number && j.promotion ? ` (${esc(j.number)})` : '';
  const status = statusOf(rawReply);
  return `🔄 Re-run requested for ${subject(report, orgUrl)}${num} by <@${user}>${status ? `: *${esc(status)}*` : ''}.\nWatch this channel for the result.`;
}

/** Sent the moment someone clicks "Commit missing components", before the (slow) commit runs. */
export function commitRequestedMessage(story: string, components: Component[], user: string): string {
  return `Commit requested for ${esc(story)} by <@${user}>:\n${components.map((c) => `• \`${c.type}:${c.name}\``).join('\n')}`.slice(0, 2900);
}

/** Sent when the commit call has finished: a short confirmation and the next steps as link buttons. */
export function commitFinishedMessage(
  report: Pick<FailureReport, 'job' | 'revalidateAction'>,
  plan: { story: string; storyId?: string; components: Component[] },
  orgUrl: string | undefined,
): { text: string; buttons: LinkButton[] } {
  const base = safeBase(orgUrl);
  const n = plan.components.length;
  const buttons: LinkButton[] = [];
  if (base && plan.storyId && ID.test(plan.storyId)) buttons.push({ label: 'Validate in Copado ↗', url: `${base}/${plan.storyId}`, primary: true });
  if (base && report.job.promotionId && ID.test(report.job.promotionId)) buttons.push({ label: 'Open promotion ↗', url: `${base}/${report.job.promotionId}` });
  const next = report.revalidateAction ? 'Use the Re-validate button to confirm the failure is gone.' : 'Validate again in Copado to confirm the failure is gone.';
  return { text: `✅ Commit finished for ${esc(plan.story)} (${n} component${n === 1 ? '' : 's'} added). ${next}`, buttons };
}
