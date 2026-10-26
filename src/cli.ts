#!/usr/bin/env node
import * as fs from 'fs';
import { parseArgs } from 'util';
import { ActionDeps } from './actions';
import { AgentiaClient, Runner, SUGGESTED_STORY_INFO, asList, defaultRunner, extractPerson, fill, matchesStory, normalizeJob, parseEnvelope } from './agentia';
import { loadConfig } from './config';
import { CollectNotifier, ConsoleNotifier, Notifier, SlackNotifier } from './notify';
import { handleTransitions } from './pipeline';
import { JobTracker } from './poller';
import { commitMessage, resolveCommitAction, showCommand } from './commit';
import { isValidationJob, revalidateContext } from './revalidate';
import { ownersForTriage } from './owners';
import { Registry } from './registry';
import { sampleCards } from './sample';
import { createServer } from './server';
import { postJson } from './slack';
import { analyze, loadCustomRules, triage } from './triage';
import { Config } from './types';

const HELP = `release-radar: Copado pipeline events and failure triage in Slack, headless.

Usage: release-radar <command> [options]

Commands
  doctor   Check your Agentia CLI commands, JSON shapes, Slack and repo setup (run this first)
  triage <file|folder>...  Analyse saved failure evidence: the Result record's ValidationResult.json, ResultViewer.json,
                         function log text, or the output of: agentia cicd job get <id> --json. Several files at once are fine.
  once     Poll once. Add --include-existing to report jobs that are already failed.
  watch    Poll continuously (--interval seconds, default 20)
  serve    Run only the Slack interactivity endpoint (POST /slack/actions).
           serve --sample also posts one sample card for every event (commit/validation/deployment, success and failure; invented data, actions forced to dry run)
  revalidate --job <id> [--run]   Start a NEW validation for the job's story/promotion (the right step after a commit; needs commands.revalidate). Dry run unless --run.
  rerun --job <id> [--run]   Resume the outstanding steps of the same job (agentia cicd job resume). Dry run unless --run.
  cli-help <words>   Print the --help of an agentia command, e.g.  cli-help cicd cloud promote  (to set commands.revalidate)
  commit-missing --job <id> [--run]   Plan (or, with --run, perform) a Copado cloud commit of the components a failed
                         validation says are missing, into the story that owns them. Dry run unless --run.

Options
  --config <file>        Config file (default ./radar.config.json if present)
  --notifier <slack|console|json>   Default: slack when SLACK_WEBHOOK_URL is set, else console.
                         json (with once) prints structured results on stdout for agents
  --interval <seconds>   Poll interval for watch (default 20)
  --max-polls <n>        Stop watch after n polls (demos and tests)
  --include-existing     Treat jobs already present at start as new events
  --ai                   Ask the Agentia AI agent for the plain-English summary
  --serve                With watch: also run the Slack interactivity endpoint
  --debug-raw            doctor: print the raw first job JSON
  --show                 triage: also print which formats were recognised and the free text the pattern rules scanned
  --rules <file>         triage: extra pattern rules (JSON), default ./triage-rules.json
  --job <id>             doctor / commit-missing: job id
  --run                  commit-missing / revalidate: actually run it (default is a dry run)
  --revalidate           commit-missing: after a successful commit, start a new validation (needs commands.revalidate)
  --story <US-id>        doctor: show what Copado returns for a story's developer (optional auto-mention)
  --commit-help          doctor: print the output of: agentia cicd cloud commit --help (to set commands.commitMissing)
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function makeNotifier(kind: string | undefined, cfg: Config, log?: (s: string) => void): Notifier {
  if (kind === 'slack' || (!kind && cfg.slackWebhookUrl)) {
    if (!cfg.slackWebhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set in this window. cmd: set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   PowerShell: $env:SLACK_WEBHOOK_URL = \'https://hooks.slack.com/services/...\'');
    if (!/^https:\/\/hooks\.slack\.com\//.test(cfg.slackWebhookUrl)) {
      throw new Error('SLACK_WEBHOOK_URL does not look like a Slack webhook URL (it must start with https://hooks.slack.com/). Check for a typo or the wrong value.');
    }
    return new SlackNotifier(cfg.slackWebhookUrl);
  }
  if (!kind) {
    log?.('[radar] NOTE: SLACK_WEBHOOK_URL is not set in this window, so cards are printed here and NOT sent to Slack. ' +
      'Set it in THIS window first (cmd: set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...  |  PowerShell: $env:SLACK_WEBHOOK_URL = \'...\'), or pass --notifier slack to make this an error.');
  }
  return new ConsoleNotifier();
}

export async function pollOnce(
  client: AgentiaClient,
  tracker: JobTracker,
  deps: Parameters<typeof handleTransitions>[1],
  includeExisting: boolean,
): Promise<number> {
  const { jobs } = await client.listJobs();
  const ts = tracker.update(jobs, { includeExisting });
  await handleTransitions(ts, deps);
  return ts.length;
}

async function doctor(cfg: Config, run: Runner, opts: { debugRaw: boolean; job?: string; ai: boolean; commitHelp?: boolean; story?: string }): Promise<number> {
  let bad = 0;
  const ok = (m: string): void => console.log(`  OK    ${m}`);
  const no = (m: string, fix: string): void => {
    bad++;
    console.log(`  FAIL  ${m}\n        -> ${fix}`);
  };
  console.log('1. Agentia job list');
  let firstId = opts.job;
  try {
    const raw = parseEnvelope(await run(cfg.commands.jobList));
    const list = asList(raw);
    if (opts.debugRaw) console.log(JSON.stringify(list[0] ?? raw, null, 2).slice(0, 2000));
    const jobs = list.map(normalizeJob).filter(Boolean);
    if (!list.length) no('Command works but returned 0 jobs', 'Run a validation in Copado, or check the command in radar.config.json "commands.jobList"');
    else if (!jobs.length) no(`Got ${list.length} item(s) but no id/status fields were recognised`, 'Re-run with --debug-raw and extend the field names in src/agentia.ts (ID/STATUS lists)');
    else {
      ok(`${jobs.length} job(s); first: ${jobs[0]?.name} [${jobs[0]?.status}]`);
      firstId ??= jobs.find((j) => j?.state === 'failure')?.id ?? jobs[0]?.id;
    }
  } catch (e) {
    no(`jobList failed: ${(e as Error).message}`, 'Run `agentia cicd job --help`, fix commands.jobList in radar.config.json');
  }
  console.log('2. Agentia job detail (steps + logs)');
  if (firstId) {
    try {
      const d = await new AgentiaClient(run, cfg.commands).getJob(firstId);
      const logChars = d.steps.reduce((n, s) => n + s.log.length, d.log.length);
      if (!d.steps.length && !d.log) no(`Job ${firstId} has no steps or log text`, 'Use --debug-raw / compare with `agentia cicd job get <id> --json`; adjust commands.jobGet');
      else {
        ok(`job ${firstId}: ${d.steps.length} step(s), ${logChars} chars of log`);
        if (d.state === 'failure') {
          const a = analyze([d.raw ?? d.steps.map((s) => s.log).join('\n'), d.errorMessage ?? '']);
          const classified = a.findings.filter((f) => f.category !== 'other');
          if (classified.length) ok(`failure evidence understood: ${a.headline} [${a.kinds.join(', ')}]`);
          else if (a.findings.length) no(`Error text found but not classified: "${a.findings[0].message.slice(0, 90)}…"`, 'Add a rule in triage-rules.json for this wording (see README), or send me the message and I will add it');
          else no('This failed job returned no recognisable error data', 'The CLI output may not include the Result record attachments. Download ValidationResult.json / ResultViewer.json / the function log from the Result record and use `triage <files>`');
        } else console.log('  note  job is not failed; pick a failed one with --job <id> to test the failure evidence');
      }
    } catch (e) {
      no(`jobGet failed: ${(e as Error).message}`, 'Run `agentia cicd job --help`, fix commands.jobGet');
    }
  } else console.log('  skipped (no job id)');
  console.log('3. AI agent (optional)');
  if (opts.ai) {
    const a = await new AgentiaClient(run, cfg.commands).ask('Reply with the single word OK.');
    a ? ok(`answered: ${a.slice(0, 60)}`) : no('No answer from the AI agent', 'Check `agentia auth get --json` (AI set?) and commands.aiAsk; rules-only mode still works');
  } else console.log('  skipped (add --ai)');
  console.log('3b. Commit missing components (optional write action)');
  console.log(`  note  commands.commitMissing = agentia ${cfg.commands.commitMissing.join(' ')}`);
  console.log(`  note  allowCommitMissing=${cfg.allowCommitMissing} dryRunActions=${cfg.dryRunActions}`);
  if (opts.commitHelp) {
    try {
      const help = await run(['cicd', 'cloud', 'commit', '--help']);
      console.log(`  ----- agentia cicd cloud commit --help -----\n${help.trim().split('\n').slice(0, 200).map((l) => `  ${l}`).join('\n')}\n  ----- compare with commands.commitMissing above -----`);
    } catch (e) {
      no(`could not read \`agentia cicd cloud commit --help\`: ${(e as Error).message}`, 'Check the command exists in your CLI version: agentia cicd cloud --help');
    }
  } else console.log('  skipped (add --commit-help to print the real flags)');
  console.log('3c. Story developer lookup (optional, for automatic @-mentions)');
  if (opts.story) {
    const tpl = cfg.commands.storyInfo ?? SUGGESTED_STORY_INFO;
    console.log(`  note  command: agentia ${tpl.join(' ')}${cfg.commands.storyInfo ? '' : '   (a suggestion; set commands.storyInfo to use it)'}`);
    try {
      const res = parseEnvelope(await run(fill(tpl, { story: opts.story })));
      const list = asList(res);
      const rec = list.find((x) => matchesStory(x, opts.story as string));
      console.log(`  note  ${list.length} item(s) returned; first item keys: ${list[0] && typeof list[0] === 'object' ? Object.keys(list[0] as object).join(', ') : '-'}`);
      if (!rec) no(`story ${opts.story} not found in the output`, 'The command may be paged or need a filter flag for one story: check `agentia cicd work --help`');
      else {
        const person = extractPerson(rec);
        person ? ok(`developer: ${person.name ?? ''} ${person.email ?? ''}`.trim()) : no('story found but no developer/owner field recognised', `Keys: ${Object.keys(rec as object).join(', ')}. Tell me which one holds the developer`);
      }
    } catch (e) {
      no(`story lookup failed: ${(e as Error).message}`, 'Check `agentia cicd work --help` for the right command');
    }
  } else console.log('  skipped (add --story US-0000123 to try it)');
  console.log('4. Slack + repo');
  cfg.slackWebhookUrl ? ok('SLACK_WEBHOOK_URL set') : console.log('  note  SLACK_WEBHOOK_URL not set: console output only');
  cfg.signingSecret ? ok('SLACK_SIGNING_SECRET set (buttons can be verified)') : console.log('  note  SLACK_SIGNING_SECRET not set: buttons disabled');
  fs.existsSync(`${cfg.repoDir}/.git`)
    ? ok(`repoDir ${cfg.repoDir} is a git repo (owner lookup enabled)`)
    : console.log(`  note  repoDir is not a git repo (optional): stories still come from Copado's own data; set "repoDir" to a clone of your Salesforce repo to also name the last committer`);
  Object.keys(cfg.users).length ? ok(`${Object.keys(cfg.users).length} user mapping(s)`) : console.log('  note  no "users" mapping: owners shown by name, not @-mentioned');
  console.log(bad ? `\n${bad} problem(s) to fix.` : '\nAll good.');
  return bad ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      notifier: { type: 'string' },
      interval: { type: 'string' },
      'max-polls': { type: 'string' },
      'include-existing': { type: 'boolean' },
      ai: { type: 'boolean' },
      serve: { type: 'boolean' },
      'debug-raw': { type: 'boolean' },
      show: { type: 'boolean' },
      run: { type: 'boolean' },
      revalidate: { type: 'boolean' },
      story: { type: 'string' },
      sample: { type: 'boolean' },
      'commit-help': { type: 'boolean' },
      rules: { type: 'string' },
      job: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  const cfg = loadConfig(values.config);
  if (values.ai) cfg.aiEnabled = true;
  const run = defaultRunner;
  const client = new AgentiaClient(run, cfg.commands);
  const registry = new Registry();
  const log = (s: string): void => console.error(s);

  const startServer = (serverCfg: Config = cfg): void => {
    if (!serverCfg.signingSecret) {
      log('[radar] WARNING: SLACK_SIGNING_SECRET is not set in this window, so every Slack button click will be rejected (HTTP 503). ' +
        'cmd: set SLACK_SIGNING_SECRET=...  |  PowerShell: $env:SLACK_SIGNING_SECRET = \'...\'  then restart.');
    }
    const deps: ActionDeps = { cfg: serverCfg, registry, client, post: (u, b) => postJson(u, b), log };
    const state = (allowed: boolean, name: string): string => (!allowed ? 'disabled' : serverCfg.dryRunActions && !serverCfg.liveActions.includes(name) ? 'DRY-RUN' : 'LIVE');
    createServer(deps).listen(serverCfg.port, () => log(`[radar] Slack actions endpoint: POST :${cfg.port}/slack/actions (Slack Request URL must be https://<your-tunnel>/slack/actions; re-run ${state(serverCfg.allowActions, 'rerun')}, re-validate ${serverCfg.commands.revalidate ? state(serverCfg.allowActions, 'revalidate') : 'not configured'}, commit-missing ${state(serverCfg.allowCommitMissing, 'commit')})`));
  };

  switch (cmd) {
    case 'triage': {
      const targets = positionals.slice(1);
      if (!targets.length) {
        console.log('usage: release-radar triage <file|folder>... [--show] [--rules triage-rules.json]');
        return 1;
      }
      const files: string[] = [];
      const missing = targets.filter((t) => !fs.existsSync(t));
      if (missing.length) {
        console.error(`Not found: ${missing.join(', ')}\nCreate the folder and put the downloaded files in it, or pass the file paths directly.`);
        return 1;
      }
      for (const t of targets) {
        if (fs.statSync(t).isDirectory()) {
          for (const f of fs.readdirSync(t)) if (!f.startsWith('.') && fs.statSync(`${t}/${f}`).isFile()) files.push(`${t}/${f}`);
        } else files.push(t);
      }
      // Windows PowerShell 5.1 `>` writes UTF-16 LE; also strip a UTF-8 BOM.
      const read = (f: string): string => {
        const buf = fs.readFileSync(f);
        return (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
      };
      const custom = loadCustomRules(values.rules ?? cfg.rulesFile);
      for (const pr of custom.problems) console.error(`[radar] ${pr}`);
      const a = analyze(files.map(read), { rules: custom.rules });
      if (values.show) {
        console.log(`--- files: ${files.join(', ')}`);
        console.log(`--- formats recognised: ${a.kinds.join(', ') || 'none'}`);
        console.log(`--- errors read: deploy-report=${a.sources.report} copado-result=${a.sources.viewer} log-text=${a.sources.log} pattern-rules=${a.sources.text}`);
        if (!a.findings.length || a.sources.text) console.log(`--- free text the pattern rules scanned ---\n${a.text}\n--- end ---`);
        console.log('');
      }
      console.log(a.headline);
      for (const f of a.findings.slice(0, 15)) {
        const cnt = f.count && f.count > 1 ? `  (${f.count} errors${f.affects && f.affects.length > 1 ? ` in ${f.affects.length} components` : ''})` : '';
        console.log(`  [${f.category}] ${f.component ?? '-'}${f.line ? `:${f.line}` : ''}  ${f.message}${cnt}`);
      }
      const stories = [...new Set(Object.values(a.stories))];
      if (stories.length) console.log(`  stories: ${stories.join(', ')}`);
      for (const o of ownersForTriage(cfg.repoDir, a.findings, a.stories, cfg.users, cfg.storyOwners, cfg.storyRegex))
        console.log(`  owner: ${o.component} -> ${o.owner.name ?? 'unknown'} ${o.owner.story ?? ''} ${o.owner.slackId ? `(<@${o.owner.slackId}>)` : '(no Slack mapping)'}`);
      if (!a.findings.length || a.findings.every((f) => f.category === 'other')) {
        console.log('\nNo known pattern matched. Run again with --show to see what was scanned, or add a rule to triage-rules.json (see README).');
      } else console.log('\n' + a.explanation);
      return 0;
    }
    case 'commit-missing': {
      if (!values.job) {
        console.log('usage: release-radar commit-missing --job <failed-job-id> [--run]');
        return 1;
      }
      const job = await client.getJob(values.job);
      const custom = loadCustomRules(cfg.rulesFile);
      const tri = await triage(job, undefined, { rules: custom.rules });
      console.log(`${job.name}: ${tri.headline}`);
      const plan = resolveCommitAction({ job, triage: tri }, cfg);
      if (!plan) {
        console.log("\nNothing safe to commit automatically: either no failure points at a missing custom field or Apex class, the owning story is not unambiguous, or the story's Copado record id is not available (the commit command needs it).");
        console.log("If it is the record id: find it with  SELECT Id FROM copado__User_Story__c WHERE Name = 'US-...'  and add  \"storyIds\": { \"US-...\": \"a93...\" }  to radar.config.json.");
        return 1;
      }
      const argvs = client.commitCommands(plan.story, plan.components, commitMessage(job), plan.storyId);
      console.log(`\nStory: ${plan.story}${plan.storyId ? ` (${plan.storyId})` : ''}\nComponents (${plan.components.length}):`);
      for (const c of plan.components) console.log(`  ${c.type}:${c.name}`);
      console.log(`\n${argvs.length > 1 ? `Commands (${argvs.length}, run one after another):` : 'Command:'}`);
      for (const x of argvs) console.log(`  ${showCommand(x)}`);
      console.log('Only for stories that use the cloud commit flow. The components must exist in the story\'s source org; Copado checks this and fails otherwise.');
      if (!values.run) {
        console.log('\nDry run. Add --run to perform the commit.');
        return 0;
      }
      console.log('\nRunning (this polls the Copado job and can take a few minutes)...');
      console.log(await client.commitMissing(plan.story, plan.components, commitMessage(job), plan.storyId));
      if ((values.revalidate || cfg.autoRevalidate) && cfg.commands.revalidate?.length && isValidationJob(job)) {
        const ctx = { ...revalidateContext(job, cfg), message: `ReleaseRadar re-validation after committing missing components (${job.number ?? job.id})` };
        console.log(`\nStarting a new validation: ${showCommand(client.revalidateCommand(ctx))}`);
        console.log(await client.revalidate(ctx));
        console.log('\nRe-validation requested. Watch for the result.');
        return 0;
      }
      console.log(`\nCommit done. ${!isValidationJob(job) ? 'This job was not a validation, so re-validate in Copado by hand' : cfg.commands.revalidate?.length ? 'Add --revalidate (or run: revalidate --job <id> --run)' : 'Re-validate the promotion in Copado (or set commands.revalidate)'} to confirm the failure is gone.`);
      return 0;
    }
    case 'revalidate': {
      if (!values.job) {
        console.log('usage: release-radar revalidate --job <job-id> [--run]   (note: one word, no hyphen)');
        return 1;
      }
      const job = await client.getJob(values.job);
      if (!isValidationJob(job)) {
        console.log(`${job.name}\nThis job was not a validation (it is a real deployment or another kind of job). Re-validating would run the promotion with --deploy, so ReleaseRadar refuses.\nStart the next step in Copado by hand, or use Re-run (job resume) for this job.`);
        return 1;
      }
      const ctx = { ...revalidateContext(job, cfg), message: `ReleaseRadar re-validation (${job.number ?? job.id})` };
      const argv = client.revalidateCommand(ctx);
      console.log(`${job.name}\nStory: ${ctx.story ?? '-'}${ctx.storyId ? ` (${ctx.storyId})` : ''}   Promotion: ${ctx.promotion ?? '-'}${ctx.promotionId ? ` (${ctx.promotionId})` : ''}\n\nCommand: ${showCommand(argv)}`);
      console.log('This re-creates the validation promotion branch from the story\'s latest commits and validates again (check-only, because the failed job was a validation).');
      if (!values.run) {
        console.log('\nDry run. Add --run to start the new validation.');
        return 0;
      }
      console.log('\nRunning (this waits for the promotion and deployment; up to ~15 minutes)...');
      console.log(await client.revalidate(ctx));
      console.log('\nRe-validation finished or was requested. Check the result in Copado / the next card.');
      return 0;
    }
    case 'rerun': {
      if (!values.job || !/^[A-Za-z0-9_-]{3,40}$/.test(values.job)) {
        console.log('usage: release-radar rerun --job <job-id> [--run]');
        return 1;
      }
      const argv = fill(cfg.commands.jobRerun, { id: values.job });
      console.log(`Re-run job ${values.job}\nCommand: ${showCommand(argv)}\nThis resumes the outstanding steps of the SAME job. It does not pick up commits made afterwards.`);
      if (!values.run) {
        console.log('\nDry run. Add --run to resume the job.');
        return 0;
      }
      console.log(`\n${await client.rerun(values.job)}\n\nRe-run requested. Check the result in Copado / the next card.`);
      return 0;
    }
    case 'cli-help': {
      const words = positionals.slice(1);
      if (!words.length || !words.every((w) => /^[a-z][a-z-]*$/.test(w))) {
        console.log('usage: release-radar cli-help <command words>   e.g.  cli-help cicd cloud promote');
        return 1;
      }
      console.log((await run([...words, '--help'])).trim().split('\n').slice(0, 300).join('\n'));
      return 0;
    }
    case 'doctor':
      return doctor(cfg, run, { debugRaw: !!values['debug-raw'], job: values.job, ai: !!values.ai, commitHelp: !!values['commit-help'], story: values.story });
    case 'serve': {
      if (!values.sample) {
        startServer();
        await new Promise(() => undefined);
        return 0;
      }
      // Sample mode: invented data, and every action is forced to DRY RUN so nothing real can happen.
      const safeCfg: Config = { ...cfg, dryRunActions: true, liveActions: [] }; // liveActions would otherwise let a sample button run for real
      startServer(safeCfg);
      const notifier = makeNotifier(values.notifier, cfg, log);
      const toSlack = notifier instanceof SlackNotifier;
      for (const c of sampleCards(cfg)) {
        if (c.kind === 'failure') {
          registry.set(c.report);
          await notifier.failure(c.report);
        } else await notifier.success(c.success);
      }
      log(toSlack
        ? '[radar] sample cards SENT TO SLACK (invented data; actions are forced to dry run). Click the buttons in Slack. Ctrl+C to stop.'
        : '[radar] sample cards were only PRINTED above, not sent to Slack (see the NOTE). Ctrl+C to stop.');
      await new Promise(() => undefined);
      return 0;
    }
    case 'once':
    case 'watch': {
      const collect = values.notifier === 'json' ? new CollectNotifier() : undefined;
      const notifier = collect ?? makeNotifier(values.notifier, cfg, log);
      const tracker = new JobTracker();
      let announced = 0;
      const counting: Notifier = {
        failure: async (r) => (announced++, notifier.failure(r)),
        success: async (s) => (announced++, notifier.success(s)),
        info: async (t) => (announced++, notifier.info(t)),
      };
      const deps = { client, notifier: counting, registry, cfg, log };
      if (cmd === 'watch' && values.serve) startServer();
      const maxPolls = cmd === 'once' ? 1 : values['max-polls'] ? Number(values['max-polls']) : Infinity;
      const interval = Math.max(1, Number(values.interval ?? 20)) * 1000;
      let stop = false;
      process.on('SIGINT', () => (stop = true));
      for (let n = 1; n <= maxPolls && !stop; n++) {
        try {
          const events = await pollOnce(client, tracker, deps, !!values['include-existing']);
          log(`[radar] poll ${n}: ${events} change(s), ${announced} announced`);
          announced = 0;
        } catch (e) {
          log(`[radar] poll ${n} failed: ${(e as Error).message}`);
        }
        if (n < maxPolls && !stop) await sleep(interval);
      }
      if (collect) console.log(JSON.stringify(collect, null, 2));
      return 0;
    }
    default:
      console.log(HELP);
      return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}

export { fill };