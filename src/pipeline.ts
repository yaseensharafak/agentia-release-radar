import { AgentiaClient, featureBranchPullRequestUrl } from './agentia';
import { eventKind, successButtons, wantsPullRequest } from './buttons';
import { resolveCommitAction } from './commit';
import { resolveRevalidateAction, revalidateContext } from './revalidate';
import { describeSuccess, jobLinks } from './describe';
import { Notifier } from './notify';
import { Transition } from './poller';
import { Registry } from './registry';
import { ownersForTriage } from './owners';
import { loadCustomRules, triage } from './triage';
import { Config, FailureReport, JobSummary } from './types';

export interface Deps {
  client: AgentiaClient;
  notifier: Notifier;
  registry: Registry;
  cfg: Config;
  log?: (s: string) => void;
}

/** Success is announced for the configured actions ("all" = every kind of job). Jobs without an action are always announced. */
export const successWanted = (cfg: Config, job: JobSummary): boolean =>
  cfg.successActions.includes('all') || !job.action || cfg.successActions.includes(job.action);

/** Turn state transitions into notifications. One bad job never stops the others. */
/**
 * Extra lookups for a success card's buttons. A job that names its story but not the story's record id gets it looked up once
 * (the Copado links need it). A commit's pull request is the story's own branch against its base branch (from the same lookup);
 * for validations and deployments it is the promotion's branch.
 */
async function forButtons(job: JobSummary, d: { client: AgentiaClient; cfg: Config }): Promise<{ job: JobSummary; prUrl?: string }> {
  const kind = eventKind(job);
  let prUrl = d.cfg.pullRequestLinks && wantsPullRequest(job) ? await d.client.pullRequestUrl(job.promotionId) : undefined;
  if (kind === 'commit' || kind === 'deployment') {
    const { story, storyId } = revalidateContext(job, d.cfg);
    const wantPr = kind === 'commit' && d.cfg.pullRequestLinks;
    if (story && (wantPr || (d.cfg.orgUrl && !storyId))) {
      const info = await d.client.storyDetails(story);
      if (info?.id && !storyId) job = { ...job, storyIds: { ...job.storyIds, [story]: info.id } };
      if (wantPr && info) prUrl = featureBranchPullRequestUrl(info.prBaseUrl, info.baseBranch, story);
    }
  }
  return { job, prUrl };
}

export async function handleTransitions(ts: Transition[], d: Deps): Promise<FailureReport[]> {
  const reports: FailureReport[] = [];
  for (const t of ts) {
    try {
      if (t.to === 'failure' && d.cfg.notifyOn.includes('failure')) {
        const job = await d.client.getJob(t.job.id, t.job);
        const custom = loadCustomRules(d.cfg.rulesFile);
        for (const pr of custom.problems) d.log?.(`[radar] ${pr}`);
        const tri = await triage(job, d.cfg.aiEnabled ? (p) => d.client.ask(p) : undefined, { rules: custom.rules });
        const people: Record<string, { name?: string; slackId?: string }> = {};
        if (d.cfg.commands.storyInfo) {
          const lower = Object.fromEntries(Object.entries(d.cfg.users).map(([k, v]) => [k.toLowerCase(), v]));
          for (const story of [...new Set([...(job.stories ?? []), ...Object.values(tri.stories), ...(job.story ? [job.story] : [])])].slice(0, 5)) {
            const person = await d.client.storyPerson(story);
            if (person) people[story] = { name: person.name ?? person.email, slackId: lower[(person.email ?? '').toLowerCase()] ?? lower[(person.name ?? '').toLowerCase()] };
          }
        }
        const owners = ownersForTriage(d.cfg.repoDir, tri.findings, tri.stories, d.cfg.users, d.cfg.storyOwners, d.cfg.storyRegex, 5, job.story, people);
        const report: FailureReport = { job, triage: tri, owners, at: new Date().toISOString(), links: jobLinks(job, d.cfg.orgUrl) };
        if (d.cfg.allowCommitMissing) report.commitAction = resolveCommitAction(report, d.cfg);
        report.revalidateAction = resolveRevalidateAction(job, d.cfg);
        if (!d.cfg.allowActions) report.hideRerun = true;
        d.registry.set(report);
        await d.notifier.failure(report);
        reports.push(report);
      } else if (t.to === 'success' && d.cfg.notifyOn.includes('success') && successWanted(d.cfg, t.job)) {
        const s = describeSuccess(t.job, d.cfg);
        const b = await forButtons(t.job, d);
        s.buttons = successButtons(b.job, d.cfg, b.prUrl);
        await d.notifier.success(s);
      } else if (t.to === 'cancelled' && d.cfg.notifyOn.includes('cancelled')) {
        await d.notifier.info(`:no_entry_sign: ${t.job.name} was cancelled (job ${t.job.id})`);
      }
    } catch (e) {
      d.log?.(`[radar] could not process job ${t.job.id}: ${(e as Error).message}`);
    }
  }
  return reports;
}
