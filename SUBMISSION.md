# Hackathon submission text: ReleaseRadar

Agentia Headless Hackathon 2026. The same text that was entered in the submission form, kept here for the judges.

## Submission title
ReleaseRadar: Copado Release Management Inside Slack, with Plain-English Failure Triage and One-Click Fix, Re-run and Next-Step Buttons

## What to try first (two minutes, no Copado org needed)
```
git clone <this repository> && cd agentia-release-radar
npm install && npm test          # 177 tests pass, 1 optional test skipped
set SLACK_WEBHOOK_URL=...        # your own Slack incoming webhook
set SLACK_SIGNING_SECRET=...     # only needed to click the buttons that call back
node dist/src/cli.js serve --sample
```
Six sample cards appear in Slack (commit, validation and deployment, success and failure) with the buttons each event should have.
TESTING-GUIDE.md has the Slack app and ngrok steps. `npm run demo` runs a mock Copado in the terminal with no Slack at all.

## How it maps to the judging criteria
| Criterion | Evidence in this repository |
| :-- | :-- |
| Innovation | Root-cause grouping of Copado failure evidence (one real promotion: 261 errors from 7 causes); event-specific buttons; one-click fix and re-run from chat |
| Impact | Release Management, developers and QA see the same event at once, with the cause, the owner and the next step; no browser tab refreshing |
| Technical execution | 177 automated tests; signature and replay checks; allow-list, dry-run default and per-action live switch; secrets redacted; no shell; zero runtime dependencies |
| Use of Agentia extensibility | `agentia cicd job list/get/resume`, `cicd cloud commit`, `cicd promotion get`, `cicd work status`, `ai agent ask` (optional), all through `--json`; every command string in one overridable table; an Agent Skill (`skills/release-radar/SKILL.md`) |
| Presentation | Demo video, slide deck and a sample mode that anyone can run |

## Honest scope
- Slack only today (a Teams adapter fits the `Notifier` interface). One channel with the story owner tagged.
- **Validate** and **Promote** buttons open the Copado page. The Agentia CLI has no command to start them without a local git checkout.
- The AI summary is optional and was not part of the live run; the cards work with rules only.
- State is in memory: a restart re-baselines, and cards posted before it stop working.
