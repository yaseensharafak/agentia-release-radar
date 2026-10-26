import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { redact } from './redact';
import { CommandTemplates, Component, JobDetail, JobState, JobStep, JobSummary } from './types';

/**
 * Every Copado interaction goes through the public `agentia` binary with --json.
 * ALL command strings live in DEFAULT_COMMANDS so they can be corrected in one place
 * (or overridden in radar.config.json) after running `release-radar doctor`.
 */
export const DEFAULT_COMMANDS: CommandTemplates = {
  // VERIFY each against `agentia cicd job --help` and `agentia ai agent --help`.
  jobList: ['cicd', 'job', 'list', '--json'],
  jobGet: ['cicd', 'job', 'get', '{id}', '--json'],
  jobRerun: ['cicd', 'job', 'resume', '{id}', '--json'],
  aiAsk: ['ai', 'agent', 'ask', '--agent', 'operate', '--json', '{prompt}'],
  // From the real `agentia cicd cloud commit --help`, and VERIFIED LIVE: [ID] must be the Copado RECORD ID of the story (a93...),
  // not its name (US-... fails with "Invalid id"). One metadata item per call; --metadata-category SFDX is required (without it
  // Copado skips the deploy: "Salesforce changes not found."). Runs once per component.
  // From the real `agentia cicd cloud promote --help`: [ID] story record id, --promotion-id the (validation) promotion, --recreate-promotion-branch
  // rebuilds the promotion branch from the story's latest commits (needs --yes), --deploy = merge_and_deploy (a CHECK-ONLY deploy on a validation
  // promotion, a REAL deploy otherwise: ReleaseRadar only offers this for jobs that were validations). Not yet run live.
  revalidate: ['cicd', 'cloud', 'promote', '{storyId}', '--promotion-id', '{promotionId}', '--deploy', '--recreate-promotion-branch', '--yes', '--wait', '--json'],
  promotionGet: ['cicd', 'promotion', 'get', '{id}', '--json'],
  storyLookup: ['cicd', 'work', 'status', '{story}', '--json'],
  commitMissing: ['cicd', 'cloud', 'commit', '{storyId}', '--metadata-type', '{type}', '--metadata-name', '{name}', '--metadata-category', 'SFDX', '--message', '{message}', '--wait', '--json'],
};

/** A guess to inspect with `release-radar doctor --story US-...`; NOT used unless you set commands.storyInfo yourself. */
export const SUGGESTED_STORY_INFO = ['cicd', 'work', 'list', '--json'];

export interface StoryPerson {
  name?: string;
  email?: string;
}

const STORY_NAME_KEYS = ['name', 'Name', 'userStoryName', 'storyName', 'number', 'Number'];
const PERSON_KEYS = ['developer', 'Developer', 'developerName', 'owner', 'Owner', 'ownerName', 'assignedTo', 'assignee', 'Assignee'];

export const matchesStory = (rec: unknown, story: string): boolean => STORY_NAME_KEYS.some((k) => pick(rec, [k])?.toUpperCase() === story.toUpperCase());

export function extractPerson(rec: unknown): StoryPerson | undefined {
  if (!isRec(rec)) return undefined;
  for (const k of PERSON_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v) return v.includes('@') ? { email: v } : { name: v };
    if (isRec(v)) {
      const name = pick(v, ['name', 'Name', 'fullName', 'displayName']);
      const email = pick(v, ['email', 'Email', 'username', 'Username']);
      if (name || email) return { name, email };
    }
  }
  return undefined;
}

export type Runner = (argv: string[], opts?: { timeoutMs?: number }) => Promise<string>;

/**
 * Decide how to launch the agentia CLI without a shell.
 * - AGENTIA_JS: full path to the CLI's JS entry (run with node). Always wins.
 * - AGENTIA_BIN: a program, or a .js file (run with node; used by the mock in tests/demo).
 * - Windows: npm installs `agentia.cmd`, which Node cannot spawn safely without a shell, so we read the shim,
 *   find the JS file it launches and run that with node instead.
 */
export function resolveAgentia(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
  read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): { cmd: string; prefix: string[] } {
  if (env.AGENTIA_JS) return { cmd: process.execPath, prefix: [env.AGENTIA_JS] };
  const bin = env.AGENTIA_BIN;
  if (bin) return /\.(c|m)?js$/i.test(bin) ? { cmd: process.execPath, prefix: [bin] } : { cmd: bin, prefix: [] };
  if (platform === 'win32') {
    const P = path.win32;
    for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
      const shim = P.join(dir, 'agentia.cmd');
      if (!exists(shim)) continue;
      const m = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(read(shim));
      const script = m ? P.join(dir, m[1]) : undefined;
      if (script && exists(script)) return { cmd: process.execPath, prefix: [script] };
    }
  }
  return { cmd: 'agentia', prefix: [] };
}

export const defaultRunner: Runner = (argv, opts) =>
  new Promise((resolve, reject) => {
    const { cmd, prefix } = resolveAgentia();
    execFile(
      cmd,
      [...prefix, ...argv],
      { maxBuffer: 32 * 1024 * 1024, timeout: opts?.timeoutMs ?? 120_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          const code = (err as NodeJS.ErrnoException).code;
          const hint =
            code === 'ENOENT' || code === 'EINVAL'
              ? ' (agentia not found or not launchable. Install: npm i -g @copado/agentia-cli@beta. On Windows set AGENTIA_JS to the full path of ...\\@copado\\agentia-cli\\bin\\run.js, see SETUP-GUIDE.md)'
              : '';
          return reject(new Error(redact(`agentia ${argv.slice(0, 3).join(' ')} failed: ${stderr || err.message}`) + hint));
        }
        resolve(stdout);
      },
    );
  });

/**
 * GitHub-style compare page from Copado's openPullRequest block:
 * <base>compare/<destination branch>...<promotion branch>?expand=1. Only plain https URLs and plain branch names are accepted.
 */
export function pullRequestUrlFrom(o: unknown): string | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const { pullRequestBaseUrl: base, destinationEnvironmentBranch: dest, compareBranch: cmp, gitProvider } = o as Record<string, unknown>;
  if (typeof base !== 'string' || typeof dest !== 'string' || typeof cmp !== 'string') return undefined;
  if (typeof gitProvider === 'string' && !/^github$/i.test(gitProvider)) return undefined; // only the GitHub URL shape is known
  if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]*$/.test(base)) return undefined;
  const branch = /^[A-Za-z0-9._\/-]{1,200}$/;
  if (!branch.test(dest) || !branch.test(cmp) || dest.includes('..') || cmp.includes('..')) return undefined;
  return `${base.replace(/\/+$/, '')}/compare/${dest}...${cmp}?expand=1`;
}

export interface StoryDetails {
  id?: string;
  baseBranch?: string;
  /** https://github.com/<org>/<repo>/ as Copado knows it for the story's pipeline. */
  prBaseUrl?: string;
}

const REC_ID = /^[A-Za-z0-9]{15,18}$/;
const norm = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** First string value found under a key whose normalised name is one of `names`, anywhere in the object. */
function deepFind(o: unknown, names: string[], depth = 0): string | undefined {
  if (!o || typeof o !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (typeof v === 'string' && names.includes(norm(k)) && v.trim()) return v.trim();
  for (const v of Object.values(o as Record<string, unknown>)) {
    const r = deepFind(v, names, depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** Story details from the output of `work status` (JSON or text) for the story named `key` (upper case), or undefined. */
export function parseStoryDetails(raw: string, key: string): StoryDetails | undefined {
  const out: StoryDetails = {};
  try {
    const res = parseEnvelope(raw);
    const rec = asList(res).find((x) => matchesStory(x, key)) ?? (res && typeof res === 'object' ? res : undefined);
    const o = (rec ?? {}) as Record<string, unknown>;
    const inner = [o, o.userStory, o.workItem, o.story].find((x): x is Record<string, unknown> => !!x && typeof x === 'object' && REC_ID.test(String((x as Record<string, unknown>).id ?? '')));
    const nm = inner && (inner as Record<string, unknown>).name;
    if (inner && (typeof nm !== 'string' || nm.toUpperCase() === key)) {
      out.id = (inner as { id: string }).id;
      out.baseBranch = deepFind(inner, ['basebranch']);
      out.prBaseUrl = deepFind(inner, ['projectpipelinepullrequestbaseurl', 'pullrequestbaseurl']);
    }
  } catch {
    /* plain text output: handled below */
  }
  if (!out.id) {
    const name = /^Name:\s*(\S+)\s*$/m.exec(raw)?.[1];
    const id = /^ID:\s*([A-Za-z0-9]{15,18})\s*$/m.exec(raw)?.[1];
    if (name && id && name.toUpperCase() === key) {
      out.id = id;
      out.baseBranch = /^Base Branch:\s*(\S+)\s*$/m.exec(raw)?.[1];
      out.prBaseUrl = /^Project Pipeline Pull Request Base URL:\s*(https:\/\/\S+)\s*$/m.exec(raw)?.[1];
    }
  }
  return out.id ? out : undefined;
}

/**
 * The pull request page for a story's own branch (Copado names it feature/<story>): <repo>/compare/<base>...feature/<story>?expand=1.
 * GitHub on github.com only; anything odd gives no link.
 */
export function featureBranchPullRequestUrl(prBaseUrl: string | undefined, baseBranch: string | undefined, story: string | undefined): string | undefined {
  if (!prBaseUrl || !baseBranch || !story) return undefined;
  if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/?$/.test(prBaseUrl)) return undefined;
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(baseBranch) || baseBranch.includes('..') || !/^[A-Za-z0-9_-]{3,40}$/.test(story)) return undefined;
  return `${prBaseUrl.replace(/\/+$/, '')}/compare/${baseBranch}...feature/${story}?expand=1`;
}

/** Fill {placeholders}. Arguments are passed as an argv array, never through a shell. */
export const fill = (tpl: string[], vars: Record<string, string>): string[] =>
  tpl.map((a) => a.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? ''));

/**
 * The CLI prints `{result, status, transactionId}`. A linked plugin may print a warning line first,
 * so parse from the first JSON bracket.
 */
export function parseEnvelope(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error('No JSON found in agentia output');
  const env = JSON.parse(stdout.slice(start)) as { result?: unknown; status?: unknown; message?: unknown; error?: unknown };
  // A bare job record also has a `status` ("Error" = the JOB failed). Only a non-record is an error envelope.
  const isRecord = env && typeof env === 'object' && ('id' in env || 'Id' in env || 'steps' in env);
  if (env && typeof env === 'object' && !isRecord) {
    // The CLI reports failures as {"error": {"message": ..., "code": ...}} (no `result`). Never treat that as success.
    const err = env.error;
    if (err && !('result' in env) && (typeof err === 'string' || typeof err === 'object')) {
      let msg = typeof err === 'string' ? err : String((err as { message?: unknown }).message ?? JSON.stringify(err));
      if (typeof err === 'object') {
        // Copado puts the useful part in a code such as "PRO-056" and the HTTP status; keep them visible.
        const o = err as { categories?: unknown; statusCode?: unknown };
        const tags = [...(Array.isArray(o.categories) ? o.categories.filter((c): c is string => typeof c === 'string') : []), ...(typeof o.statusCode === 'number' ? [`HTTP ${o.statusCode}`] : [])];
        if (tags.length) msg = `${msg.slice(0, 300)} [${tags.join(', ')}]`;
      }
      throw new Error(redact(`agentia error: ${msg}`).slice(0, 400));
    }
    if (typeof env.status === 'string' && /^(error|fail)/i.test(env.status)) {
      throw new Error(redact(`agentia reported ${env.status}${env.message ? `: ${String(env.message)}` : ''}`).slice(0, 400));
    }
  }
  return env && typeof env === 'object' && 'result' in env ? env.result : env;
}

/** List answers come back as result.data (paged) or as a bare array. */
export function asList(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    for (const k of ['data', 'records', 'items', 'jobs', 'executions']) if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

export function pick(o: unknown, keys: string[]): string | undefined {
  if (!isRec(o)) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

export function classify(status: string | undefined): JobState {
  if (!status) return 'unknown';
  if (/^(success|succeeded|completed?|done|passed)/i.test(status)) return 'success';
  if (/^(error|fail|failed|failure)/i.test(status)) return 'failure';
  if (/^(cancel|abort)/i.test(status)) return 'cancelled';
  if (/(progress|running|pending|queued|started|executing|waiting)/i.test(status)) return 'running';
  return 'unknown';
}

const ID = ['id', 'Id', 'jobExecutionId', 'executionId', 'uuid'];
const NAME = ['name', 'Name', 'jobName', 'title', 'functionName', 'type'];
const STATUS = ['status', 'Status', 'state', 'executionStatus', 'jobStatus'];

const stripHtml = (s: string): string =>
  s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

/** `dataJson` is a JSON string in `job list` and may be an object (or pretty string) elsewhere. */
function parseData(v: unknown): Rec {
  if (isRec(v)) return v;
  if (typeof v === 'string') {
    try {
      const x = JSON.parse(v) as unknown;
      return isRec(x) ? x : {};
    } catch {
      return {};
    }
  }
  return {};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function normalizeJob(raw: unknown): JobSummary | undefined {
  const id = pick(raw, ID);
  if (!id) return undefined;
  const o: Rec = isRec(raw) ? raw : {};
  const status = pick(raw, STATUS) ?? 'Unknown';
  const data = parseData(o.dataJson);
  const template = isRec(o.template) ? pick(o.template, ['name', 'Name']) : undefined;
  const number = pick(raw, ['name', 'Name']);
  const context = str(o.context) ? stripHtml(o.context as string) : undefined;
  const branches = Array.isArray(data.userStoryBranches) ? (data.userStoryBranches as unknown[]) : [];
  const promotion =
    pick(raw, ['promotionName']) ??
    str(data.promotionBranchName)?.replace(/^promotion\//, '') ??
    /Promotion:\s*(\S+)/i.exec(context ?? '')?.[1] ??
    pick(raw, ['promotionId', 'promotion']);
  const story =
    pick(raw, ['userStoryName', 'storyName', 'userStory', 'story']) ??
    str(data.userStoryName) ??
    branches.map((b) => /US-\d+/i.exec(String(b))?.[0]).find(Boolean)?.toUpperCase();
  const dry = data.deploymentDryRun === true;
  const display = template
    ? `${template}${dry ? ' (validation)' : ''}${promotion ? ` · ${promotion}` : ''}${number ? ` [${number}]` : ''}`
    : (promotion || data.action) && /^JE-\d+$/i.test(number ?? '')
      ? `${str(data.action) ?? 'Job'}${dry ? ' (validation)' : ''}${promotion ? ` · ${promotion}` : ''}${number ? ` [${number}]` : ''}`
      : (pick(raw, NAME) ?? `Job ${id}`);
  return {
    id,
    name: display,
    number,
    template,
    action: str(data.action),
    errorMessage: str(o.errorMessage),
    stories: [...new Set(branches.map((b) => /US-\d+/i.exec(String(b))?.[0]?.toUpperCase()).filter((x): x is string => !!x))],
    storyIds: (() => {
      const ids = Array.isArray(data.userStoryIds) ? (data.userStoryIds as unknown[]) : [];
      const names = branches.map((b) => /US-\d+/i.exec(String(b))?.[0]?.toUpperCase());
      const out: Record<string, string> = {};
      if (ids.length === names.length) names.forEach((n, i) => { if (n && typeof ids[i] === 'string') out[n] = ids[i] as string; });
      return Object.keys(out).length ? out : undefined;
    })(),
    destination: str(data.destinationBranchName),
    dryRun: typeof data.deploymentDryRun === 'boolean' ? data.deploymentDryRun : undefined,
    isBackPromotion: data.isBackPromotion === true ? true : undefined,
    promotionId: str(data.promotionId),
    createdAt: str(o.createdDate),
    finishedAt: str(o.lastModifiedDate),
    commitMessage: str(data.message),
    resultIds: [...(Array.isArray(data.resultIds) ? (data.resultIds as unknown[]) : []), data.resultId].filter((x): x is string => typeof x === 'string' && !!x),
    status,
    state: classify(status),
    promotion,
    story,
  };
}

const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(text).join('\n');
  if (isRec(v)) return pick(v, ['message', 'text', 'log', 'output']) ?? '';
  return '';
};

export function normalizeDetail(raw: unknown, fallback?: JobSummary): JobDetail | undefined {
  const base = normalizeJob(raw) ?? fallback;
  if (!base) return undefined;
  const o = isRec(raw) ? raw : {};
  const stepsRaw = ['steps', 'jobSteps', 'stepExecutions'].map((k) => o[k]).find(Array.isArray) as unknown[] | undefined;
  const steps: JobStep[] = (stepsRaw ?? []).map((s, i) => {
    const status = pick(s, STATUS) ?? 'Unknown';
    const r = isRec(s) ? s : {};
    return {
      name: pick(s, ['name', 'Name', 'stepName', 'label']) ?? `Step ${i + 1}`,
      status,
      state: classify(status),
      log: text(r.log ?? r.logs ?? r.output ?? r.message ?? r.result ?? r.errorMessage),
    };
  });
  return { ...base, steps, log: text(o.log ?? o.logs ?? o.output ?? o.errorMessage) || base.errorMessage || '', raw };
}

export class AgentiaClient {
  constructor(
    private run: Runner,
    private cmds: CommandTemplates,
  ) {}

  async listJobs(): Promise<{ jobs: JobSummary[]; rawCount: number }> {
    const raw = asList(parseEnvelope(await this.run(this.cmds.jobList)));
    return { jobs: raw.map(normalizeJob).filter((j): j is JobSummary => !!j), rawCount: raw.length };
  }

  async getJob(id: string, fallback?: JobSummary): Promise<JobDetail> {
    const res = parseEnvelope(await this.run(fill(this.cmds.jobGet, { id })));
    const d = normalizeDetail(res, fallback);
    if (!d) throw new Error(`Could not read job ${id}: unrecognised JSON shape (use: release-radar doctor --debug-raw)`);
    return d;
  }

  /**
   * The "open a pull request" page for a promotion's branch, from `agentia cicd promotion get <id> --json`
   * (result.openPullRequest). Read-only; any problem means "no link", never an error.
   */
  async pullRequestUrl(promotionId: string | undefined): Promise<string | undefined> {
    const tpl = this.cmds.promotionGet;
    if (!tpl?.length || !promotionId || !/^[A-Za-z0-9]{15,18}$/.test(promotionId)) return undefined;
    try {
      const res = parseEnvelope(await this.run(fill(tpl, { id: promotionId }))) as { openPullRequest?: unknown } | undefined;
      return pullRequestUrlFrom(res?.openPullRequest);
    } catch {
      return undefined;
    }
  }

  async rerun(id: string): Promise<string> {
    const res = parseEnvelope(await this.run(fill(this.cmds.jobRerun, { id })));
    return typeof res === 'string' ? res : JSON.stringify(res).slice(0, 500);
  }

  /**
   * The argv list a "commit missing components" run would execute (also shown in dry runs). Validates everything first.
   * A template with {type}/{name} runs once per component; otherwise it is a single call using {metadata}/{metadataJson}.
   */
  commitCommands(story: string, components: Component[], message: string, storyId?: string): string[][] {
    if (!/^US-\d{3,}$/i.test(story)) throw new Error(`Refusing to commit: "${story}" is not a user story id`);
    if (!components.length) throw new Error('Nothing to commit');
    if (components.length > 50) throw new Error('Refusing to commit more than 50 components at once');
    for (const c of components) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(c.type) || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/.test(c.name)) {
        throw new Error(`Refusing to commit: "${c.type}:${c.name}" is not a plain metadata component name`);
      }
    }
    const tpl = this.cmds.commitMissing;
    const uses = (p: string): boolean => tpl.some((x) => x.includes(`{${p}}`));
    if (uses('storyId') && !(storyId && /^[A-Za-z0-9]{15,18}$/.test(storyId))) {
      throw new Error('This command needs the story\'s Copado record id, which this failure does not carry. Find it with: SELECT Id FROM copado__User_Story__c WHERE Name = \'' + story.toUpperCase() + '\' and add it to storyIds in radar.config.json');
    }
    const base = {
      story: story.toUpperCase(),
      storyId: storyId ?? '',
      message: message.replace(/[\r\n]+/g, ' ').slice(0, 200),
    };
    if (uses('type') || uses('name')) {
      return components.map((c) => fill(tpl, { ...base, type: c.type, name: c.name }));
    }
    return [
      fill(tpl, {
        ...base,
        metadata: components.map((c) => `${c.type}:${c.name}`).join(','),
        metadataJson: JSON.stringify(components.map((c) => ({ t: c.type, n: c.name, a: 'Add', c: 'SFDX' }))),
      }),
    ];
  }

  /** Ask Copado (through the Agentia CLI) to commit the components into the story, one call at a time. Each call can take minutes. */
  async commitMissing(story: string, components: Component[], message: string, storyId?: string): Promise<string> {
    const cmds = this.commitCommands(story, components, message, storyId);
    const done: string[] = [];
    for (let i = 0; i < cmds.length; i++) {
      try {
        const res = parseEnvelope(await this.run(cmds[i], { timeoutMs: 15 * 60_000 }));
        done.push(redact(typeof res === 'string' ? res : JSON.stringify(res)).slice(0, 200));
      } catch (e) {
        throw new Error(redact(`${done.length} of ${cmds.length} commit call(s) succeeded before this failed: ${(e as Error).message}`));
      }
    }
    return done.join('\n');
  }

  /** The argv a re-validation would run, or an error saying what is missing. */
  revalidateCommand(ctx: { story?: string; storyId?: string; promotionId?: string; message?: string }): string[] {
    const tpl = this.cmds.revalidate;
    if (!tpl || !tpl.length) throw new Error('commands.revalidate is disabled or not configured. Read `agentia cicd cloud promote --help` (release-radar cli-help cicd cloud promote); see README, "Re-run vs re-validate".');
    const uses = (p: string): boolean => tpl.some((x) => x.includes(`{${p}}`));
    const ID = /^[A-Za-z0-9]{15,18}$/;
    if (uses('storyId') && !(ctx.storyId && ID.test(ctx.storyId))) throw new Error("This command needs the story's Copado record id, which is not available for this failure (see storyIds in the config).");
    if (uses('promotionId') && !(ctx.promotionId && ID.test(ctx.promotionId))) throw new Error('This command needs the promotion record id, which is not available for this failure.');
    if (uses('story') && !/^US-\d{3,}$/i.test(ctx.story ?? '')) throw new Error('This command needs a single user story id (US-...), which is not available for this failure.');
    return fill(tpl, {
      story: (ctx.story ?? '').toUpperCase(),
      storyId: ctx.storyId ?? '',
      promotionId: ctx.promotionId ?? '',
      message: (ctx.message ?? 'ReleaseRadar re-validation').replace(/[\r\n]+/g, ' ').slice(0, 200),
    });
  }

  /** Start a new validation. Errors (including {"error": ...} replies) are thrown, never reported as success. */
  async revalidate(ctx: { story?: string; storyId?: string; promotionId?: string; message?: string }): Promise<string> {
    const argv = this.revalidateCommand(ctx);
    const res = parseEnvelope(await this.run(argv, { timeoutMs: 20 * 60_000 })); // Copado's own --wait-timeout is 15 minutes
    return redact(typeof res === 'string' ? res : JSON.stringify(res)).slice(0, 300);
  }

  /**
   * What `agentia cicd work status <US-...>` says about a story, read-only and cached per story:
   * its Salesforce record id (a93...), its base branch, and the repository's pull request base URL.
   * Reads the JSON form or the plain text ("ID: a93...", "Base Branch: main"). A different story's data is never accepted.
   * Any problem means "unknown", never an error.
   */
  private storyDetailsCache = new Map<string, StoryDetails | null>();
  async storyDetails(story: string): Promise<StoryDetails | undefined> {
    const tpl = this.cmds.storyLookup;
    if (!tpl?.length || !/^[A-Za-z0-9_-]{3,40}$/.test(story)) return undefined;
    const key = story.toUpperCase();
    if (this.storyDetailsCache.has(key)) return this.storyDetailsCache.get(key) ?? undefined;
    let found: StoryDetails | undefined;
    try {
      found = parseStoryDetails(await this.run(fill(tpl, { story })), key);
    } catch {
      found = undefined;
    }
    this.storyDetailsCache.set(key, found ?? null);
    return found;
  }

  /** Just the record id of a story (see storyDetails). */
  async storyRecordId(story: string): Promise<string | undefined> {
    return (await this.storyDetails(story))?.id;
  }

  /** Developer of a story, if commands.storyInfo is configured. Cached; any failure just means "unknown". */
  private people = new Map<string, StoryPerson | null>();
  async storyPerson(story: string): Promise<StoryPerson | undefined> {
    const tpl = this.cmds.storyInfo;
    if (!tpl || !/^US-\d+$/i.test(story)) return undefined;
    const key = story.toUpperCase();
    if (this.people.has(key)) return this.people.get(key) ?? undefined;
    let person: StoryPerson | undefined;
    try {
      const res = parseEnvelope(await this.run(fill(tpl, { story: key })));
      const rec = asList(res).find((x) => matchesStory(x, key)) ?? (matchesStory(res, key) ? res : undefined);
      person = extractPerson(rec);
    } catch {
      person = undefined;
    }
    this.people.set(key, person ?? null);
    return person;
  }

  /** Ask the Agentia AI agent. Returns undefined on any failure: AI is an enhancement, never a dependency. */
  async ask(prompt: string): Promise<string | undefined> {
    try {
      const res = parseEnvelope(await this.run(fill(this.cmds.aiAsk, { prompt }), { timeoutMs: 90_000 }));
      const ans = typeof res === 'string' ? res : pick(res, ['answer', 'response', 'text', 'message', 'content', 'output']);
      return ans?.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}