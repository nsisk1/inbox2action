# Inbox-to-Action Digest

Paste messy meeting notes or an email thread and get a clean task list (title, owner, due date). A live **"How it works"** diagram shows each pipeline step as it runs: status, duration, what it did, and how failures were handled.

**Live app:** `[paste your Replit published link here]`

## How it works

```
Browser ──POST /api/runs──▶ Express server ──▶ Pipeline ──▶ Postgres
   ▲                                            │
   └────────── Server-Sent Events ◀─────────────┘ (one event per step change)
```

| # | Step | What it does |
|---|------|--------------|
| 1 | Receive | Validates and stores the input |
| 2 | Clean | Strips quoted replies and signatures, splits text into chunks |
| 3 | Extract | AI call finds action items (retries, then falls back to rules) |
| 4 | Validate | Checks the shape of each task, removes duplicates |
| 5 | Save | Stores the final list on the run |

Every step is written to the `run_steps` table with status, attempts, start/end time, duration, input/output summary and error. The browser draws the diagram from those events.

## Reliability design

- **Retries with backoff:** the AI step gets 3 attempts (0.5s, then 1s wait between).
- **Graceful degradation:** if the AI step still fails, a rule-based extractor produces a result. The step shows as *degraded*, so the user knows the fallback ran.
- **No lost work:** each step's output is saved. On server restart, runs still marked `running` resume from the first unsaved step.
- **Fail fast on bad input:** invalid input fails at step 1 and is not retried.
- **Late joiners:** the event stream replays saved steps first, so reopening a run shows the full diagram.
- **Failure demo:** the "Failure mode" picker simulates a transient error (recovers on try 3) or a hard outage (fallback).

## Run it on Replit

1. Create a new Replit App (Node.js) and upload these files, or paste the prompt from the plan into Agent and then replace its code with these files.
2. Open the **Database** tool and create a Postgres database. `DATABASE_URL` is set automatically.
3. Optional: add a secret `OPENAI_API_KEY` for real AI extraction. Without it, the app uses the rule-based fallback and marks the step *degraded*.
4. Press **Run**, test all three failure modes, then **Publish**.

## Project layout

```
server.js         API, pipeline, retries, SSE, crash recovery
public/index.html UI, live diagram, "How it works" tab
package.json
```

## Ideas to extend

- Export tasks as CSV or an .ics calendar file
- Per-step timeout settings
- A "retry from this step" button on failed runs
- Queue (e.g. a jobs table) so runs survive deploys under load
