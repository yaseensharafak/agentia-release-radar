import { CommitAction, CommandTemplates, Component, Config, FailureReport, Finding, JobSummary } from './types';

const TYPE_OK = /^[A-Za-z][A-Za-z0-9]*$/;
const NAME_OK = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/;

/** The distinct, plainly-named components whose absence causes failures (custom fields, Apex classes). */
export function metadataTargets(findings: Finding[], max = 50): Component[] {
  const seen = new Set<string>();
  const out: Component[] = [];
  for (const f of findings) {
    const m = f.metadata;
    if (!m || !TYPE_OK.test(m.type) || !NAME_OK.test(m.name)) continue;
    const key = `${m.type}:${m.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: m.type, name: m.name });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Which story should receive the missing components? Only an unambiguous answer is allowed:
 * the one story that owns the failing code (from Copado's own component list), or the job's only story.
 * With several candidate stories we do not guess.
 */
export function commitStory(findings: Finding[], stories: Record<string, string>, job: Pick<JobSummary, 'story' | 'stories'>): string | undefined {
  const owners = new Set<string>();
  for (const f of findings) {
    for (const c of f.affects ?? (f.component ? [f.component] : [])) {
      const base = c.split('/').pop()?.replace(/\.(cls|trigger)$/i, '').split('.')[0] ?? c;
      const s = stories[c] ?? stories[base];
      if (s) owners.add(s.toUpperCase());
    }
  }
  if (owners.size === 1) return [...owners][0];
  if (owners.size > 1) return undefined;
  if (job.stories && job.stories.length === 1) return job.stories[0];
  if (!job.stories?.length && job.story) return job.story;
  return undefined;
}

export function commitActionFor(r: { job: Pick<JobSummary, 'story' | 'stories' | 'storyIds'>; triage: Pick<FailureReport['triage'], 'findings' | 'stories'> }): CommitAction | undefined {
  const components = metadataTargets(r.triage.findings);
  if (!components.length) return undefined;
  const story = commitStory(r.triage.findings, r.triage.stories, r.job);
  const storyId = story ? r.job.storyIds?.[story] : undefined;
  return story ? { story, ...(storyId ? { storyId } : {}), components } : undefined;
}

export const commitMessage = (job: Pick<JobSummary, 'number' | 'id'>): string =>
  `ReleaseRadar: add components missing from the validation (${job.number ?? job.id})`;

/** For display only (dry runs and logs). Never executed through a shell. */
export const showCommand = (argv: string[]): string => `agentia ${argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;

/** Does the commit command need the story's Copado record id? (The default does: names like US-... are rejected as "Invalid id".) */
export const needsStoryId = (cmds: Pick<CommandTemplates, 'commitMissing'>): boolean => cmds.commitMissing.some((x) => x.includes('{storyId}'));

/**
 * The commit action to offer, or undefined. When the command needs a record id we take it from the job data, else from `storyIds`
 * in the config; with neither, no button is offered (a click could only fail).
 */
export function resolveCommitAction(
  r: Parameters<typeof commitActionFor>[0],
  cfg: Pick<Config, 'storyIds' | 'commands'>,
): CommitAction | undefined {
  const a = commitActionFor(r);
  if (!a) return undefined;
  const id = a.storyId ?? cfg.storyIds?.[a.story] ?? cfg.storyIds?.[a.story.toUpperCase()];
  if (needsStoryId(cfg.commands) && !id) return undefined;
  return id ? { ...a, storyId: id } : a;
}
