# Architecture write-up: Inbox-to-Action Digest

*(Draft. Replace the bracketed parts with your own real experience before you submit.)*

## What I built
A web app that turns messy meeting notes or email threads into a task list. The main feature is a live "How it works" diagram. Each node is a real pipeline step, and it changes color as that step runs. Clicking a node shows what it did, how long it took, how many attempts it needed, and any error.

## Architecture
- **Frontend:** one static page. It opens a Server-Sent Events stream for a run and updates the diagram from each event.
- **Server (Node + Express):** creates a run, executes a 5-step pipeline in the background, and streams progress.
- **Database (Postgres):** `runs` holds the input, status and result. `run_steps` holds one row per step per run: status, attempts, timestamps, duration, summaries, saved output, error.

The key design choice is that **the database is the source of truth for the diagram**. The live stream is just a notification. Because of that, the same data powers the live view, the run history, replay for late viewers, and crash recovery.

## Failure handling
| Failure | Response |
|---|---|
| Invalid input | Fail at step 1 with a clear message. No retry, because retrying cannot help. |
| AI call times out or errors | Retry up to 3 times with exponential backoff. Each retry shows on the diagram. |
| AI still failing | Fall back to a rule-based extractor. The step is marked *degraded*, not hidden. |
| Server restarts mid-run | On boot, runs with status `running` resume from the first step with no saved output. |
| Browser closes or reloads | The run continues on the server. Reopening replays saved steps. |

## Tradeoffs I chose
- **In-process pipeline instead of a job queue.** Simpler to build and explain. The cost is that a deploy during a run interrupts it, which the resume logic then repairs. At larger scale I would move to a queue with workers.
- **SSE instead of WebSockets.** Traffic is one-way (server to browser), SSE reconnects on its own and works over plain HTTP.
- **Rule-based fallback instead of an error.** The result is lower quality, but the user keeps a usable answer, and the diagram is honest about it.
- **Idempotent step writes.** Steps are upserted by `(run_id, name)`, so a retry or resume never creates duplicates.

## A failure I hit and how I fixed it
*[Write your own here. Examples that are realistic for this design: the diagram showing stale state after a page reload (fixed by replaying saved steps on connect); duplicate tasks after a retry (fixed by dedupe in step 4); a resumed run repeating finished work (fixed by skipping steps that already have saved output). Describe how you found it, what you changed, and how you tested the fix.]*

## What I would do next
- Per-step timeouts and a "retry from this step" button
- Job queue with worker processes
- Tests that inject failures into each step automatically
- Export to CSV and calendar files

## 30-second interview version
"It's a task extractor where the architecture diagram is the product. Every step is persisted with status and timing, so the same data drives the live view, history and crash recovery. The AI step retries with backoff and then degrades to a rule-based fallback instead of failing, and finished steps are never redone after a restart."
