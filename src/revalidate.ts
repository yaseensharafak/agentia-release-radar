import { Config, JobSummary, RevalidateAction } from './types';

type JobLike = Pick<JobSummary, 'story' | 'stories' | 'storyIds' | 'promotionId' | 'promotion' | 'dryRun'>;

/** Re-validation is only for jobs that WERE validations (check-only). The command deploys (--deploy), so a real deployment is never re-run this way. */
export const isValidationJob = (j: Pick<JobSummary, 'dryRun'>): boolean => j.dryRun === true;

/** The one story a job is about, if it is unambiguous. */
const singleStory = (j: Pick<JobSummary, 'story' | 'stories'>): string | undefined =>
  j.stories && j.stories.length === 1 ? j.stories[0] : !j.stories?.length ? j.story : undefined;

/** What a re-validation would be about, taken from the job and the config (no guessing between several stories). */
export function revalidateContext(job: JobLike, cfg: Pick<Config, 'storyIds'>): RevalidateAction {
  const story = singleStory(job);
  return {
    story,
    storyId: story ? (job.storyIds?.[story] ?? cfg.storyIds?.[story]) : undefined,
    promotionId: job.promotionId,
    promotion: job.promotion,
  };
}

/** The re-validate action to offer on a card, or undefined (off unless commands.revalidate is set and re-run actions are allowed). */
export function resolveRevalidateAction(job: JobLike, cfg: Pick<Config, 'storyIds' | 'commands' | 'allowActions'>): RevalidateAction | undefined {
  const tpl = cfg.commands.revalidate;
  if (!tpl || !tpl.length || !cfg.allowActions) return undefined;
  if (!isValidationJob(job)) return undefined;
  const ctx = revalidateContext(job, cfg);
  const uses = (p: string): boolean => tpl.some((x) => x.includes(`{${p}}`));
  if (uses('storyId') && !ctx.storyId) return undefined;
  if (uses('story') && !ctx.story) return undefined;
  if (uses('promotionId') && !ctx.promotionId) return undefined;
  return ctx;
}

/** A button label that fits Slack's 75-character limit. */
export const revalidateLabel = (a: RevalidateAction): string =>
  `Re-validate ${a.story ?? (a.promotion ? `promotion ${a.promotion}` : '')}`.trim().slice(0, 75);
