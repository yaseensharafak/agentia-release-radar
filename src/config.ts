import * as fs from 'fs';
import { DEFAULT_COMMANDS } from './agentia';
import { Config } from './types';

export const DEFAULTS: Config = {
  repoDir: '.',
  users: {},
  storyOwners: {},
  storyIds: {},
  storyRegex: '\\bUS-\\d{3,}\\b',
  commands: DEFAULT_COMMANDS,
  allowActions: false,
  allowCommitMissing: false,
  dryRunActions: true,
  liveActions: [],
  autoRevalidate: false,
  allowedUsers: [],
  port: 3000,
  aiEnabled: false,
  notifyOn: ['failure', 'success'],
  successActions: ['all'],
  destinations: {},
  pullRequestLinks: false,
};

/** Environment values pasted into cmd/PowerShell often carry stray quotes or spaces. */
const clean = (s: string | undefined): string | undefined => s?.trim().replace(/^["']+|["']+$/g, '').trim() || undefined;

/** Secrets come from the environment only, never from the config file. */
export function loadConfig(file?: string, env: NodeJS.ProcessEnv = process.env): Config {
  let fromFile: Partial<Config> = {};
  const path = file ?? (fs.existsSync('radar.config.json') ? 'radar.config.json' : undefined);
  if (path) {
    const raw = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''); // some editors save a hidden byte-order mark
    try {
      fromFile = JSON.parse(raw) as Partial<Config>;
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${(e as Error).message}. Common causes: a trailing comma, comments, curly quotes instead of straight ", or an unclosed { [.`);
    }
  }
  const rulesDefault = fs.existsSync('triage-rules.json') ? 'triage-rules.json' : undefined;
  const cfg: Config = {
    ...DEFAULTS,
    ...fromFile,
    rulesFile: fromFile.rulesFile ?? rulesDefault,
    commands: { ...DEFAULT_COMMANDS, ...(fromFile.commands ?? {}) },
    slackWebhookUrl: clean(env.SLACK_WEBHOOK_URL),
    signingSecret: clean(env.SLACK_SIGNING_SECRET),
  };
  if (clean(env.RADAR_ORG_URL)) cfg.orgUrl = clean(env.RADAR_ORG_URL);
  if (cfg.defaultOwner) cfg.storyOwners = { '*': cfg.defaultOwner, ...cfg.storyOwners };
  if (env.RADAR_ALLOW_ACTIONS === '1') cfg.allowActions = true;
  if (env.RADAR_ALLOW_COMMIT === '1') cfg.allowCommitMissing = true;
  if (clean(env.RADAR_LIVE_ACTIONS)) cfg.liveActions = (clean(env.RADAR_LIVE_ACTIONS) as string).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (env.RADAR_PR_LINKS === '1') cfg.pullRequestLinks = true;
  if (env.RADAR_DRY_RUN_ACTIONS === '0') cfg.dryRunActions = false;
  return cfg;
}
