# Testing ReleaseRadar on your own machine: step by step

Work through the phases in order. Each phase has a pass condition; do not move on until it passes.
Total time: about 30 minutes for phases A-C, then it depends on how fast your Copado validations run.

## Step 0: What you need

| Need | Notes |
| :-- | :-- |
| **Windows, macOS or Linux** | Windows works natively (PowerShell or CMD); see "Windows notes" below for the PowerShell equivalents of the bash commands. I could only test the Windows-specific code paths by simulation (a stripped environment with no `sh`), not on a real Windows machine. If anything Windows-specific misbehaves, WSL2 (`wsl --install`, then work inside the Ubuntu terminal) is the fallback. |
| Node.js 20+ (built and tested on 22) | `node -v`. If missing: install via nvm (`nvm install 22`). |
| git | `git --version` |
| Copado access | A licence, or a Copado playground (Success Community). A **Source Format** pipeline (the Agentia CLI supports only those), a test user story with a commit you can validate, and a clone of the Salesforce repo Copado manages. Use a sandbox/playground pipeline, never production. |
| Copado API key | Per another entrant's README: Copado Account Summary, API Key tab. Confirm in Copado's docs. |
| Slack workspace where you can add apps | A free personal workspace is fine. |
| ngrok (free) | Only for phase G (buttons). |


## Windows: pick ONE shell (PowerShell or Command Prompt) and stay in it

The two shells use different syntax. Mixing them is the most common cause of confusing errors.

| | PowerShell | Command Prompt (cmd) |
| :-- | :-- | :-- |
| Set a variable | `$env:SLACK_WEBHOOK_URL = 'https://...'` | `set SLACK_WEBHOOK_URL=https://...` (no spaces around `=`, **no quotes**) |
| Use it | `$env:SLACK_WEBHOOK_URL` | `%SLACK_WEBHOOK_URL%` |
| Filter output | `... \| Select-String sample` | `... \| findstr sample` |
| Test the webhook | `Invoke-RestMethod -Method Post -Uri $env:SLACK_WEBHOOK_URL -ContentType 'application/json' -Body '{"text":"hello"}'` | `curl -X POST -H "Content-type: application/json" --data "{\"text\":\"hello\"}" %SLACK_WEBHOOK_URL%` |
| Health check | `Invoke-RestMethod http://localhost:3000/health` | `curl http://localhost:3000/health` |

A variable set this way lasts only for that window. Set `SLACK_WEBHOOK_URL` and `SLACK_SIGNING_SECRET` again in every new window.

**"npm.ps1 cannot be loaded because running scripts is disabled on this system"** (PowerShell only). Windows blocks PowerShell scripts, and `npm` is one.
Either use **Command Prompt** for the `npm` commands, or in PowerShell type `npm.cmd` instead of `npm` (for example `npm.cmd install`).
Changing the execution policy is a security setting, so on a work machine ask your IT team first. `node ...` commands are not affected.

**"Unknown option '--sample'"** means the `dist` folder was built from an older version. Run `dir src\sample.ts`: if the file is missing, extract the latest
zip over the folder (keep your `radar.config.json`); then run `npm install` and `npm run build`, and check with
`node dist/src/cli.js --help` that it mentions `serve --sample`.

> **Treat the Slack webhook URL like a password.** Anyone with it can post to your channel. Never paste it into chat, screenshots, or git. If it was
> exposed, remove it and add a new one under your app's **Incoming Webhooks** page.

## Windows notes (PowerShell equivalents)

| Guide says (bash) | PowerShell |
| :-- | :-- |
| `export SLACK_WEBHOOK_URL='...'` | `$env:SLACK_WEBHOOK_URL = '...'` (lasts for that window only; set the others the same way) |
| `export RADAR_DRY_RUN_ACTIONS=0` | `$env:RADAR_DRY_RUN_ACTIONS = '0'` |
| `curl -X POST ... "$SLACK_WEBHOOK_URL"` | `Invoke-RestMethod -Method Post -Uri $env:SLACK_WEBHOOK_URL -ContentType 'application/json' -Body '{"text":"hello from ReleaseRadar setup"}'` (prints `ok`) |
| `curl localhost:3000/health` | `Invoke-RestMethod http://localhost:3000/health` |
| `agentia ... --json > failed-job.json` | Works. Windows PowerShell 5.1 writes UTF-16 for `>`; `triage` reads that. Or use `\| Out-File -Encoding utf8 failed-job.json` |
| `cp a b` | `cp a b` works (alias of Copy-Item) |
| paths in `radar.config.json` | Use forward slashes: `"repoDir": "C:/work/my-sf-repo"` (backslashes must be doubled in JSON) |

**Finding the `agentia` command from ReleaseRadar.** In PowerShell, `agentia` works because npm creates `agentia.cmd`. Node cannot
safely launch a `.cmd` file, so ReleaseRadar reads that shim and runs the JS file it points to. If `doctor` says
"agentia not found or not launchable", point ReleaseRadar at the CLI's JS entry yourself:

```powershell
$entry = Join-Path (npm root -g) '@copado\agentia-cli\bin\run.js'
Test-Path $entry                    # must print True; if not, open the folder and find the run.js / run file
$env:AGENTIA_JS = $entry
node dist/src/cli.js doctor --debug-raw --ai
```
This auto-detection was tested against the npm shim format as I know it, not against your machine, so if it fails the
`AGENTIA_JS` line above is the fix.

## Phase A: Offline smoke test (no Copado, no Slack). Pass: 177 tests pass (1 optional test is skipped), demo prints a failure card

```bash
unzip release-radar.zip && cd release-radar
npm install
npm test          # expect: # tests 178, # pass 177, # skipped 1  (the skipped one is an optional privacy check)
npm run demo      # mock Copado: poll 1 baseline, poll 2 failure card, poll 3 success
```
This proves the engine runs on your machine. The data is a hand-written mock, not a real org.
On Windows, extract the zip with Explorer (Extract All) and run the same `npm` commands in PowerShell or CMD.

## Phase B: Agentia CLI. Pass: `health-check` succeeds

```bash
npm install -g @copado/agentia-cli@beta
agentia setup                                    # interactive; or:
agentia auth set --cicd <API_KEY> --region na    # "na" is the docs example; use your region
agentia auth get --json                          # CICD should show as set (AI too, if licensed)
agentia cicd health-check --json                 # proves the CLI can reach your org
```

## Phase C: Verify the command strings. Pass: `doctor` prints "All good"

The five command strings in `src/agentia.ts` are my best match to the docs and other public Agentia projects. They
are **not verified**. First make sure at least one job exists (run any validation from the Copado UI).

```bash
agentia cicd job --help       # real names for list / get / resume (or run)?
agentia ai agent --help       # real form of "ask"?
cp radar.config.example.json radar.config.json   # or radar.demo.config.json for the mock demo
# edit radar.config.json: "repoDir" = path to your cloned Salesforce repo; leave "users" for later
npm run build
node dist/src/cli.js doctor --debug-raw --ai
```

| doctor says | Do this |
| :-- | :-- |
| `jobList failed` | Fix the name in `radar.config.json`, e.g. `"commands": { "jobList": ["cicd","job","list","--json"] }` using what `--help` shows |
| `no id/status fields were recognised` | The raw JSON printed by `--debug-raw` uses different field names. Add them to the `ID`, `NAME`, `STATUS` lists in `src/agentia.ts`, rebuild |
| `jobGet failed` / `no steps or log text` | Same: fix `commands.jobGet`, or adapt `normalizeDetail` to the JSON you see |
| AI step fails | Not fatal. Rules-only mode works. Check `agentia auth get --json` shows AI set and `commands.aiAsk` |
| `repoDir is not a git repo` | Point `repoDir` at your clone (needed for owner tagging) |

**If you cannot get this green, send me the doctor output and `--debug-raw` JSON (remove secrets).**

### What a healthy `doctor` run looks like (from a real org)
```
1. Agentia job list        OK    25 job(s); first: SFDX Deploy (validation) · P-9001 [JE-900009] [Successful]
2. Agentia job detail      OK    job a7q...: 2 step(s), N chars of log
                           OK    failure evidence understood: ... [log-text]          (when you pass a FAILED job id)
4. Slack + repo            note  repoDir is not a git repo (optional)
```
`repoDir` is **optional**: the story comes from Copado's own data (job `dataJson` and the function log). Set it only if you want the
last committer named too. `doctor` only says "understood" when something was actually classified, not for unrecognised text.

## Phase D: Triage a real failure. Pass: you see root causes, not "No known pattern matched"

Copado's failed deployment job has a **Result record** (open the job execution, then its Result). It carries three artifacts.
Download them (Files tab: `ValidationResult.json`; Output Data / Logs: `ResultViewer.json`; the function log text) into a
folder **outside your git repo**, for example `my-evidence/`, then:

```bash
node dist/src/cli.js triage my-evidence --show        # a folder, or list the files one by one
```
Expected: `--show` lists the recognised formats (`deploy-report`, `copado-result`, `copado-function-log`) and error counts, then
the headline (for example "261 errors from 7 root causes"), each root cause with its count, the story id, and the next step.
Real artifacts contain repository names, org users and class names: do not commit them or show them in a public demo.

**Automatic path (no manual download).** Find the failed deployment job, fetch it, and see whether the CLI already returns the
evidence:
```bash
agentia cicd job list --json                         # note the failed deployment job id
agentia cicd job get <id> --json > failed-job.json   # keep out of git
node dist/src/cli.js triage failed-job.json --show
node dist/src/cli.js doctor --job <id>               # step 2 tells you if failure evidence was understood
```
If `doctor` says the failed job "returned no recognisable error data", the CLI output does not include the artifacts. Run
`agentia cicd --help` and tell me which command groups exist (something like `result` or `files` would let me fetch them);
until then use the downloaded files above.

### If `triage` still says "No known pattern matched"
1. Run with `--show`. If "formats recognised" is `none` or the free text is empty, the file does not hold the error output
   (wrong job? a validation creates a promote/merge job and a separate deployment job; errors are in the deployment job).
2. If the text shows error lines in a layout the tool does not know, add a rule **without touching code**: copy
   `triage-rules.example.json` to `triage-rules.json`, adapt the pattern, and re-run (no rebuild). Or send me 5-10 lines.

**A known-good failing component for the demo.** `demo-components/` has a compile error and a failing test. Sandbox pipeline and a
throwaway story only. Better still, use a real failure from your own sandbox: it gives the most convincing demo.

## Phase E: Live watch in the terminal. Pass: a new failure prints a card within one interval

```bash
node dist/src/cli.js watch --notifier console --ai --interval 10
```
Trigger another failing validation. Jobs that already failed before you started are **not** announced (baseline);
use `--include-existing` to see them (a real org will show every recent failure at once). Stop with Ctrl+C.

**What gets announced.** Failures of *any* job are announced, and by default so is every kind of **success**, with wording that fits the job:
"Validation succeeded", "Deployment succeeded: US-... successfully deployed to <environment>", "Promotion step completed",
"Commit succeeded", "Quality check passed". A real pipeline runs several jobs per story, so if the channel gets chatty narrow it in
`radar.config.json`, for example `"successActions": ["PromotionDeployment"]`. Add `"destinations": { "qa1": "QA1 sandbox" }`
so the message names the environment instead of the branch. See README, "What gets announced".

## Phase F: Slack from scratch (nothing to install)

You do **not** need the Slack desktop app. The browser version is enough.

> **Confidentiality.** A real failure card contains your project's class, field and story names. Do not post those into a personal
> Slack workspace unless your employer allows it. For testing, screenshots and the demo video use **sample mode** below: it posts
> cards with invented names.

**1. Get a workspace and a channel.** In a browser go to slack.com and create a free workspace (or use one you already belong to and may
add apps to). Create a channel such as `#release-radar-test`. (Slack changes its sign-up screens from time to time; the goal is just
"a workspace and a channel I control".)

**2. Create the app.** Open api.slack.com/apps, click **Create New App**, choose **From scratch**, name it `ReleaseRadar`, pick your workspace.

**3. Turn on an incoming webhook.** Left menu **Incoming Webhooks**, switch it **On**, click **Add New Webhook to Workspace**, choose your test
channel, **Allow**, then copy the webhook URL (it starts with `https://hooks.slack.com/services/`). Treat it like a password.

**4. Test the webhook alone** (PowerShell; the variable lasts only for this window):
```powershell
$env:SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/...'
Invoke-RestMethod -Method Post -Uri $env:SLACK_WEBHOOK_URL -ContentType 'application/json' -Body '{"text":"hello from ReleaseRadar setup"}'
```
It prints `ok` and the message appears in your channel.

**5. Post the sample cards** (invented data, no Copado needed):
```powershell
node dist/src/cli.js serve --sample
```
Six cards appear, one for every event: commit succeeded, validation succeeded, validation failed, deployment succeeded, deployment failed and commit failed, each with the buttons that fit it. The buttons that call back (Recommended fix, Commit, Re-run) will not
work yet (that is Phase G); the link buttons only open pages. Press Ctrl+C to stop.

**6. Optional: get @-mentions.** In Slack (web) click your profile picture, **Profile**, the **⋮** menu, **Copy member ID** (looks like `U0123ABCD`).
Put it in `radar.config.json` as the default owner, mentioned for every story, with no per-story setup:
```json
{ "defaultOwner": "U0123ABCD" }
```
Story and destination names need no configuration at all: they come from Copado's job data. To ping a different person for one story add
`"storyOwners": { "US-0000123": "U0456EFGH" }`. See README, "Who gets mentioned".

**7. Real jobs to Slack** (only if allowed to post that data there):
```powershell
node dist/src/cli.js watch --notifier slack --interval 15
```
Do not use `--include-existing` with Slack; it would post your whole recent history.

## Phase G: Buttons in Slack

Buttons need Slack to call your computer, so you need a public URL for a few minutes. Use the **same Slack app** as in Phase F.

**1. Signing secret.** In your app: **Basic Information**, **App Credentials**, **Signing Secret**, Show, copy it.

**2. A tunnel.** Install ngrok (free account): `winget install ngrok.ngrok`, then `ngrok config add-authtoken <your token from the ngrok dashboard>`. If ngrok shows `502` or error `8012` later, ReleaseRadar is not running on port 3000; if it shows `ERR_NGROK_3200` the tunnel itself is offline. Use `ngrok http 127.0.0.1:3000` if `localhost` resolves to IPv6 on your PC.
If ngrok is blocked on your network, Cloudflare's `cloudflared tunnel --url http://localhost:3000` also works without an account.
In a **second PowerShell window** run `ngrok http 3000` and copy the `https://....ngrok-free.app` address it shows.

**3. Tell Slack where to call.** In your app: **Interactivity & Shortcuts**, switch **On**, set **Request URL** to
`https://<your-ngrok-address>/slack/actions`, **Save Changes**. A free ngrok address changes every time you restart ngrok, so update this each session.

**4. Start ReleaseRadar** (keep **both** windows open while testing; closing either one stops the buttons) in the first window (the variables must be set in this same window):
```powershell
$env:SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/...'
$env:SLACK_SIGNING_SECRET = '<the signing secret>'
node dist/src/cli.js serve --sample
```
Check it is reachable: `Invoke-RestMethod http://localhost:3000/health` prints `ok`.

**5. Click the buttons in the sample card.** Sample mode forces every action to **dry run**, so nothing real can happen.

| Button | First click (defaults) | After you enable it in `radar.config.json` |
| :-- | :-- | :-- |
| Open pull request, Validate in Copado, Promote in Copado | Open a page in your browser (sample mode uses placeholder addresses) | same |
| Recommended fix | A reply only you can see, with the root causes | same |
| Commit 3 missing components to US-0000777 | "disabled in this deployment" | Add `"allowCommitMissing": true` and your member id in `"allowedUsers"`, restart: shows "Dry run: would commit 3 components...", with the exact command |
| Re-run job | "Re-run is disabled" | Add `"allowActions": true` and `"allowedUsers"`: "Dry run: would ask Copado to re-run job..." |

A click by someone who is not in `allowedUsers` is refused. Buttons on a card stop working after ReleaseRadar restarts ("no longer tracked"): post a fresh card.

**6. Real jobs with buttons:** `node dist/src/cli.js watch --serve --notifier slack`. The `--serve` flag is what makes the buttons answer; without it the cards still post but the callback buttons do nothing. For the Copado link buttons set `"orgUrl"`, and for **Open pull request** set `"pullRequestLinks": true` (see README, "Buttons by event"). Leave `dryRunActions` at its default until you have verified the commit
and re-run commands (see Phase H).

## Phase H: The "commit missing components" button
Read README, "Fix button", first. It writes to Copado, so it is **off by default** and starts as a **dry run**.

1. **Check the flags.** `node dist/src/cli.js doctor --commit-help` prints the whole of `agentia cicd cloud commit --help`. The default
   `commands.commitMissing` already follows it, and has been run live: the story is positional and must be its **Copado record id** (`a93...`),
   not `US-...`; one call per component with `--metadata-type` / `--metadata-name`; and `--metadata-category SFDX` is required. The record id
   comes from the job data; if a job lacks it, add `"storyIds": { "US-...": "a93..." }` to `radar.config.json`
   (find it with `SELECT Id FROM copado__User_Story__c WHERE Name = 'US-...'`).
2. **Plan from the terminal (commits nothing):** `node dist/src/cli.js commit-missing --job <failed-deploy-job-id>`.
   Check the story, the component list and the command. Standard fields and picklist values are never included.
3. **Enable it for Slack, still dry run:** in `radar.config.json` set `"allowCommitMissing": true` and put your Slack member id in
   `"allowedUsers"`. Restart `watch --serve`. A failure caused by missing fields now has a **Commit N missing components to US-...**
   button; clicking it shows the exact command and commits nothing.
4. **Go live on a sandbox story only** (cloud-flow stories only; the fields must exist in the story's source org):
   `node dist/src/cli.js commit-missing --job <id> --run`, or `RADAR_DRY_RUN_ACTIONS=0` for the Slack button. Then re-validate the promotion.

If Copado rejects the commit (for example the field is not in the source org), the error is shown and you can retry.

### Phase H, continued: re-validate and the live buttons
After a commit the right "re-run" is a **new validation** (re-running the old failed job would not include the new commit). In short:
**Re-run** = `job resume` (resumes the outstanding steps of the same job). **Re-validate** = `cloud promote ... --recreate-promotion-branch --deploy` (re-creates the validation promotion and validates again). Both defaults follow the real `--help`; see README, "Re-run vs re-validate". Copado can refuse Re-validate with `PRO-056` when the story has unresolved issues; if so set `"commands": { "revalidate": null }` to hide the button.

1. **Look at the real flags if you want to check them:** `node dist/src/cli.js cli-help cicd cloud promote`, `... cli-help cicd job resume`.
2. **Plan a re-validation (nothing is started):** `node dist/src/cli.js revalidate --job <failed-validation-job-id>` (one word, no hyphen). It only works for jobs that were validations; a real deployment is refused on purpose.
3. **Try it for real on a sandbox story:** `node dist/src/cli.js revalidate --job <id> --run`, or all in one: `commit-missing --job <id> --run --revalidate`. It waits for the promotion and deployment (up to about 15 minutes).
4. **Slack buttons for real jobs.** Keep everything dry except what you have verified. For the commit button only:
   ```json
   { "defaultOwner": "U0123ABCD", "allowedUsers": ["U0123ABCD"], "allowActions": true, "allowCommitMissing": true, "liveActions": ["commit"] }
   ```
   then `node dist/src/cli.js watch --serve --notifier slack` (same window as the Slack variables). The start-up line shows `commit-missing LIVE`, `re-validate DRY-RUN`, `re-run DRY-RUN`.
   Add `revalidate` (then `rerun`) to `liveActions` once a CLI `--run` has worked for you. Real cards contain project names: post them to Slack only if your employer allows it.

## Phase I: Publish the repository (hackathon submission)
1. On github.com create a **Public** repository named `agentia-release-radar`. Leave "Add a README", `.gitignore` and licence **unticked** (the project already has them).
2. In the project folder: `git init`, `git add .`, then **`git status`** and read the list. It must **not** show `node_modules`, `dist`, `radar.config.json`, `.env`, `failed-job*.json`, `my-evidence/`, or any real Copado file.
3. `git commit -m "ReleaseRadar: Copado ChatOps in Slack, built on the Agentia CLI"`, `git branch -M main`, `git remote add origin https://github.com/<you>/agentia-release-radar.git`, `git push -u origin main`.
4. Open the repository link in a private/incognito window. If you can see the code without signing in, it is public.
5. Never push your Slack webhook URL, signing secret, ngrok authtoken or a real `radar.config.json`. If one ever leaks, replace it at once (Slack: remove the webhook and regenerate the signing secret; ngrok: reset the authtoken).

## Phase J: Collect evidence for the submission
Use **sample mode** for anything public (it has invented names): screenshot the six sample cards, the private reply from **Recommended fix**, the commit and re-run replies, `npm test` passing, and the start-up line with `re-run LIVE`. Keep real project data out of screenshots and the demo video. Update the README "Verification status" to what you actually ran.

## Troubleshooting

| Symptom | Cause / fix |
| :-- | :-- |
| `agentia: command not found` / `agentia not found or not launchable` | Global npm bin not on PATH (check `npm prefix -g`), or on Windows see "Finding the agentia command" above and set `AGENTIA_JS` |
| `npm install` fails | Offline or proxy. Phase A needs network once for typescript and @types/node |
| `triage` prints garbage or `No known pattern` on a file you saved on Windows | Re-save with `\| Out-File -Encoding utf8 failed-job.json`, or check you ran `agentia ... get <id> --json` and not the human-readable form |
| `doctor`: returned 0 jobs | Run a validation in Copado first, or the command lists a different scope; check `--help` |
| No card for a job that already failed | By design (baseline). Use `--include-existing`, or create a new failure while `watch` runs |
| Card says "no recognizable error pattern" | Your log format is new: use `triage failed-job.json` and add a rule in `src/triage.ts` |
| `connect ETIMEDOUT` (or ECONNRESET) from a command | A network problem reaching Copado's API (VPN, proxy, firewall), not a ReleaseRadar error. Retry, check your connection to the Copado API, then re-run. ReleaseRadar never retries a commit by itself |
| `Invalid id: US-...` on the commit | The commit command needs the story's record id (`a93...`), not its name. The default already uses `{storyId}`; if you overrode `commands.commitMissing`, put `{storyId}` back |
| The cards print in the terminal but nothing reaches Slack | `SLACK_WEBHOOK_URL` is not set in **this** window (each new window needs it again). The tool now prints a `NOTE:` saying so. Check with `echo %SLACK_WEBHOOK_URL%` (cmd; it prints the literal `%SLACK_WEBHOOK_URL%` if unset; do not paste the value anywhere) or run with `--notifier slack` to turn it into an error |
| Slack: `Slack responded 404` / `403` / `invalid_token` | The webhook was deleted or revoked (for example after you replaced it): use the new URL from your app's Incoming Webhooks page |
| Buttons do nothing or Slack shows an error on click | Watch the terminal running ReleaseRadar: each click prints `Slack button click received -> HTTP <code>`. **Nothing printed** = Slack is not reaching you (ngrok not running, the Request URL missing `/slack/actions`, an old ngrok address, Interactivity not saved, or a different Slack app from the webhook). **503** = `SLACK_SIGNING_SECRET` not set in that window. **401** = wrong signing secret, or this PC's clock is off by more than 5 minutes. **200** = it worked. ngrok's own page at `http://127.0.0.1:4040` lists the same requests |
| Button click shows a 404 or 502 in Slack | 404: ngrok is offline (`ERR_NGROK_3200`) or the Request URL path is wrong. 502 (ngrok error 8012): ReleaseRadar is not running on port 3000, for example `watch` was started without `--serve` |
| Server log / ngrok shows `401` | `SLACK_SIGNING_SECRET` not exported in the shell running `watch --serve`, or the machine clock is off by more than 5 minutes |
| "That job is no longer tracked" | The radar restarted since the card was posted (state is in memory). Trigger a new alert |
| `@mention` does not ping | `users` needs the member ID (`U...`) and an email matching the git commit email (or the git author name) |
| No owners listed | `repoDir` is not your repo, or the log names components that do not match file names |
| AI summary missing | AI not configured (`agentia auth get --json`) or `commands.aiAsk` differs. Rules-only output still works |

## Optional: guard against leaking client names into the repo
Create an untracked file `.denylist.local` (one token per line: your client's name, repo name, org prefix, user names).
`npm test` then fails if any shipped fixture contains one of them. The file is git-ignored; never commit it.
