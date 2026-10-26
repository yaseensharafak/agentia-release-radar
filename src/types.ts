export type JobState = 'running' | 'success' | 'failure' | 'cancelled' | 'unknown';

export interface JobSummary {
  id: string;
  /** Display name, e.g. "SFDX Deploy (validation) · P-8999 [JE-900007]". */
  name: string;
  /** Copado job number such as JE-900007. */
  number?: string;
  /** Job template name, e.g. "SFDX Deploy", "SFDX Promote", "Run PMD". */
  template?: string;
  /** dataJson.action, e.g. PromotionDeployment, Promotion, Test, Commit. */
  action?: string;
  /** Error text Copado puts on a failed job (also present in `job list`). */
  errorMessage?: string;
  /** Result record ids from dataJson (the test/quality-gate details live there). */
  resultIds?: string[];
  /** All story ids on the job (a promotion can carry several). */
  stories?: string[];
  /** story name -> Copado record id, when the job carries both lists (used by the {storyId} placeholder). */
  storyIds?: Record<string, string>;
  /** Destination branch of a deploy/promote job (e.g. the target environment's branch). */
  destination?: string;
  /** true = validation (check-only), false = real deployment, undefined = not a deploy/promote job. */
  dryRun?: boolean;
  isBackPromotion?: boolean;
  promotionId?: string;
  /** ISO timestamps from the job list; used for a rough duration. */
  createdAt?: string;
  finishedAt?: string;
  /** Commit message on a Commit job. */
  commitMessage?: string;
  /** Status string exactly as Copado reports it. */
  status: string;
  state: JobState;
  promotion?: string;
  story?: string;
}

export interface JobStep {
  name: string;
  status: string;
  state: JobState;
  log: string;
}

export interface JobDetail extends JobSummary {
  steps: JobStep[];
  /** Job-level log, if the CLI returns one. */
  log: string;
  /** The raw JSON the CLI returned (structured results are mined from it). */
  raw?: unknown;
}

export type Category =
  | 'apex-compile'
  | 'apex-test'
  | 'coverage'
  | 'missing-dependency'
  | 'permissions'
  | 'validation'
  | 'flow'
  | 'duplicate'
  | 'quality-gate'
  | 'other';

export interface Finding {
  category: Category;
  /** File path, class name, field or flow the problem points at (as found in the log). */
  component?: string;
  line?: number;
  column?: number;
  message: string;
  /** How many errors share this root cause. */
  count?: number;
  /** Components (classes etc.) hit by this root cause. */
  affects?: string[];
  /** The metadata component whose absence causes this finding (e.g. a missing custom field). */
  metadata?: { type: string; name: string };
}

export interface Triage {
  headline: string;
  explanation: string;
  /** One finding per root cause (or per matched pattern). */
  findings: Finding[];
  /** Total individual errors before grouping. */
  errorCount: number;
  /** component -> story id, when the Copado function log was available. */
  stories: Record<string, string>;
  /** Which input formats were recognised (deploy-report, copado-result, copado-function-log, log-text, pattern-rules). */
  kinds: string[];
  /** true when Copado cut the error text short, so counts are a lower bound. */
  truncated?: boolean;
  source: 'rules' | 'ai+rules';
}

export interface Owner {
  name?: string;
  email?: string;
  story?: string;
  commit?: string;
  slackId?: string;
}

export interface FailureReport {
  job: JobSummary;
  triage: Triage;
  /** Heuristic: last committer to each failing component (see README). */
  owners: Array<{ component: string; owner: Owner }>;
  at: string;
  /** Optional "open in Copado" links. */
  links?: Array<{ label: string; url: string }>;
  /** Set when a "commit missing components" action is available for this failure. */
  commitAction?: CommitAction;
  /** Set once someone has asked ReleaseRadar to commit the missing components (prevents double clicks). */
  commitRequested?: { by: string; at: string; dryRun: boolean };
  /** Set when a "re-validate" action is available (commands.revalidate configured). */
  revalidateAction?: RevalidateAction;
  revalidateRequested?: { by: string; at: string; dryRun: boolean };
  /** Set when re-run actions are switched off (allowActions=false), so the card does not show a button that cannot work. */
  hideRerun?: boolean;
}

/** A button that only opens a page (Slack opens the URL itself). */
export interface LinkButton {
  label: string;
  url: string;
  /** Shown in Slack's green "primary" style: the natural next step. */
  primary?: boolean;
}

export interface RevalidateAction {
  story?: string;
  storyId?: string;
  promotionId?: string;
  promotion?: string;
}

export interface Component {
  type: string;
  name: string;
}

export interface CommitAction {
  story: string;
  storyId?: string;
  components: Component[];
}

export interface CommandTemplates {
  jobList: string[];
  jobGet: string[];
  jobRerun: string[];
  aiAsk: string[];
  /**
   * Placeholders: {story} (US-...), {storyId} (record id), {message}, and EITHER {type}+{name} (the command then runs once per
   * component, as `agentia cicd cloud commit` takes one metadata item per call) OR {metadata} (Type:Name,Type:Name) / {metadataJson}.
   */
  commitMissing: string[];
  /** OPTIONAL and off by default. Reads a user story's developer: placeholders {story}. Example: ["cicd","work","list","--json"]. */
  storyInfo?: string[];
  /** Finds a story's Salesforce record id from its name (placeholder {story}); only used to build the Copado link buttons. null/[] turns it off. */
  storyLookup?: string[] | null;
  /**
   * Starts a NEW validation after a commit. Default follows the real `agentia cicd cloud promote --help`: it re-creates the validation
   * promotion's branch from the story's latest commits and runs it again with --deploy (merge_and_deploy). On a VALIDATION promotion that
   * is a check-only deployment; ReleaseRadar therefore only offers it for jobs that were validations. Set to null to disable.
   * Placeholders: {story}, {storyId}, {promotionId}, {message}. Re-running the old failed job would NOT include a new commit.
   */
  revalidate?: string[];
  /** Reads one promotion (placeholder {id}); used only for the optional "Open pull request" link. */
  promotionGet?: string[];
}

export interface Config {
  repoDir: string;
  users: Record<string, string>;
  /** Optional fallback: story name -> Copado record id (a93...), used by the commit action when the job data does not carry it. */
  storyIds: Record<string, string>;
  /** Optional: story id -> Slack member id. Use "*" as a default for every story not listed. */
  storyOwners: Record<string, string>;
  /** Shortcut for storyOwners["*"]: one Slack member id mentioned for every story (e.g. the release manager). */
  defaultOwner?: string;
  /** Optional JSON file with extra pattern rules (see README). */
  rulesFile?: string;
  storyRegex: string;
  commands: CommandTemplates;
  slackWebhookUrl?: string;
  signingSecret?: string;
  allowActions: boolean;
  /** Separate switch for the write action "commit missing components" (off by default). */
  allowCommitMissing: boolean;
  dryRunActions: boolean;
  /** Actions that run LIVE even while dryRunActions is true: any of commit, rerun, revalidate. */
  liveActions: string[];
  /** After a successful live commit, start the re-validation automatically (needs commands.revalidate). */
  autoRevalidate: boolean;
  allowedUsers: string[];
  port: number;
  aiEnabled: boolean;
  notifyOn: Array<'failure' | 'success' | 'cancelled'>;
  /** Which job actions announce SUCCESS (failures are always announced). Default: ["all"]. Or a list: PromotionDeployment, Promotion, Commit, Test. */
  successActions: string[];
  /** Optional friendly names for destination branches. Exact names, or patterns with * (e.g. "qa*"). Not required: the branch name is shown otherwise. */
  destinations: Record<string, string>;
  /** Adds an "Open pull request" link button to cards whose job has a promotion (one extra read-only `promotion get` per card). Off by default. */
  pullRequestLinks: boolean;
  /** Base URL of your Copado org (https only) to add "Open in Copado" links. */
  orgUrl?: string;
}
