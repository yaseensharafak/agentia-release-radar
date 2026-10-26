import { execFileSync } from 'child_process';
import { Finding, Owner } from './types';

/** Component text comes from logs, so only accept plain path/name characters. */
const SAFE = /^[\w.\-/\\]+$/;

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

/**
 * Find the tracked file for a component named in a log:
 * a path, "Foo.cls", a bare class/flow name "Foo", or "Object__c.Field__c".
 */
export function resolvePath(repoDir: string, component: string): string | undefined {
  if (!SAFE.test(component)) return undefined;
  const name = component.replace(/\\/g, '/');
  const base = name.split('/').pop() as string;
  const candidates: string[] = [name];

  const objField = /^(\w+)\.(\w+__[cr])$/.exec(base);
  if (objField) {
    candidates.push(`:(glob)**/${objField[1]}/fields/${objField[2]}.field-meta.xml`, `:(glob)**/${objField[2]}.field-meta.xml`);
  } else if (/\.[A-Za-z-]+$/.test(base)) {
    candidates.push(`:(glob)**/${base}`);
  } else {
    candidates.push(`:(glob)**/${base}.cls`, `:(glob)**/${base}.trigger`, `:(glob)**/${base}.*-meta.xml`);
  }
  for (const c of candidates) {
    const hit = git(repoDir, ['ls-files', '--', c]).split('\n').filter(Boolean)[0];
    if (hit) return hit;
  }
  return undefined;
}

/** Heuristic: the last committer to the component's file, plus any story id found in that commit message. */
export function ownerOf(
  repoDir: string,
  component: string,
  users: Record<string, string>,
  storyRegex: string,
): Owner | undefined {
  const path = resolvePath(repoDir, component);
  if (!path) return undefined;
  const out = git(repoDir, ['log', '-1', '--format=%h%x1f%an%x1f%ae%x1f%s%x1f%b', '--', path]);
  if (!out) return undefined;
  const [commit, name, email, subject, body] = out.split('\x1f');
  const story = new RegExp(storyRegex, 'i').exec(`${subject}\n${body ?? ''}`)?.[0]?.toUpperCase();
  const lower = Object.fromEntries(Object.entries(users).map(([k, v]) => [k.toLowerCase(), v]));
  return { commit, name, email, story, slackId: lower[(email ?? '').toLowerCase()] ?? lower[(name ?? '').toLowerCase()] };
}

/** One owner per distinct component named in the findings (capped). */
export function ownersFor(
  repoDir: string,
  findings: Finding[],
  users: Record<string, string>,
  storyRegex: string,
  max = 5,
): Array<{ component: string; owner: Owner }> {
  const out: Array<{ component: string; owner: Owner }> = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f.component || seen.has(f.component) || out.length >= max) continue;
    seen.add(f.component);
    // "TestClass.testMethod" -> look up the class
    const lookup = f.category === 'apex-test' ? f.component.split('.')[0] : f.component;
    const owner = ownerOf(repoDir, lookup, users, storyRegex);
    if (owner) out.push({ component: f.component, owner });
  }
  return out;
}

/**
 * Owners for a failure. The story comes from Copado's own component list when available (authoritative),
 * and the person from git history when a repo clone is configured. Components that share an owner are merged.
 */
export function ownersForTriage(
  repoDir: string,
  findings: Finding[],
  stories: Record<string, string>,
  users: Record<string, string>,
  storyOwners: Record<string, string>,
  storyRegex: string,
  max = 5,
  fallbackStory?: string,
  /** Developers found through Copado (optional): story -> name and/or Slack id. */
  people: Record<string, { name?: string; slackId?: string }> = {},
): Array<{ component: string; owner: Owner }> {
  // Who to mention for a story: an explicit entry, else the developer found automatically, else the default ("*").
  const mention = (story?: string): string | undefined => (story ? (storyOwners[story] ?? people[story]?.slackId) : undefined) ?? storyOwners['*'];
  const personName = (story?: string): string | undefined => (story ? people[story]?.name : undefined);
  const comps: string[] = [];
  for (const f of findings) {
    const list = f.affects?.length ? f.affects : f.component ? [f.component] : [];
    for (const c of list) {
      // "TestClass.testMethod" -> the class. Keep paths, "Foo.cls" and "Object__c.Field__c" as they are.
      const parts = c.split('.');
      const isClassMethod = !c.includes('/') && parts.length === 2 && !/__[cr]$/.test(parts[1]) && !/^(cls|trigger|xml|js|html|cmp)$/i.test(parts[1]);
      const name = isClassMethod ? parts[0] : c;
      if (name && !comps.includes(name) && comps.length < 40) comps.push(name);
    }
  }
  const groups = new Map<string, { names: string[]; owner: Owner }>();
  for (const c of comps) {
    const base = c.split('/').pop()?.replace(/\.cls$|\.trigger$/i, '') ?? c;
    const story = stories[c] ?? stories[base] ?? fallbackStory;
    const git = ownerOf(repoDir, c, users, storyRegex);
    if (!story && !git) continue;
    const owner: Owner = { ...git, story: story ?? git?.story, name: git?.name ?? personName(story ?? git?.story), slackId: git?.slackId ?? mention(story ?? git?.story) };
    const key = `${owner.story ?? ''}|${git?.email ?? git?.name ?? ''}`;
    const g = groups.get(key);
    if (g) g.names.push(base);
    else groups.set(key, { names: [base], owner });
  }
  // No component to look up (e.g. a quality-gate failure): the job's own story is still a valid owner handle.
  if (!groups.size && fallbackStory) {
    return [{ component: 'this job', owner: { story: fallbackStory, name: personName(fallbackStory), slackId: mention(fallbackStory) } }];
  }
  return [...groups.values()].slice(0, max).map((g) => ({
    component: g.names.length > 3 ? `${g.names.slice(0, 3).join(', ')} +${g.names.length - 3} more` : g.names.join(', '),
    owner: g.owner,
  }));
}
