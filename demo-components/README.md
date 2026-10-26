# Demo components (deliberately broken, for testing ReleaseRadar)

Use a **sandbox pipeline and a throwaway user story only**. Never promote these. Delete or revert them afterwards.

| Folder | What it triggers | Needs |
| :-- | :-- | :-- |
| `compile-error/` | An Apex **compile error** (`Variable does not exist: undefinedVar`) in the check-only deployment | Nothing special: compile errors always fail a validation |
| `failing-test/` | A failing **Apex test** (`System.AssertException ... Expected: 4, Actual: 5`) | The validation must actually run tests (depends on your pipeline's test level) |

Start with `compile-error/`.

1. Copy the files into your repo's Apex classes folder (match your repo layout, usually `force-app/main/default/classes/`).
2. Commit them on a test story's branch and run a validation (Copado UI, or `agentia cicd work submit`).
3. The validation creates two jobs: a promote/merge job and a **deployment (check-only)** job. The compiler errors are in the
   deployment job. Find it with `agentia cicd job list --json`.
4. `agentia cicd job get <deployment-job-id> --json > failed-job.json`
5. `node dist/src/cli.js triage failed-job.json --show`  (or download the Result record artifacts and `triage` the folder; see SETUP-GUIDE Phase D)
