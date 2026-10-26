import { safeBase } from './describe';
import { revalidateContext } from './revalidate';
import { Config, JobSummary, LinkButton } from './types';

/**
 * What just happened, in the words a release manager uses. This decides which buttons a card gets.
 *   commit      a "Commit" job (changes were committed to the user story)
 *   validation  a deploy job that is check-only (nothing is deployed)
 *   deployment  a deploy job that really deploys
 *   promotion   the promote (merge) step
 *   quality     a quality-gate / test job (Run PMD, Apex tests ...)
 */
export type EventKind = 'commit' | 'validation' | 'deployment' | 'promotion' | 'quality' | 'other';

export function eventKind(job: Pick<JobSummary, 'action' | 'dryRun'>): EventKind {
  switch (job.action) {
    case 'Commit':
      return 'commit';
    case 'PromotionDeployment':
      return job.dryRun ? 'validation' : 'deployment';
    case 'Promotion':
      return 'promotion';
    case 'Test':
      return 'quality';
    default:
      return 'other';
  }
}

const ID = /^[A-Za-z0-9]{15,18}$/;

/**
 * Link buttons for a SUCCESS card. They only open pages (Copado, the Git provider); ReleaseRadar never starts a
 * promotion or deployment from a button. A button is left out when the link it needs is not known, so no button is a dead end.
 *
 *   commit succeeded      -> Open pull request (the story's own branch), Validate in Copado (the story page, where Validate is)
 *   validation succeeded  -> Open pull request, Promote in Copado   (the promotion page)
 *   deployment succeeded  -> Open pull request, Validate next environment (the story page)
 *   promotion step done   -> Open promotion
 */
export function successButtons(
  job: JobSummary,
  cfg: Pick<Config, 'orgUrl' | 'storyIds'>,
  prUrl?: string,
): LinkButton[] {
  const base = safeBase(cfg.orgUrl);
  const storyId = revalidateContext(job, { storyIds: cfg.storyIds }).storyId;
  const storyUrl = base && storyId && ID.test(storyId) ? `${base}/${storyId}` : undefined;
  const promoUrl = base && job.promotionId && ID.test(job.promotionId) ? `${base}/${job.promotionId}` : undefined;
  const pr: LinkButton | undefined = prUrl ? { label: 'Open pull request ↗', url: prUrl } : undefined;
  const out: Array<LinkButton | undefined> = [];
  switch (eventKind(job)) {
    case 'commit':
      out.push(pr, storyUrl ? { label: 'Validate in Copado ↗', url: storyUrl, primary: true } : undefined);
      break;
    case 'validation':
      out.push(pr, promoUrl ? { label: 'Promote in Copado ↗', url: promoUrl, primary: true } : undefined);
      break;
    case 'deployment':
      out.push(pr, storyUrl ? { label: 'Validate next environment ↗', url: storyUrl, primary: true } : undefined);
      break;
    case 'promotion':
      out.push(promoUrl ? { label: 'Open promotion ↗', url: promoUrl } : undefined);
      break;
    default:
      break;
  }
  return out.filter((b): b is LinkButton => !!b);
}

/** Does this kind of success card benefit from a pull request link? (Saves a lookup for the others.) */
export const wantsPullRequest = (job: Pick<JobSummary, 'action' | 'dryRun'>): boolean => {
  const k = eventKind(job);
  return k === 'validation' || k === 'deployment';
};
