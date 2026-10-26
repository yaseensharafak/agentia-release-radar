# ReleaseRadar

**Slack ChatOps for Copado pipeline failures, headless.** ReleaseRadar watches Copado job executions through the
[Agentia CLI](https://developer.copado.com/). When one fails it reads the failure evidence, collapses hundreds of errors
into their **root causes**, finds the **user story**, and posts a Slack card with buttons to see the recommended fix or
re-run the job. No browser tab, no hosted infrastructure, **zero runtime dependencies**.

> The card below comes from the bundled sanitised samples (invented names; same structure as a real Copado
> validation failure, where one promotion produced 261 errors that traced back to 7 root causes). See
> [Verification status](#verification-status).

```
┌──────────────────────────────────────────────────────────────
│ JOB FAILED: Validate US-0000123 to UAT   [Error]  id=9
│ 33 errors from 4 root causes: 3 missing fields, 1 unknown variable
│   Missing fields (referenced by code, not found in the target org or this promotion):
│   • ACME_Billing_Plan__c.Outstanding_Amount__c: 12 errors
│   • ACME_Installment__c.Due_On__c: 12 errors
│   • ACME_Invoice__c.Billing_Plan__c: 8 errors
│   Next step: add the missing field metadata to a user story in this promotion (or deploy it first), then re-validate.
│ Root causes:
│   - InvoiceSyncHandler:61 Missing field ACME_Billing_Plan__c.Outstanding_Amount__c  (12 errors in 2 components)
│   - InvoiceSyncHandlerTest:20 Missing field ACME_Installment__c.Due_On__c  (12 errors)
│   - InvoiceSyncHandler:40 Missing field ACME_Invoice__c.Billing_Plan__c  (8 errors in 2 components)
│   - InvoiceSyncHandler:88 Unknown name LegacyNotifier (looks like a missing Apex class)
│ Story / owner:
│   - InvoiceSyncHandler, InvoiceSyncHandlerTest -> @U0DEV12345 · US-0000123
│ [Recommended fix] [Re-run job]   (buttons appear in Slack)
└──────────────────────────────────────────────────────────────
```

## Who it helps

| Stakeholder | What they get in Slack |
| :-- | :-- |
| **Release Management / Copado Admin** | Every commit, validation and deployment event in one channel; root causes on every failure; **Re-run job** in one click |
| **Developers** | Tagged on their own story; the cause in plain English; **Commit N missing components** when the failure is caused by components that were never committed |
| **QA team** | Knows the moment a validation or deployment passes; **Open pull request** and **Promote in Copado** one click away |

Try it in two minutes without a Copado org: `serve --sample` posts one invented card for every event with working buttons
(see [TESTING-GUIDE.md](TESTING-GUIDE.md) for the Slack and ngrok steps).

## Why this exists (and what it is not)

Copado already ships Slack notification subscriptions (`agentia cicd notification`) and other Agentia projects poll jobs
or ask the AI agent about failures. ReleaseRadar does not claim to be the first to notice a failed job. What it adds:

- **Root-cause triage, not an error dump.** Reads the artifacts Copado attaches to the deployment job's Result record
  (the Salesforce deploy report, Copado's result viewer, the function log) and groups errors by cause. "Variable does not
  exist: X" and "No such column X" are recognised as the same missing field. This works without AI; AI
  (`agentia ai agent ask`) only rewrites the explanation, and if it is down the card still works.
- **Story and owner.** Copado's own component list in the function log says which user story owns each failing class;
  git history (optional) adds the person; a small map turns that into a Slack `@`-mention.
- **Not a regex pile.** Structured formats are parsed structurally. Unknown formats are handled by pattern rules that you can
  extend in a JSON file (`triage-rules.json`) with no code change or rebuild.
- **Safe actions in chat**: signed requests only; re-run is off by default, dry-run by default, limited to an allow-list
  and to jobs the radar announced.

## How it works

```
release-radar watch
  -> agentia cicd job list --json         (poll, detect state changes)
  -> agentia cicd job get <id> --json     (the failed job's steps, logs and any embedded results)
  -> evidence: deploy report JSON | Copado result viewer JSON | function log text | plain text
  -> root causes (errors grouped; stories from "Metadata list as JSON")  [+ agentia ai agent ask: plain-English summary, redacted]
  -> Slack Block Kit card via incoming webhook (@-mention from the story / git owner)
Slack button click -> POST /slack/actions (signature + replay checked)
  -> "Recommended fix": private reply   |   "Re-run job": allow-list + dry-run gate -> agentia cicd job resume <id>
```

All Copado access is the public `agentia ... --json` command (envelope `{result, status, transactionId}`; the parser
tolerates a leading warning line and paged `result.data`). **Every command string lives in one table**
(`src/agentia.ts`, overridable in `radar.config.json`).

## Where the failure evidence comes from

Every Copado job execution has a **Result record**. On a failed deployment it carries three artifacts, and ReleaseRadar reads all of
them, alone or together (identical errors are counted once, using the richest source):

| Artifact (Result record) | What it contains | What ReleaseRadar takes from it |
| :-- | :-- | :-- |
| `ValidationResult.json` (Files) | `sf project deploy report --json`: `componentFailures[]` with class, line, column, problem; test failures; coverage | The most precise errors |
| `ResultViewer.json` (Output Data / Logs) | `{Level, Category, Message}`; the error message is `Type:Name:Problem` lines | Errors when the report is missing |
| Function log (`Function_Logs_for_*.txt`) | Whole run; includes `Metadata list as JSON: [{u: story, n: component}]` | **User story per component**; errors as a last resort (Copado prints the list several times; copies are counted once) |

```bash
# Download the artifacts from the Result record, then analyse them together (a folder works too):
node dist/src/cli.js triage ValidationResult.json ResultViewer.json Function_Logs_for_XXXX.txt --show
```

`--show` lists which formats were recognised and how many errors each held. Whether `agentia cicd job get` returns these artifacts
inline depends on your CLI version: `release-radar doctor` tells you, and the downloaded files always work.

> **Keep real artifacts out of git.** They contain repository names, org users and class names. `.gitignore` blocks the usual
> file names, and this repo ships only sanitised samples in `fixtures/formats/`.

## Extend the rules without touching code

Put extra patterns in `triage-rules.json` (picked up automatically; or `--rules file`). See `triage-rules.example.json`:

```json
[{ "pattern": "CUSTOM-ERR-(?<line>\\d+):\\s*(?<component>\\w+)\\s*(?<message>.+)$", "category": "validation", "flags": "i" }]
```
Named groups `component`, `line`, `column`, `message` are used when present. Categories: `apex-compile`, `apex-test`, `coverage`,
`missing-dependency`, `permissions`, `validation`, `flow`, `duplicate`, `other`. Invalid rules are reported at start-up, never
silently skipped. Rules apply to free text; structured formats above do not need them.

## Try it offline (2 minutes)

```bash
npm install && npm run build
npm test            # 177 tests pass (+1 optional, skipped; works on Windows, macOS, Linux; no shell needed)
npm run demo        # mock Copado: baseline poll -> failure card -> success
node dist/src/cli.js serve --sample   # post sample cards (invented data) to Slack and test the buttons, no Copado needed
```

## Run it for real

**1. Connect to Copado and verify the commands**
```bash
npm install -g @copado/agentia-cli@beta && agentia setup
agentia cicd job --help ; agentia ai agent --help     # compare with src/agentia.ts DEFAULT_COMMANDS
cp radar.demo.config.json radar.config.json           # set repoDir, users, and any command overrides
npm run build && node dist/src/cli.js doctor --debug-raw --ai
```
`doctor` runs the job list, reads one job's steps and logs, tries the AI agent, and checks Slack and repo setup. Each
failure prints the exact fix. **Do this first**: the five command strings are my best match to the docs and other public
Agentia projects, not verified against your CLI.

**2. Slack**
1. api.slack.com/apps -> Create app -> Incoming Webhooks -> add to your channel -> `export SLACK_WEBHOOK_URL=...`
2. Basic Information -> Signing Secret -> `export SLACK_SIGNING_SECRET=...`
3. Interactivity & Shortcuts -> On -> Request URL `https://<tunnel>/slack/actions` (run `ngrok http 3000` or similar).
   Use the same Slack app for the webhook and interactivity.
4. Slack profile -> Copy member ID, and put IDs into `users` (email -> ID) and `allowedUsers`.

```bash
node dist/src/cli.js watch --serve --ai          # polls every 20s and serves the buttons
```

**3. Re-run button**: `allowActions: true` + `allowedUsers`. It stays **dry-run** until you set `RADAR_DRY_RUN_ACTIONS=0`.
Verify `commands.jobRerun` (`job resume` vs `job run`) with `agentia cicd job --help` before turning dry-run off.

`radar.config.json` (secrets only via environment variables):
```json
{
  "repoDir": "/path/to/your/salesforce-repo",
  "users": { "yaseen@company.com": "U0123ABCD" },
  "allowActions": true,
  "allowedUsers": ["U0123ABCD"],
  "storyOwners": { "US-0000123": "U0123ABCD" },
  "successActions": ["all"],
  "destinations": { "qa1": "QA1 sandbox" },
  "orgUrl": "https://yourdomain.my.salesforce.com",
  "commands": { "jobRerun": ["cicd", "job", "resume", "{id}", "--json"] }
}
```

**Tune the rules on a real failure (no Copado or Slack needed):**
```bash
agentia cicd job get <failed-job-id> --json > failed-job.json
node dist/src/cli.js triage failed-job.json      # shows findings, owners and the rule-based explanation
```
If it prints "No known pattern matched", add a rule to `triage-rules.json` (see "Extend the rules without touching code").

## What gets announced

ReleaseRadar tells people about **milestones, not just failures**. Every job gets wording that matches what it did:

| Job (Copado action) | Message on success |
| :-- | :-- |
| Deploy, validation (`PromotionDeployment`, dry run) | **Validation succeeded**: US-0000902 validated against QA Demo sandbox. Nothing was deployed. |
| Deploy, real | **Deployment succeeded**: US-0000906, US-0000907 successfully deployed to QA Demo sandbox. |
| Promote (`Promotion`) | **Promotion step completed**: promotion P-9000 is ready for QA Demo sandbox (validation run). |
| Commit | **Commit succeeded**: the commit message. |
| Quality checks (tests, PMD) | **Quality check passed**: Run PMD. |
| Anything else | `<job name> succeeded` |

```
[OK] Validation succeeded: US-0000902 validated against QA Demo sandbox. Nothing was deployed.   (Promotion P-9000 · JE-900008 · ~1m 5s)
[DEPLOYED] Deployment succeeded: US-0000906, US-0000907 successfully deployed to QA Demo sandbox.   (Promotion P-9010 · JE-900010 · ~3m 12s)
[OK] Promotion step completed: US-0000902: Promotion P-9000 is ready for QA Demo sandbox (validation run).   (Promotion P-9000 · JE-900006 · ~5m 0s)
```
(The console prints `[OK]`; in Slack the same text is a compact card with a ✅ or 🚀.) **Failures of any job are always announced**,
including quality gates ("code coverage is below 90%").

Control it in `radar.config.json`:

```json
{
  "successActions": ["all"],
  "destinations": { "qa1": "QA1 sandbox" },
  "orgUrl": "https://yourdomain.my.salesforce.com"
}
```
- `successActions`: `["all"]` (default) announces every kind of success. A real pipeline produces several jobs per story (commit,
  quality checks, promote, deploy), so to keep the channel quiet use for example `["PromotionDeployment"]` (validations and deployments
  only) or `["PromotionDeployment", "Promotion"]`. Actions: `PromotionDeployment`, `Promotion`, `Commit`, `Test`. `[]` silences success.
- `destinations` (optional): the job data names the **destination branch** (for example `qa1`), not the environment. With no config that branch name is shown, for any destination. Add friendly names only if you want them; exact names or `*` patterns work (`"uat*": "UAT"`).
- `orgUrl` (or env `RADAR_ORG_URL`, https only): adds "Open promotion" / "Open job" links using Salesforce's `<org>/<recordId>` path.
  **Check one link works in your org** before the demo; an invalid or non-https URL is ignored.
- "Took ~1m 5s" is a rough duration from the job's created and modified times.

## Who gets mentioned (no per-story setup)

The **story** and the **destination** are read from Copado's job data for every job, so they need no configuration. Only the **@-mention** needs to know who
to ping. In order of priority:

1. `storyOwners`: an explicit `"US-0000123": "U0123ABCD"` entry (Slack member id).
2. The story's **developer, found in Copado** (optional, below), mapped to Slack through your `users` map (by email or by name).
3. `defaultOwner`: one Slack member id used for every story that has no better match (for example the release manager). This is all you need to start.

```json
{ "defaultOwner": "U0123ABCD" }
```

**Optional automatic developer lookup.** Copado's job data holds only record ids, not the developer. To read the developer of a story, set `commands.storyInfo` to a command
that lists user stories, then check it with `doctor`:

```bash
node dist/src/cli.js doctor --story US-0000123     # shows what Copado returns and whether a developer was recognised
```
```json
{ "commands": { "storyInfo": ["cicd", "work", "list", "--json"] }, "users": { "dana@yourcompany.com": "U0123ABCD", "Dana Developer": "U0123ABCD" } }
```
The command above is a **suggestion, not verified** (check `agentia cicd work --help`; it may be paged or need a filter flag). It is off unless you set it, read-only, cached,
and a failed lookup simply means "unknown".

## Buttons by event

Every card gets the buttons that make sense for what just happened. Buttons ending in **↗** only open a page; they never start anything.

| Event | Buttons |
| :-- | :-- |
| Commit succeeded | Open pull request ↗ (the story's branch), Validate in Copado ↗ (the story page) |
| Commit failed | Recommended fix, Re-run job |
| Validation succeeded | Open pull request ↗, Promote in Copado ↗ (the promotion page) |
| Validation failed | Recommended fix, Commit N missing components to US-..., Re-run job |
| Deployment succeeded | Open pull request ↗, Validate next environment ↗ (the story page) |
| Deployment failed | Recommended fix, Commit N missing components to US-..., Re-run job |

A button is left out when the link or id it needs is not known (no dead buttons). The Copado links need `orgUrl`
(https) in the config; **Open pull request** needs `"pullRequestLinks": true` (one extra read-only `agentia cicd promotion get`
per card, GitHub only). **Re-run job** is hidden when `allowActions` is false. **Re-validate** appears on validation-failure
cards when `allowActions` is true, unless you set `"commands": { "revalidate": null }`. Copado can refuse it (error PRO-056, "user stories
have issues that must be resolved") when the story itself has unresolved issues, so the recommended config in TESTING-GUIDE.md (Part 6) turns it off.

`serve --sample` posts one invented card per event so you can check every button without Copado. The step-by-step
test, including the Slack app and ngrok setup, is in **TESTING-GUIDE.md**.

## Re-run vs re-validate (and which actions are live)

These are different things, and the difference matters after a commit:

| Action | Default command (from the real `--help`) | What it does |
| :-- | :-- | :-- |
| **Re-run job** | `agentia cicd job resume <job id> --json` | **Resumes the outstanding steps of the same job execution.** It does **not** pick up a commit made afterwards. For transient failures (timeout, flaky step) |
| **Re-validate** | `agentia cicd cloud promote <story record id> --promotion-id <promotion id> --deploy --recreate-promotion-branch --yes --wait --json` | **Re-creates the validation promotion's branch from the story's latest commits and validates again.** The right step after "Commit missing components" |

**Safety rule for re-validate.** `--deploy` means merge-and-deploy: on a *validation* promotion that is a check-only deployment, on any other promotion it would be a real deployment.
So ReleaseRadar offers re-validate **only for jobs that were validations** (`deploymentDryRun: true`), and `revalidate --job` refuses a real deployment. `--recreate-promotion-branch --yes`
rebuilds the (derived) promotion branch without a prompt; the Slack confirmation dialog says so. To turn the feature off set `"commands": { "revalidate": null }`.

**Status:** both commands use flags from the real help. Re-run's `job resume` exists; check its arguments with `cli-help cicd job resume`. Re-validate has **not been run live yet**: use the dry run first, then one `--run` on a sandbox story.

```bash
node dist/src/cli.js cli-help cicd cloud promote     # the real help (any agentia command works: cli-help cicd job resume ...)
node dist/src/cli.js revalidate --job <failed-validation-job-id>                 # prints the exact command, runs nothing
node dist/src/cli.js revalidate --job <failed-validation-job-id> --run           # re-creates the promotion branch and validates again
node dist/src/cli.js commit-missing --job <failed-validation-job-id> --run --revalidate    # commit, then validate again
```
(`revalidate` is one word.) `"autoRevalidate": true` in the config does the second step automatically after a live commit. `{storyId}`, `{story}`, `{promotionId}` and `{message}` are the placeholders if you need to change the command.

**Make individual actions live** without turning everything live. Every write action is a dry run by default; `liveActions` lists the ones allowed to run for real:

```json
{ "allowActions": true, "allowCommitMissing": true, "allowedUsers": ["U0123ABCD"], "liveActions": ["commit"] }
```
Use any of `commit`, `rerun`, `revalidate` (or the env var `RADAR_LIVE_ACTIONS=commit,rerun`). `dryRunActions: false` still turns everything live. `serve --sample` always forces dry run.
The start-up line shows the state of each button (`DRY-RUN`, `LIVE`, `disabled`, `not configured`).

## Fix button: commit the missing components

When a failure is caused by components that exist in the developer's org but were never committed (typically custom fields or an
Apex class), the card gets a button: **"Commit 5 missing components to US-0000777"**. One click asks Copado, through
`agentia cicd cloud commit`, to commit exactly those components from the story's source org into that story. You then re-validate.

What it will and will not do:

| Rule | Why |
| :-- | :-- |
| Only **custom fields** and **Apex classes** named by the failure (`CustomField:Obj__c.Field__c`, `ApexClass:SomeService`); never standard fields, picklist values or anything it cannot name plainly. A compound PascalCase name in "Variable does not exist: DiscountCalculatorService" is treated as a likely Apex class (a guess: if the class is not in the source org, Copado refuses the commit) | Components are validated against a strict name pattern; at most 50 |
| Only when **one story** clearly owns the failing code (Copado's own component list), or the job has exactly one story | With several candidate stories it refuses to guess and tells you to commit by hand |
| **Off by default** (`allowCommitMissing`), limited to `allowedUsers`, and only for jobs ReleaseRadar announced | A write action needs more care than a read-only card |
| **Dry run by default** (`dryRunActions`): the first click only shows the exact components and the exact command | Check it before anything is written |
| The Slack confirmation dialog names the components; a second click on a live run is refused; a failed run can be retried | No accidental duplicate commits |
| **Cloud-flow stories only** | Copado does not allow mixing local-flow and cloud commits on one story |

It cannot know whether the fields exist in the developer's org. If they do not, Copado's preflight fails and the failure is reported back.

Test it without Slack first (dry run is the default):

```bash
node dist/src/cli.js commit-missing --job <failed-deploy-job-id>          # prints the plan, commits nothing
node dist/src/cli.js commit-missing --job <failed-deploy-job-id> --run    # performs the commit
```

**The command it runs** follows the real `agentia cicd cloud commit --help`, and has been **run live by the author**: the story is a positional argument and must be the
story's **Copado record id** (`a93...`), not its name (`US-...` is rejected with "Invalid id"); metadata is given one item per call with `--metadata-type` and
`--metadata-name`; and **`--metadata-category SFDX` is required** (without it Copado skips the deploy with "Salesforce changes not found."). With several components it makes one
call per component, one after another, and stops at the first failure saying how many had succeeded:

```
agentia cicd cloud commit a93XXXXXXXXXXXXXXX --metadata-type CustomField --metadata-name ACME_Invoice__c.Discount__c --metadata-category SFDX --message "ReleaseRadar: ..." --wait --json
```
The record id comes from the job data (the job lists story ids and names in the same order). If a job does not carry it, no commit button is offered (a click could only fail).
Supply it yourself in `radar.config.json`; to find it:

```sql
SELECT Id FROM copado__User_Story__c WHERE Name = 'US-0000777'
```
```json
{ "storyIds": { "US-0000777": "a93XXXXXXXXXXXXXXX" } }
```
This is the default in `commands.commitMissing` (placeholders `{storyId}`, `{story}`, `{type}`, `{name}`, `{message}`). Check it against your CLI with:

```bash
node dist/src/cli.js doctor --commit-help       # prints the whole of: agentia cicd cloud commit --help
```
A template with `{metadata}` or `{metadataJson}` instead of `{type}`/`{name}` makes one call for all components (for example with `--selection` or `--file`, if your CLI supports it).

**Failures are never reported as success.** Agentia reports errors as `{"error": {...}}`; ReleaseRadar treats that as a failure and removes any `api_key` the message contains before printing it or posting it to Slack.

```json
{
  "allowCommitMissing": true,
  "allowedUsers": ["U0123ABCD"],
  "commands": { "commitMissing": ["cicd", "cloud", "commit", "{storyId}", "--metadata-type", "{type}", "--metadata-name", "{name}", "--metadata-category", "SFDX", "--message", "{message}", "--wait", "--json"] }
}
```
## Safety model

| Risk | Control (each covered by a test) |
| :-- | :-- |
| Forged button clicks | Slack signing-secret HMAC verified with a constant-time compare; 5-minute replay window |
| Anyone clicking Re-run | Off by default; allow-list of Slack user IDs; only job ids the radar announced; dry-run by default |
| Command injection | argv arrays, never a shell; job ids validated; log text never used as a git pathspec |
| Mention / link injection from logs or commits | Slack control characters escaped in card text and the fallback text; only the owner map can `@`-mention |
| Secrets leaving the machine | Bearer tokens, session ids, `password=`/`access_token=` values and emails redacted before AI |
| SSRF via `response_url` | Only `https://hooks.slack.com` accepted |
| AI overreach | AI only rewrites the explanation, is labelled "verify", and can never trigger an action |
| Wrong components committed | Computed server-side from the stored failure (the button carries only the job id), name-validated, story must be unambiguous, dry run first, confirmation dialog lists them |

## Verification status

| | Status |
| :-- | :-- |
| Evidence parsers (deploy report, Copado result viewer, function log), root-cause grouping, poller, triage rules, redaction, owner lookup (real temp git repos), Block Kit cards and buttons per event, signature and replay checks, action authorization matrix, HTTP server round trip, end-to-end polling through a real child-process boundary | **177 automated tests passing** (+1 optional, skipped) |
| `agentia cicd job list --json` and `agentia cicd job get <id> --json` on a **real org** | **Verified** by the author: output shapes (template, `context`, `dataJson`, `errorMessage`, steps/results) are parsed, and sanitised samples of both are in `fixtures/formats/` |
| The three Copado artifacts against a **real** failed validation | **Verified once, by the author, on one real promotion**: 261 errors from 7 root causes, identical from all three artifacts, story read from the function log. The repo ships sanitised samples with the same structure, not the real files |
| Real Slack delivery and button clicks (through ngrok) | **Verified live by the author**: cards for commit, validation and deployment events; **Recommended fix**; **Re-run job** (`cicd job resume` answered `In Progress`); **Commit missing components** (a real `cicd cloud commit`, followed by a "Commit succeeded" card) |
| `cicd promotion get` (pull request link) and `cicd work status` (story record id, base branch) | **Verified live**; the link is built from their output. The commit pull request assumes Copado's `feature/<story>` branch name, so check it on your pipeline |
| Re-validate (`cicd cloud promote ... --recreate-promotion-branch`) | Works only when the story has no unresolved issues: Copado refused it with `PRO-056` on a story that had some, so it is **off in the recommended config** |
| Starting a validation or a real promotion from Slack | **Not offered.** The Agentia CLI has no command for it that works without a local git checkout, so **Validate** and **Promote** buttons open the Copado page instead |
| AI summary (`agentia ai agent ask`) | **Optional and not part of the live run**; the cards work with rules only |
| Pattern rules on other log layouts | Verified on realistic samples only. Add rules in `triage-rules.json` |

## Limits and roadmap

Slack only (a Teams adapter fits the `Notifier` interface). One channel for the team, with the story owner tagged (no per-role channels yet).
State is in-memory (a restart re-baselines, and cards posted before it stop working). It polls (no Copado webhooks).
Not implemented: "exclude story from promotion". Roadmap: Teams, per-role channels, Copado webhooks, threads via bot token,
persisted state, an MCP wrapper around `release-radar once`.
