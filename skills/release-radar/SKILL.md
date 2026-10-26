---
name: release-radar
description: Use when asked about the state of Copado pipeline jobs, why a validation/promotion/deployment job failed, or who should fix it. Runs ReleaseRadar, which reads jobs through the Agentia CLI, extracts the failing components from the logs, and finds the likely owner.
---

# ReleaseRadar

## Get the current picture (read-only)

```bash
release-radar once --include-existing --notifier json
```

stdout is JSON: `{ "failures": [ { job, triage, owners } ], "info": [ ... ] }`. Progress goes to stderr.

- `triage.findings[]`: one entry per **root cause** (`category`, `component`, `line`, `message`, and `count` / `affects` when many
  errors share it), e.g. 261 compile errors that all come from 5 missing fields.
- `triage.errorCount`: individual errors before grouping. `triage.stories`: component to user story id (from Copado's own list).
- `triage.source`: `rules`, or `ai+rules` when `--ai` was used. AI text is a suggestion, not a fact.
- `owners[]`: the story for each failing component and, when a repo is configured, the last committer (a heuristic, not an assignment).

Add `--ai` only when the user wants a plain-English explanation and the Agentia AI agent is configured.

## How to report

1. Lead with the headline (`triage.headline`), then the 2-3 most important findings with component and line.

3. Name the story id. If you name a person, say it is the last committer, not "responsible".
4. Offer the next step from `triage.explanation`. Say clearly if it is AI-generated.

## Guardrails

- Never commit, re-validate, re-run, resume or cancel anything on your own. `release-radar commit-missing --run` and the Slack buttons write to Copado and are for a human to use.
- Never re-run, resume or cancel a job on your own. Re-run exists only as a Slack button gated by an allow-list;
  if the user wants it, tell them to use that button.
- Do not paste raw logs into chat; summarize. Logs can contain secrets (ReleaseRadar redacts what it sends to AI,
  but not the original job log in Copado).
- If `failures` is empty, say so; do not invent a cause. If a finding has category `other`, say the pattern was
  not recognized and point to the job log in Copado.
- If `release-radar doctor` reports problems, fix the configuration first instead of guessing.
