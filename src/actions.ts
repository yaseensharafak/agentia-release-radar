import { commitMessage, showCommand } from './commit';
import { redact } from './redact';
import { revalidateLabel } from './revalidate';
import { Registry } from './registry';
import { commitFinishedMessage, commitRequestedMessage, rerunMessage } from './replies';
import { detailsText, isSlackResponseUrl, linkRow, verifySlackSignature } from './slack';
import { Component, Config, LinkButton, RevalidateAction } from './types';

export interface ActionClient {
  rerun(id: string): Promise<string>;
  commitCommands?(story: string, components: Component[], message: string, storyId?: string): string[][];
  commitMissing?(story: string, components: Component[], message: string, storyId?: string): Promise<string>;
  revalidateCommand?(ctx: RevalidateAction & { message?: string }): string[];
  revalidate?(ctx: RevalidateAction & { message?: string }): Promise<string>;
}

export interface ActionDeps {
  cfg: Config;
  registry: Registry;
  client: ActionClient;
  post: (url: string, body: unknown) => Promise<void>;
  nowSeconds?: () => number;
  log?: (s: string) => void;
}

export interface ActionResult {
  status: number;
  body: string;
  /** Resolves when the follow-up message has been posted (tests await it; the HTTP server does not). */
  done?: Promise<void>;
}

const JOB_ID = /^[\w-]{1,64}$/;

interface SlackPayload {
  type?: string;
  user?: { id?: string };
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
}

/**
 * Slack interactivity entry point. Order matters: authenticate first, then authorise, then act.
 * Re-run is OFF unless allowActions is set, limited to allowedUsers, limited to jobs we announced,
 * and DRY-RUN unless dryRunActions is explicitly disabled.
 */
export function handleInteraction(rawBody: string, headers: Record<string, string | undefined>, d: ActionDeps): ActionResult {
  if (!d.cfg.signingSecret) return { status: 503, body: 'signing secret not configured' };
  const ok = verifySlackSignature({
    signingSecret: d.cfg.signingSecret,
    timestamp: headers['x-slack-request-timestamp'],
    signature: headers['x-slack-signature'],
    rawBody,
    nowSeconds: d.nowSeconds?.(),
  });
  if (!ok) return { status: 401, body: 'invalid signature' };

  let payload: SlackPayload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '') as SlackPayload;
  } catch {
    return { status: 400, body: 'bad payload' };
  }
  if (payload.type !== 'block_actions' || !payload.actions?.length) return { status: 200, body: '' };
  const action = payload.actions[0];
  const url = payload.response_url ?? '';
  if (!isSlackResponseUrl(url)) return { status: 400, body: 'bad response_url' };

  const reply = (text: string, buttons?: LinkButton[]): Promise<void> => {
    const row = linkRow(buttons);
    const body = row
      ? { response_type: 'ephemeral', replace_original: false, text: redact(text), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: redact(text) } }, row] }
      : { response_type: 'ephemeral', replace_original: false, text: redact(text) };
    return d.post(url, body).catch((e: Error) => d.log?.(`[radar] reply failed: ${e.message}`));
  };

  /** An action is dry unless dryRunActions is off, or it is listed in liveActions. */
  const isDry = (name: 'commit' | 'rerun' | 'revalidate'): boolean => d.cfg.dryRunActions && !d.cfg.liveActions.includes(name);

  if (action.action_id?.startsWith('radar_link')) return { status: 200, body: '' }; // a link button: Slack opens the URL itself

  const jobId = String(action.value ?? '');
  const report = JOB_ID.test(jobId) ? d.registry.get(jobId) : undefined;
  if (!report) return { status: 200, body: '', done: reply('That job is no longer tracked by ReleaseRadar (it may have been restarted).') };

  if (action.action_id === 'radar_details') {
    return { status: 200, body: '', done: reply(detailsText(report)) };
  }

  if (action.action_id === 'radar_rerun') {
    const user = payload.user?.id ?? '';
    if (!d.cfg.allowActions) return { status: 200, body: '', done: reply('Re-run is disabled in this ReleaseRadar deployment.') };
    if (!user || !d.cfg.allowedUsers.includes(user)) return { status: 200, body: '', done: reply('You are not on the allow-list for re-running jobs.') };
    if (isDry('rerun')) {
      return {
        status: 200,
        body: '',
        done: reply(`Dry run: would ask Copado to re-run job \`${jobId}\` (requested by <@${user}>). Set liveActions to include rerun (or dryRunActions=false) to enable.`),
      };
    }
    const done = (async () => {
      try {
        const out = await d.client.rerun(jobId);
        d.log?.(`[radar] rerun ${jobId} by ${user}`);
        await reply(rerunMessage(report, user, out, d.cfg.orgUrl));
      } catch (e) {
        await reply(`Re-run failed: ${(e as Error).message}`.slice(0, 500));
      }
    })();
    return { status: 200, body: '', done };
  }

  if (action.action_id === 'radar_revalidate') {
    const user = payload.user?.id ?? '';
    if (!d.cfg.allowActions) return { status: 200, body: '', done: reply('Re-validate is disabled in this ReleaseRadar deployment.') };
    if (!user || !d.cfg.allowedUsers.includes(user)) return { status: 200, body: '', done: reply('You are not on the allow-list for this action.') };
    const ctx = report.revalidateAction;
    if (!ctx || !d.client.revalidateCommand || !d.client.revalidate) {
      return { status: 200, body: '', done: reply('Re-validate is not configured for this failure. Start a new validation in Copado by hand.') };
    }
    if (report.revalidateRequested && !report.revalidateRequested.dryRun) {
      return { status: 200, body: '', done: reply(`Already requested by <@${report.revalidateRequested.by}> at ${report.revalidateRequested.at}.`) };
    }
    const message = `ReleaseRadar re-validation (${report.job.number ?? report.job.id})`;
    let argv: string[];
    try {
      argv = d.client.revalidateCommand({ ...ctx, message });
    } catch (e) {
      return { status: 200, body: '', done: reply(`Refused: ${(e as Error).message}`.slice(0, 400)) };
    }
    const now = new Date().toISOString();
    if (isDry('revalidate')) {
      report.revalidateRequested = { by: user, at: now, dryRun: true };
      d.log?.(`[radar] revalidate DRY RUN ${ctx.story ?? ctx.promotion} by ${user}`);
      return { status: 200, body: '', done: reply(`Dry run: would re-create the validation promotion branch and validate again (${revalidateLabel(ctx)}), requested by <@${user}>:\n\`${showCommand(argv)}\`\nCheck-only: this is only offered for jobs that were validations. Set liveActions to include revalidate (or dryRunActions=false) to enable.`.slice(0, 2900)) };
    }
    report.revalidateRequested = { by: user, at: now, dryRun: false };
    d.log?.(`[radar] revalidate ${ctx.story ?? ctx.promotion} by ${user}`);
    const done = (async () => {
      try {
        const out = await d.client.revalidate?.({ ...ctx, message });
        await reply(`Re-validation requested by <@${user}>.\n\`\`\`${(out ?? '').slice(0, 400)}\`\`\`\nWatch this channel for the result.`.slice(0, 2900));
      } catch (e) {
        report.revalidateRequested = undefined;
        await reply(`Re-validation failed: ${(e as Error).message}`.slice(0, 500));
      }
    })();
    return { status: 200, body: '', done };
  }

  if (action.action_id === 'radar_commit_missing') {
    const user = payload.user?.id ?? '';
    if (!d.cfg.allowCommitMissing) return { status: 200, body: '', done: reply('Committing missing components is disabled in this ReleaseRadar deployment.') };
    if (!user || !d.cfg.allowedUsers.includes(user)) return { status: 200, body: '', done: reply('You are not on the allow-list for this action.') };
    const plan = report.commitAction;
    if (!plan || !d.client.commitCommands || !d.client.commitMissing) {
      return { status: 200, body: '', done: reply('There is no unambiguous story and component list to commit for this failure. Commit them in Copado by hand.') };
    }
    if (report.commitRequested && !report.commitRequested.dryRun) {
      return { status: 200, body: '', done: reply(`Already requested by <@${report.commitRequested.by}> at ${report.commitRequested.at}. Re-validate the promotion to see the result.`) };
    }
    const message = commitMessage(report.job);
    let argvs: string[][];
    try {
      argvs = d.client.commitCommands(plan.story, plan.components, message, plan.storyId);
    } catch (e) {
      return { status: 200, body: '', done: reply(`Refused: ${(e as Error).message}`.slice(0, 400)) };
    }
    const names = plan.components.map((c) => `• \`${c.type}:${c.name}\``).join('\n');
    const now = new Date().toISOString();
    if (isDry('commit')) {
      report.commitRequested = { by: user, at: now, dryRun: true };
      d.log?.(`[radar] commit-missing DRY RUN ${plan.story} (${plan.components.length}) by ${user}`);
      return {
        status: 200,
        body: '',
        done: reply(
          `Dry run: would commit ${plan.components.length} component${plan.components.length > 1 ? 's' : ''} into ${plan.story} (requested by <@${user}>):\n${names}\n${argvs.length > 1 ? `Commands (${argvs.length}, run one after another):` : 'Command:'} ${argvs.slice(0, 2).map((x) => `\`${showCommand(x)}\``).join('\n')}${argvs.length > 2 ? `\n(+${argvs.length - 2} more)` : ''}\nSet liveActions to include commit (or dryRunActions=false) to enable. Cloud-flow stories only; the components must exist in the story's source org.`.slice(0, 2900),
        ),
      };
    }
    // Mark BEFORE running so a second click cannot start a duplicate commit; clear it if the commit fails.
    report.commitRequested = { by: user, at: now, dryRun: false };
    d.log?.(`[radar] commit-missing ${plan.story} ${plan.components.map((c) => `${c.type}:${c.name}`).join(',')} by ${user}`);
    const done = (async () => {
      try {
        // Say so at once: the commit itself takes a while, and people should see their click was received.
        await reply(commitRequestedMessage(plan.story, plan.components, user));
        await (d.client.commitMissing as NonNullable<ActionClient['commitMissing']>)(plan.story, plan.components, message, plan.storyId);
        const fin = commitFinishedMessage(report, plan, d.cfg.orgUrl);
        await reply(fin.text, fin.buttons);
        if (d.cfg.autoRevalidate && report.revalidateAction && d.client.revalidate && d.client.revalidateCommand) {
          const ctx = { ...report.revalidateAction, message: `ReleaseRadar re-validation after committing missing components (${report.job.number ?? report.job.id})` };
          try {
            if (isDry('revalidate')) await reply(`Dry run: would now re-validate: \`${showCommand(d.client.revalidateCommand(ctx))}\``);
            else await reply(`Re-validation requested.\n\`\`\`${(await d.client.revalidate(ctx)).slice(0, 400)}\`\`\``);
          } catch (e) {
            await reply(`Re-validation failed: ${(e as Error).message}`.slice(0, 500));
          }
        }
      } catch (e) {
        report.commitRequested = undefined;
        await reply(`Commit failed: ${(e as Error).message}`.slice(0, 500));
      }
    })();
    return { status: 200, body: '', done };
  }
  return { status: 200, body: '' };
}
