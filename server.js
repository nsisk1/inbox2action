// Inbox-to-Action Digest — server
// Express + Postgres. A 5-step pipeline that records every step, retries, falls back, and resumes.
const express = require("express");
const { Pool } = require("pg");
const { EventEmitter } = require("events");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|helium/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
});
const bus = new EventEmitter();
bus.setMaxListeners(200);

const STEPS = ["receive", "clean", "extract", "validate", "save"];
const STEP_LABELS = {
  receive: "Receive & validate input",
  clean: "Clean & chunk text",
  extract: "Extract tasks (AI)",
  validate: "Validate & dedupe",
  save: "Save & present",
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      input TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL DEFAULT 'running',
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS run_steps (
      run_id INT REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      idx INT NOT NULL,
      status TEXT NOT NULL,
      attempts INT DEFAULT 0,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_ms INT,
      input_summary TEXT,
      output_summary TEXT,
      output JSONB,
      error TEXT,
      PRIMARY KEY (run_id, name)
    );`);
}

// ---------- step persistence + events ----------
async function saveStep(runId, name, fields) {
  const idx = STEPS.indexOf(name);
  const cols = Object.keys(fields);
  const vals = Object.values(fields).map((v) => (v && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v));
  const sql = `INSERT INTO run_steps (run_id, name, idx, ${cols.join(",")})
    VALUES ($1,$2,$3,${cols.map((_, i) => "$" + (i + 4)).join(",")})
    ON CONFLICT (run_id, name) DO UPDATE SET ${cols.map((c) => `${c}=EXCLUDED.${c}`).join(",")}
    RETURNING run_id, name, idx, status, attempts, duration_ms, input_summary, output_summary, error, started_at, ended_at`;
  const { rows } = await pool.query(sql, [runId, name, idx, ...vals]);
  const evt = { type: "step", label: STEP_LABELS[name], ...rows[0] };
  bus.emit("run:" + runId, evt);
  return evt;
}

// ---------- reliability helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(runId, name, fn, { max = 3, base = 500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await saveStep(runId, name, { status: "running", attempts: attempt, error: null });
      return { value: await fn(attempt), attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < max) {
        await saveStep(runId, name, { status: "retrying", attempts: attempt, error: e.message });
        await sleep(base * 2 ** (attempt - 1)); // exponential backoff
      }
    }
  }
  lastErr.attempts = max;
  throw lastErr;
}

// ---------- step implementations ----------
const impl = {
  async receive({ input }) {
    if (typeof input !== "string" || input.trim().length < 20) throw Object.assign(new Error("Input too short (min 20 chars)"), { fatal: true });
    return { text: input.trim().slice(0, 20000), summary: `${input.trim().length} characters accepted` };
  },

  async clean({ prev }) {
    const lines = prev.receive.text
      .split(/\r?\n/)
      .filter((l) => !/^\s*>/.test(l) && !/^(--|sent from my|best,|thanks,|regards,)/i.test(l.trim()));
    const paras = lines.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let cur = "";
    for (const p of paras) {
      if ((cur + "\n\n" + p).length > 1500 && cur) { chunks.push(cur); cur = p; } else cur = cur ? cur + "\n\n" + p : p;
    }
    if (cur) chunks.push(cur);
    return { chunks, summary: `${chunks.length} chunk(s) from ${paras.length} paragraph(s)` };
  },

  async extract({ prev, mode, attempt }) {
    if (mode === "hard") throw new Error("Simulated outage: AI service unavailable");
    if (mode === "transient" && attempt < 3) throw new Error(`Simulated timeout (attempt ${attempt})`);
    if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error("No OPENAI_API_KEY set"), { noRetry: true });
    const tasks = [];
    for (const chunk of prev.clean.chunks) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.OPENAI_API_KEY },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: 'Extract action items. Reply as JSON: {"tasks":[{"title":string,"owner":string|null,"due":string|null}]}. Only real commitments or requests.' },
            { role: "user", content: chunk },
          ],
        }),
      });
      if (!res.ok) throw new Error("AI service returned " + res.status);
      const data = await res.json();
      tasks.push(...(JSON.parse(data.choices[0].message.content).tasks || []));
    }
    return { tasks, method: "ai", summary: `AI found ${tasks.length} candidate task(s)` };
  },

  // Fallback used when the AI step keeps failing
  async extractFallback({ prev }) {
    const tasks = [];
    const re = /(action|todo|to-do|follow up|will|needs? to|should|please|by (mon|tue|wed|thu|fri|sat|sun|\d))/i;
    for (const chunk of prev.clean.chunks)
      for (const line of chunk.split(/\n|(?<=[.!?])\s+/)) {
        const t = line.replace(/^[-*\d.)\s]+/, "").trim();
        if (t.length < 8 || t.length > 200 || !re.test(t)) continue;
        const owner = (t.match(/^@?([A-Z][a-z]+)\s+(will|to|needs?|should)\b/) || [])[1] || (t.match(/@(\w+)/) || [])[1] || null;
        const due = (t.match(/\bby\s+((?:next\s+)?\w+day|\w+\s\d{1,2}|\d{1,2}\/\d{1,2})/i) || [])[1] || null;
        tasks.push({ title: t, owner, due });
      }
    return { tasks, method: "rules", summary: `Rule-based fallback found ${tasks.length} candidate task(s)` };
  },

  async validate({ prev }) {
    const seen = new Set();
    const clean = [];
    let dropped = 0;
    for (const t of prev.extract.tasks) {
      const title = typeof t?.title === "string" ? t.title.trim() : "";
      const key = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!title || seen.has(key)) { dropped++; continue; }
      seen.add(key);
      clean.push({ title, owner: t.owner || null, due: t.due || null });
    }
    return { tasks: clean, summary: `${clean.length} valid, ${dropped} dropped (invalid or duplicate)` };
  },

  async save({ runId, prev }) {
    const result = { tasks: prev.validate.tasks, method: prev.extract.method };
    await pool.query("UPDATE runs SET result=$2 WHERE id=$1", [runId, JSON.stringify(result)]);
    return { result, summary: `Saved ${result.tasks.length} task(s)` };
  },
};

// ---------- pipeline (resumable) ----------
async function runPipeline(runId) {
  const { rows: [run] } = await pool.query("SELECT * FROM runs WHERE id=$1", [runId]);
  const { rows: done } = await pool.query("SELECT name, output, status FROM run_steps WHERE run_id=$1", [runId]);
  const prev = {};
  for (const d of done) if (d.status === "success" || d.status === "degraded") prev[d.name] = d.output;

  try {
    for (const name of STEPS) {
      if (prev[name]) continue; // resume: skip steps already saved
      const started = new Date();
      const ctx = { runId, input: run.input, mode: run.mode, prev };
      const inputSummary = Object.keys(prev).length ? `Uses output of: ${Object.keys(prev).join(", ")}` : "Raw user input";
      await saveStep(runId, name, { status: "running", attempts: 1, started_at: started, input_summary: inputSummary });
      let out, status = "success", attempts = 1, error = null;
      try {
        const r = await withRetry(runId, name, (attempt) => impl[name]({ ...ctx, attempt }), { max: name === "extract" ? 3 : 1 });
        out = r.value; attempts = r.attempts;
      } catch (e) {
        if (name !== "extract" || e.fatal) throw e;
        // graceful degradation
        out = await impl.extractFallback(ctx);
        status = "degraded"; attempts = e.attempts || 1; error = e.message;
      }
      prev[name] = out;
      const ended = new Date();
      await saveStep(runId, name, {
        status, attempts, ended_at: ended, duration_ms: ended - started,
        output_summary: out.summary + (status === "degraded" ? " (fallback used)" : ""), output: out, error,
      });
    }
    await pool.query("UPDATE runs SET status='success', finished_at=now() WHERE id=$1", [runId]);
    bus.emit("run:" + runId, { type: "done", status: "success", result: prev.save.result });
  } catch (e) {
    const failing = STEPS.find((s) => !prev[s]);
    if (failing) await saveStep(runId, failing, { status: "failed", error: e.message, ended_at: new Date() });
    await pool.query("UPDATE runs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [runId, e.message]);
    bus.emit("run:" + runId, { type: "done", status: "failed", error: e.message });
  }
}

// ---------- API ----------
app.post("/api/runs", async (req, res) => {
  const { text, mode } = req.body || {};
  const m = ["none", "transient", "hard"].includes(mode) ? mode : "none";
  const { rows: [run] } = await pool.query("INSERT INTO runs (input, mode) VALUES ($1,$2) RETURNING id", [String(text || ""), m]);
  runPipeline(run.id); // fire and forget; progress is streamed
  res.json({ id: run.id });
});

app.get("/api/runs", async (_req, res) => {
  const { rows } = await pool.query(`SELECT r.id, r.status, r.mode, r.created_at, left(r.input,80) AS preview,
    EXTRACT(EPOCH FROM (r.finished_at - r.created_at))*1000 AS total_ms FROM runs r ORDER BY id DESC LIMIT 15`);
  res.json(rows);
});

app.get("/api/runs/:id", async (req, res) => {
  const { rows: [run] } = await pool.query("SELECT id,status,mode,result,error FROM runs WHERE id=$1", [req.params.id]);
  if (!run) return res.status(404).json({ error: "not found" });
  const { rows: steps } = await pool.query("SELECT name,idx,status,attempts,duration_ms,input_summary,output_summary,error FROM run_steps WHERE run_id=$1 ORDER BY idx", [req.params.id]);
  res.json({ run, steps: steps.map((s) => ({ ...s, label: STEP_LABELS[s.name] })) });
});

app.get("/api/runs/:id/events", async (req, res) => {
  const id = Number(req.params.id);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const listener = (e) => send(e);
  bus.on("run:" + id, listener);
  // replay what has already happened so late joiners see the full diagram
  const { rows: steps } = await pool.query("SELECT name,idx,status,attempts,duration_ms,input_summary,output_summary,error FROM run_steps WHERE run_id=$1 ORDER BY idx", [id]);
  steps.forEach((s) => send({ type: "step", label: STEP_LABELS[s.name], run_id: id, ...s }));
  const { rows: [run] } = await pool.query("SELECT status,result,error FROM runs WHERE id=$1", [id]);
  if (run && run.status !== "running") send({ type: "done", status: run.status, result: run.result, error: run.error });
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(ping); bus.off("run:" + id, listener); });
});

app.get("/api/pipeline", (_req, res) => res.json(STEPS.map((n) => ({ name: n, label: STEP_LABELS[n] }))));

// ---------- boot ----------
const PORT = process.env.PORT || 3000;
init()
  .then(async () => {
    // crash recovery: resume any run that was mid-flight when the server stopped
    const { rows } = await pool.query("SELECT id FROM runs WHERE status='running'");
    rows.forEach((r) => runPipeline(r.id));
    app.listen(PORT, "0.0.0.0", () => console.log("Listening on " + PORT));
  })
  .catch((e) => { console.error("Startup failed", e); process.exit(1); });
