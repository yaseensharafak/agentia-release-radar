# Testing ReleaseRadar end to end (Slack + ngrok)

Do the parts in order. Part 1 to 5 need **no Copado**: you test every card and button with invented sample data.
Part 6 repeats it with your real Copado jobs.

Time needed: about 30 minutes the first time.

---

## What you will have at the end

A Slack channel that receives a card for every event, with the right buttons:

| Event | Card shows these buttons |
| :-- | :-- |
| Commit succeeded | **Open pull request ↗** (the story's branch), **Validate in Copado ↗** (opens the story) |
| Commit failed | Recommended fix, **Re-run job** |
| Validation succeeded | **Open pull request ↗**, **Promote in Copado ↗** (opens the promotion) |
| Validation failed | Recommended fix, **Commit N missing components to US-…**, **Re-run job** |
| Deployment succeeded | **Open pull request ↗**, **Validate next environment ↗** (opens the story) |
| Deployment failed | Recommended fix, **Commit N missing components to US-…**, **Re-run job** |

Buttons ending in **↗** only open a page. They never start anything. **Re-run job** and **Commit missing components**
are the two that act, and only for people on `allowedUsers`.
A button is left out when the link it needs is unknown, so there are no dead buttons.

---

## Part 1: One-time setup (Slack app)

1. Open https://api.slack.com/apps and sign in to your workspace.
2. **Create New App** -> **From scratch** -> name it `ReleaseRadar`, pick the workspace -> **Create App**.
3. **Incoming Webhooks** (left menu) -> switch **Activate Incoming Webhooks** to **On** ->
   **Add New Webhook to Workspace** -> choose the channel (use a private test channel) -> **Allow**.
   Copy the **Webhook URL** (starts with `https://hooks.slack.com/services/`). Keep it secret.
4. **Basic Information** -> **App Credentials** -> **Signing Secret** -> **Show** -> copy it. Keep it secret.
5. Find your own **Slack member ID**: in Slack click your profile picture -> **Profile** -> the **⋮** menu ->
   **Copy member ID** (looks like `U0XXXXXXXXX`). It must match `allowedUsers` in `radar.config.json`.
6. Leave the Slack tab open. You come back for **Interactivity** in Part 3.

> Real cards contain project and story names. Post them to Slack only if your employer allows it.
> The sample cards in Parts 4 and 5 use invented data.

## Part 2: Install ngrok (Windows)

ngrok gives your PC a public https address so Slack can reach the button server running on your laptop.

1. Create a free account at https://ngrok.com and sign in.
2. Install ngrok. Either download it from https://ngrok.com/download and unzip `ngrok.exe` to a folder, or run:
   ```
   winget install ngrok.ngrok
   ```
3. On the ngrok dashboard open **Your Authtoken** and copy it. In a new cmd window run:
   ```
   ngrok config add-authtoken <paste-your-token>
   ```
   (If `ngrok` is "not recognized", close and reopen cmd, or run it from the folder where `ngrok.exe` is.)
4. Start the tunnel and **leave this window open**:
   ```
   ngrok http 3000
   ```
5. In that window find the line starting with **Forwarding**, for example
   `https://a1b2-203-0-113-9.ngrok-free.app -> http://localhost:3000`. Copy the **https** address.
   Your Slack Request URL is that address plus `/slack/actions`:
   ```
   https://a1b2-203-0-113-9.ngrok-free.app/slack/actions
   ```

Good to know:
- A free ngrok address **changes every time you restart ngrok**. After a restart, paste the new URL into Slack again (Part 3).
  ngrok's dashboard may offer a free fixed domain; see their current docs if you want one.
- Open http://127.0.0.1:4040 in your browser to see every request that reaches ngrok. It is the quickest way to debug clicks.

## Part 3: Tell Slack where the buttons go

1. Back in your Slack app page: **Interactivity & Shortcuts** -> switch **Interactivity** to **On**.
2. **Request URL**: paste `https://<your-ngrok-address>/slack/actions` -> **Save Changes**.

## Part 4: Start ReleaseRadar in sample mode

Open a **new** cmd window (a third one; keep ngrok running in the other).

```
cd C:\Users\User\Downloads\release-radar
npm install
npm test
set SLACK_WEBHOOK_URL=<your webhook url>
set SLACK_SIGNING_SECRET=<your signing secret>
node dist/src/cli.js serve --sample
```

Notes for cmd: do not put quotes around the values. If you use PowerShell, write
`$env:SLACK_WEBHOOK_URL = '...'` instead of `set`.

You should see, in this window:

```
[radar] Slack actions endpoint: POST :3000/slack/actions (... re-run DRY-RUN, ... commit-missing DRY-RUN)
[radar] sample cards SENT TO SLACK (invented data; actions are forced to dry run). Click the buttons in Slack.
```

`DRY-RUN` is correct here: in sample mode **nothing real can ever run**, even if `liveActions` is set.

Quick checks before opening Slack:
- Open `http://localhost:3000/health` in a browser. It shows `ok`.
- Open `https://<your-ngrok-address>/health`. It should also show `ok` (ngrok may show a one-time "Visit site" page first; click through it).

## Part 5: Check every card and button in Slack

Six cards arrive in your channel. Check each:

| Card | Click | Expected |
| :-- | :-- | :-- |
| **Commit succeeded** | **Open pull request ↗**, **Validate in Copado ↗** | Open browser tabs (placeholder addresses in sample mode). Nothing appears in Slack. |
| **Validation succeeded** | **Open pull request ↗** | Opens a GitHub compare page address (placeholder in sample mode). |
| | **Promote in Copado ↗** | Opens a browser tab. |
| **Validation failed** | **Recommended fix** | A private message (only you see it) with the causes. |
| | **Commit 3 missing components to US-0000777** | A confirmation dialog listing the components. After **Commit**: private message starting `Dry run: would commit 3 components...` |
| | **Re-run job** | Confirmation dialog, then `Dry run: would ask Copado to re-run job ...` |
| **Deployment succeeded** | **Open pull request ↗**, **Validate next environment ↗** | Open browser tabs. |
| **Deployment failed** | same buttons as *Validation failed* | same replies |
| **Commit failed** | **Recommended fix**, **Re-run job** | Only these two (no "commit missing", it does not apply). Re-run replies with the dry-run message. |

If a click is answered with a message, ReleaseRadar works end to end.
The terminal prints a line per click: `[radar] Slack button click received -> HTTP 200`.

**Troubleshooting** (match what you see):

| What you see | Cause and fix |
| :-- | :-- |
| Slack shows a small warning triangle after a click, no message | Slack cannot reach you. Is `ngrok http 3000` still running? Did the ngrok address change? Paste the new Request URL (Part 3). Check http://127.0.0.1:4040. |
| Terminal: `HTTP 401 (signature mismatch...)` | Wrong `SLACK_SIGNING_SECRET`, or your PC clock is off by more than 5 minutes. |
| Terminal: `HTTP 503` or a WARNING about the signing secret | `SLACK_SIGNING_SECRET` was not set in **this** cmd window. Set it and restart. |
| "You are not on the allow-list" | `allowedUsers` must contain **your** member ID (Part 1, step 5). |
| "Re-run is disabled" | `allowActions` must be `true` in `radar.config.json`. |
| "That job is no longer tracked" | You restarted ReleaseRadar. Old cards stop working; use cards posted after the restart. |
| No cards in Slack, text printed in the terminal instead | `SLACK_WEBHOOK_URL` was not set in this window. |
| Re-run button missing on real failure cards | `allowActions` is false. The button is hidden when it cannot work. |

## Part 6: Test with real Copado jobs

1. Stop sample mode (Ctrl+C). Keep ngrok running.
2. Make sure `agentia` works: `agentia cicd job list --json` prints jobs.
3. Check `radar.config.json`:
   ```json
   {
     "defaultOwner": "<your member id>",
     "allowedUsers": ["<your member id>"],
     "allowActions": true,
     "allowCommitMissing": true,
     "liveActions": ["commit", "rerun"],
     "pullRequestLinks": true,
     "orgUrl": "https://<your-org>.my.salesforce.com",
     "commands": { "revalidate": null }
   }
   ```
   - `liveActions` decides what is **real**. Leave it as `[]` while you only want to look: every click then stays a dry run.
   - `orgUrl` (https, no trailing slash) is what makes the Copado ↗ buttons appear.
   - `pullRequestLinks` adds the **Open pull request ↗** button (one extra read-only lookup per card).
4. Start the radar with the button server:
   ```
   cd C:\Users\User\Downloads\release-radar
   set SLACK_WEBHOOK_URL=<your webhook url>
   set SLACK_SIGNING_SECRET=<your signing secret>
   node dist/src/cli.js watch --serve --include-existing
   ```
   The start-up line should say `re-run LIVE` and `commit-missing LIVE` (or `DRY-RUN` if you left `liveActions` empty).
   `--include-existing` also announces jobs that are already failed or finished, so you get cards immediately.
5. In Copado run a commit, a validation, a deployment. Each event produces its card within about 20 seconds.
6. Safe real test of **Re-run job**: click it on a failed job that is safe to resume. The reply shows Copado's answer
   (for example `"status": "In Progress"`). Check the job in Copado.
7. Real test of **Commit missing components**: use a failed validation whose cause is missing custom fields or an Apex
   class. The confirmation dialog lists exactly what will be committed. After it succeeds, validate again **in Copado**.

## What the buttons deliberately do not do

- **Validate / Promote** open Copado. Starting a validation or a real deployment from Slack is not offered, because the
  Agentia CLI has no safe command for it that works without a local git checkout. Opening the right Copado page is one click away.
- **Quality gates** already run inside every validation (the "Run PMD" jobs); ReleaseRadar announces their result.
- The **next environment's name** is not part of the data Copado returns for a job, so the buttons say "next environment".

## Demo script (3 minutes)

1. `serve --sample` -> six cards appear.
2. Show a failed validation: *Recommended fix* (plain-English cause), then *Commit 3 missing components* (confirmation lists them, dry run reply).
3. Show a succeeded validation: *Open pull request* and *Promote in Copado* jump straight to the next step.
4. Say: "Every write action is off by default, limited to named people, dry run first, and only for jobs the radar announced."
