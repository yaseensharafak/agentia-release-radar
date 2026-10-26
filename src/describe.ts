import { Config, JobSummary, LinkButton } from './types';

/** A success worth telling people about, in plain words. */
export interface Success {
  job: JobSummary;
  emoji: string;
  title: string;
  detail: string;
  /** Small print: promotion, job number, rough duration. */
  meta: string;
  links: Array<{ label: string; url: string }>;
  /** Next-step link buttons for this event (see buttons.ts). */
  buttons?: LinkButton[];
}

const list = (xs: string[], max = 3): string => (xs.length > max ? `${xs.slice(0, max).join(', ')} +${xs.length - max} more` : xs.join(', '));

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Rough duration from the job list's created/modified timestamps (modified can be slightly after the end). */
export function duration(job: JobSummary): string | undefined {
  const a = Date.parse(job.createdAt ?? '');
  const b = Date.parse(job.finishedAt ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? `~${formatDuration(b - a)}` : undefined;
}

/** Friendly destination name: exact match, case-insensitive match, then * patterns; otherwise the branch name itself (always works, no config). */
export function destinationName(branch: string | undefined, map: Record<string, string> | undefined): string | undefined {
  if (!branch) return undefined;
  const m = map ?? {};
  if (m[branch]) return m[branch];
  const lower = branch.toLowerCase();
  for (const [k, v] of Object.entries(m)) if (k.toLowerCase() === lower) return v;
  for (const [k, v] of Object.entries(m)) {
    if (!k.includes('*')) continue;
    const re = new RegExp(`^${k.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    if (re.test(branch)) return v;
  }
  return branch;
}

/** Only https links, and nothing that could break Slack's `<url|label>` syntax. */
export function safeBase(orgUrl: string | undefined): string | undefined {
  if (!orgUrl) return undefined;
  try {
    const u = new URL(orgUrl);
    return u.protocol === 'https:' && !/[\s<>|]/.test(orgUrl) ? orgUrl.replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

export function jobLinks(job: JobSummary, orgUrl: string | undefined): Array<{ label: string; url: string }> {
  const base = safeBase(orgUrl);
  if (!base) return [];
  const out: Array<{ label: string; url: string }> = [];
  const idOk = (id?: string): id is string => !!id && /^[A-Za-z0-9]{15,18}$/.test(id);
  if (idOk(job.promotionId)) out.push({ label: `Open promotion${job.promotion ? ` ${job.promotion}` : ''}`, url: `${base}/${job.promotionId}` });
  if (idOk(job.id)) out.push({ label: 'Open job', url: `${base}/${job.id}` });
  return out;
}

/**
 * Plain-language wording per kind of job:
 *   deploy (validation)  -> "Validation succeeded"        deploy (real) -> "Deployment succeeded: <story> successfully deployed to <env>"
 *   promote              -> "Promotion step completed"    commit        -> "Commit succeeded"
 *   test / PMD           -> "Quality check passed"        anything else -> "<job> succeeded"
 */
export function describeSuccess(job: JobSummary, cfg: Pick<Config, 'destinations' | 'orgUrl'>): Success {
  const dest = destinationName(job.destination, cfg.destinations);
  const stories = job.stories?.length ? list(job.stories) : job.story;
  const promo = job.promotion ? `promotion ${job.promotion}` : 'the promotion';
  const to = dest ? ` to ${dest}` : '';
  let emoji = ':white_check_mark:';
  let title: string;
  let detail: string;

  switch (job.action) {
    case 'PromotionDeployment':
      if (job.dryRun) {
        title = 'Validation succeeded';
        detail = `${stories ?? promo} validated${dest ? ` against ${dest}` : ''}. Nothing was deployed.`;
      } else {
        emoji = ':rocket:';
        title = 'Deployment succeeded';
        detail = `${stories ? `${stories} successfully deployed` : `${promo[0].toUpperCase()}${promo.slice(1)} successfully deployed`}${to}.`;
      }
      break;
    case 'Promotion':
      title = job.isBackPromotion ? 'Back-promotion step completed' : 'Promotion step completed';
      detail = `${stories ? `${stories}: ` : ''}${promo[0].toUpperCase()}${promo.slice(1)}${dest ? ` is ready for ${dest}` : ' completed'}${job.dryRun ? ' (validation run)' : ''}.`;
      break;
    case 'Commit':
      title = 'Commit succeeded';
      detail = job.commitMessage ? job.commitMessage.replace(/\s+/g, ' ').slice(0, 140) : (stories ?? 'Changes committed');
      break;
    case 'Test':
      title = `Quality check passed: ${job.template ?? 'tests'}`;
      detail = stories ?? 'All criteria met.';
      break;
    default:
      title = `${job.template ?? job.name} succeeded`;
      detail = [stories, job.promotion ? `promotion ${job.promotion}` : undefined].filter(Boolean).join(' · ');
  }

  const ref = job.number && /^JE-\d+$/i.test(job.number) ? job.number : `job ${job.id}`;
  const meta = [job.promotion ? `Promotion ${job.promotion}` : undefined, ref, duration(job)]
    .filter(Boolean)
    .join(' · ');
  return { job, emoji, title, detail, meta, links: jobLinks(job, cfg.orgUrl) };
}
