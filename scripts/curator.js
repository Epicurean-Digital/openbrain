#!/usr/bin/env node
/**
 * curator.js
 * Curates memories from a session transcript and writes them to MEMORY.md / MIND.md.
 *
 * Usage:
 *   cat transcript.txt | node curator.js          # reads from stdin (primary)
 *   node curator.js --date 2026-03-25             # reads a specific day's log file
 *
 * Environment:
 *   OPENBRAIN_WORKSPACE  — memory workspace root (required)
 *   ANTHROPIC_API_KEY    — Anthropic API key
 *   DEEPSEEK_API_KEY     — DeepSeek API key (preferred for curation; falls back to Anthropic)
 *   OPENBRAIN_CURATOR_MODEL    — override curator model id
 *   OPENBRAIN_CURATOR_PROVIDER — override curator provider (anthropic|deepseek)
 *   OPENBRAIN_HOT_CACHE_SIZE   — top-N entries for hot cache (default 25)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { execSync }        from "node:child_process";
import { join }            from "node:path";

// ── Config ─────────────────────────────────────────────────────────────────────
const WORKSPACE   = process.env.OPENBRAIN_WORKSPACE
  || join(homedir(), ".openclaw/workspace");
const MEMORY_MD   = join(WORKSPACE, "MEMORY.md");
const MIND_MD     = join(WORKSPACE, "memory/MIND.md");
const WORKINGS_MD = join(WORKSPACE, "memory/WORKINGS.md");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY || (() => {
  try {
    const cfg = JSON.parse(readFileSync(
      join(homedir(), ".openclaw/openclaw.json"), "utf8"
    ));
    return cfg?.models?.providers?.deepseek?.apiKey || null;
  } catch { return null; }
})();

const CURATOR_PROVIDER = process.env.OPENBRAIN_CURATOR_PROVIDER
  || (DEEPSEEK_KEY ? "deepseek" : "anthropic");
const CURATOR_MODEL = process.env.OPENBRAIN_CURATOR_MODEL
  || (CURATOR_PROVIDER === "deepseek" ? "deepseek-reasoner" : "claude-sonnet-4-6");

const FALLBACK_MODEL = "claude-sonnet-4-6";
const TODAY = new Date().toISOString().slice(0, 10);

// ── Args ───────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const dateArg = args.includes("--date") ? args[args.indexOf("--date") + 1] : TODAY;

// ── Helpers ────────────────────────────────────────────────────────────────────
function readFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function parseJsonlTranscript(raw) {
  const lines = raw.split("\n").filter(l => l.trim());
  const turns = [];

  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "message") continue;

    const msg  = d.message || d;
    const role = msg.role;
    if (!role || role === "toolResult") continue;

    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(c => c.type === "text").map(c => c.text || "").join("\n").trim();
    }

    if (!text) continue;

    text = text.replace(/Sender \(untrusted metadata\):[\s\S]*?```\n[\s\S]*?```\n/g, "").trim();
    if (role === "assistant" && text.startsWith("{") && text.includes('"type"')) continue;

    turns.push(`${role === "user" ? "Human" : "Assistant"}: ${text}`);
  }

  return turns.join("\n\n");
}

function cleanPlainTranscript(raw) {
  const lines = raw.split("\n");
  const kept  = [];
  let skip    = false;
  for (const line of lines) {
    if (line.includes("<tool_result>") || line.includes("<function_results>")) { skip = true; }
    if (line.includes("</tool_result>") || line.includes("</function_results>")) { skip = false; continue; }
    if (skip) continue;
    if (line.includes("<system-reminder>") || line.includes("</system-reminder>")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function cleanTranscript(raw) {
  const firstLine = raw.trim().split("\n")[0];
  try {
    const d = JSON.parse(firstLine);
    if (d.type) return parseJsonlTranscript(raw);
  } catch {}
  return cleanPlainTranscript(raw);
}

function capTranscript(text, maxTokens = 5000) {
  if (estimateTokens(text) <= maxTokens) return text;
  const chars = maxTokens * 4;
  return "...[truncated for length]...\n\n" + text.slice(-chars);
}

function countTurns(text) {
  return (text.match(/\b(Human:|Assistant:|USER:|ASSISTANT:)/g) || []).length;
}

// ── API calls ──────────────────────────────────────────────────────────────────
async function callAnthropic(model, system, userMessage) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return { content: data.content[0].text, reasoningContent: null };
}

async function callDeepSeek(system, userMessage) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DEEPSEEK_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CURATOR_MODEL,
      max_tokens: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const msg  = data.choices[0].message;
  return { content: msg.content, reasoningContent: msg.reasoning_content || null };
}

async function callCurator(system, userMessage) {
  if (CURATOR_PROVIDER === "deepseek" && DEEPSEEK_KEY) {
    console.log(`[curator] calling ${CURATOR_MODEL} (deepseek) for curation...`);
    return callDeepSeek(system, userMessage);
  }
  console.log(`[curator] calling ${CURATOR_MODEL} (anthropic) for curation...`);
  return callAnthropic(CURATOR_MODEL, system, userMessage);
}

// ── Curator prompt ─────────────────────────────────────────────────────────────
const CURATOR_PROMPT = `You are the memory curator for a persistent AI brain. Your job is to process a session transcript and update the brain's long-term memory.

Work through the following six steps in order. Be conservative — fewer high-quality entries beats many weak ones.

## STEP 1 — EXTRACT FACTS AND EVENTS

What was established in this session that should persist across future sessions?
Include: decisions made, preferences revealed, facts learned, mistakes made, outcomes of actions.

For each item assign:
- type: semantic|episodic|procedural|emotional|cognitive|metamemory|prospective|spatial
- confidence (0.1–1.0): how certain? Could it be wrong?
- decay: permanent|slow|medium|fast
- trajectory: learning|established|shifting|fading

Skip: things already well-established in existing memory, temporary context, one-off tactical details with no future relevance.

## STEP 2 — UPDATE EXISTING MEMORIES

Review existing memory context for entries this session:
a) Reinforces → increment reinforced count; set trajectory "established" if reinforced ≥ 3
b) Contradicts → reduce confidence 0.1–0.2; set trajectory "shifting"
c) Completes → a prospective memory that was acted on
d) Extends → new info adds to but doesn't replace an existing entry

Output the full updated block for any entry that changed.

## STEP 3 — IDENTIFY REASONING MOVES

What specific reasoning moves were made to solve problems or reach decisions?
A reasoning move is the approach taken — not the conclusion, but the method.

For each: what was the problem, what approach was taken, did it work, what was the outcome?

## STEP 4 — ABSTRACT AND PATTERN-MATCH

For each reasoning move from Step 3:

4a. Abstract it — strip all domain-specific detail. State the move in one sentence that would apply equally in software, business, science, writing, or any other field.

4b. Search existing patterns in the memory context:
  MATCH FOUND → add this instance as a new surface example; increment reinforced; update confidence (+0.05 success, −0.1 failure); add failure case with boundary condition noted.
  NO MATCH → create a new pattern entry: confidence 0.55, reinforced 1.

## STEP 5 — CROSS-DOMAIN SCAN

For each existing pattern with reinforced ≥ 2:
Could this pattern have applied somewhere in this session in a domain NOT already in its domains list?
If yes: add the domain and a retrospective surface example (mark as "retrospective").

## STEP 6 — CONTRADICTION CHECK

Scan for claims, assumptions, or outcomes that contradict existing memory entries — including implicit contradictions where something tried didn't work but memory says it should.

For each: output a [metamemory] entry titled "Agent stated [X] but memory says [Y]". confidence 0.3–0.5, trajectory: shifting, decay: fast.

---

## OUTPUT FORMAT

Output ONLY memory blocks. No preamble, no section headers, no summary. Separate all blocks with a line containing only ---.

Standard memory block:

## [type] Short descriptive title (max 10 words)
- type: semantic|episodic|procedural|emotional|cognitive|metamemory|prospective|spatial
- confidence: 0.0-1.0
- trajectory: learning|established|shifting|fading
- reinforced: N
- last_reinforced: YYYY-MM-DD
- decay: permanent|slow|medium|fast
- tags: [tag1, tag2]

2–4 sentences. Third person. Specific enough to be useful, general enough to apply across sessions.

DESTINATION: MEMORY

---

Pattern block (always DESTINATION: MIND):

## [pattern] kebab-case-id: Human readable name
- type: pattern
- abstract: [one-line domain-free statement — must make sense outside its origin domain]
- confidence: 0.0-1.0
- reinforced: N
- last_reinforced: YYYY-MM-DD
- decay: slow
- domains: [domain-a, domain-b]
- tags: [reasoning-pattern, debugging|decision|communication|diagnosis|design]

**When to apply:**
[Signal words or context clues that indicate this pattern is relevant]

**Surface examples:**
- [domain-a, YYYY-MM-DD]: [Problem + move made + outcome]

**Failure cases:**
- [domain, context]: [Why it failed, what boundary condition was hit]

DESTINATION: MIND

---

Decay defaults: cognitive/procedural → permanent. emotional/semantic/spatial → slow. episodic → medium. metamemory/prospective → fast. pattern → slow.

DESTINATION rules:
- MIND: cognitive, procedural, pattern, [permanent] entries, updates to existing MIND entries
- MEMORY: everything else (new/unconfirmed semantic, episodic, prospective, metamemory)

A pattern with no failure cases is incomplete — do not give it confidence above 0.7 until at least one failure case is documented.

---

FINAL OUTPUT — SESSION INDEX

After all memory blocks, output exactly one session index block. This is written to the session archive for L2 retrieval — make it dense with searchable terms.

## [session-index] YYYY-MM-DD: 5-10 word title capturing the session's main theme
- date: YYYY-MM-DD
- topics: [topic1, topic2, topic3]
- decisions: [decision1, decision2]
- entities: [project names, people, tools, systems mentioned]
- patterns-applied: [pattern-ids if any reasoning patterns were used or created]

2–3 sentences summarising what happened and what was resolved. Specific enough that a keyword search for any entity or topic would find this entry.

DESTINATION: INDEX`;

// ── Memory write helpers ───────────────────────────────────────────────────────
function upsertMindEntries(newBlocks) {
  const content = readFile(MIND_MD);

  const firstEntry = content.indexOf("\n## [");
  const header     = firstEntry > -1 ? content.slice(0, firstEntry) : content;
  const body       = firstEntry > -1 ? content.slice(firstEntry + 1) : "";

  const existing = body
    .split(/\n---\n/)
    .map(s => s.trim())
    .filter(s => s.startsWith("## ["));

  function normalizeTitle(block) {
    const m = block.match(/^## \[[^\]]*\]\s*(.+?)(?:\n|$)/);
    return m ? m[1].toLowerCase().trim() : "";
  }

  const titleMap = new Map(existing.map((s, i) => [normalizeTitle(s), i]));
  let updated    = [...existing];
  let replaced   = 0;
  const toAppend = [];

  for (const block of newBlocks) {
    const title = normalizeTitle(block);
    if (title && titleMap.has(title)) {
      updated[titleMap.get(title)] = block;
      replaced++;
    } else {
      toAppend.push(block);
    }
  }

  const all        = [...updated, ...toAppend];
  const newContent = header.trimEnd()
    + "\n\n"
    + all.join("\n\n---\n\n")
    + (all.length > 0 ? "\n\n---\n" : "");

  writeFileSync(MIND_MD, newContent, "utf8");
  console.log(`[curator] MIND.md: ${replaced} updated, ${toAppend.length} new`);
}

function parseMemoryBlocks(output) {
  const blocks = [];
  const rawBlocks = output.split(/\n---\n/);

  for (const raw of rawBlocks) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("## [")) continue;

    const destMatch   = trimmed.match(/\nDESTINATION:\s*(MEMORY|MIND|INDEX)/);
    const destination = destMatch ? destMatch[1] : "MEMORY";
    const markdown    = trimmed.replace(/\nDESTINATION:\s*(MEMORY|MIND|INDEX)/, "").trim() + "\n\n---";

    blocks.push({ markdown, destination });
  }

  return blocks;
}

async function promoteGraduates() {
  const content = readFile(MEMORY_MD);
  if (!content) return;

  const lines     = content.split("\n");
  const toPromote = [];
  const toKeep    = [];
  let reinforced  = 0;

  for (const line of lines) {
    if (line.match(/^<!--\s*reinforced:\s*(\d+)/)) {
      reinforced = parseInt(line.match(/reinforced:\s*(\d+)/)[1], 10);
    }
    if (line.startsWith("- ") && reinforced >= 3) {
      toPromote.push(line);
      reinforced = 0;
    } else {
      toKeep.push(line);
    }
  }

  if (toPromote.length > 0) {
    const promotionEntries = toPromote.map(entry =>
      `## [semantic] ${entry.replace(/^- /, "").slice(0, 60)}\n- type: semantic\n- confidence: 0.8\n- trajectory: established\n- reinforced: 3\n- last_reinforced: ${TODAY}\n- decay: slow\n- tags: [promoted]\n\n${entry.replace(/^- /, "")}\n\n---`
    );
    appendFileSync(MIND_MD, "\n" + promotionEntries.join("\n") + "\n");
    writeFileSync(MEMORY_MD, toKeep.join("\n"));
    console.log(`[curator] promoted ${toPromote.length} graduate(s) to MIND.md`);
  }

  // Size pressure: trim oldest unreinforced entries if MEMORY.md > 75 content bullets
  const METADATA_FIELDS = /^- (type|confidence|trajectory|reinforced|last_reinforced|decay|tags):/;
  const memContent      = readFile(MEMORY_MD);
  const allBullets      = memContent.split("\n").filter(l => l.startsWith("- "));
  const contentBullets  = allBullets.filter(l => !METADATA_FIELDS.test(l));
  if (contentBullets.length > 75) {
    console.log(`[curator] MEMORY.md has ${contentBullets.length} content entries (>75) — trimming oldest`);
    const toRemove = new Set(contentBullets.slice(0, contentBullets.length - 60));
    const trimmed  = memContent.split("\n").filter(l => !toRemove.has(l)).join("\n");
    writeFileSync(MEMORY_MD, trimmed, "utf8");
    console.log(`[curator] trimmed ${toRemove.size} stale entries from MEMORY.md`);
  }
}

async function runScript(scriptPath) {
  try {
    const env    = { ...process.env };
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8", env });
    if (output.trim()) console.log(output.trim());
  } catch (e) {
    console.error(`[curator] ${scriptPath} failed:`, e.message);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!ANTHROPIC_KEY && !DEEPSEEK_KEY) {
    console.error("[curator] no API key available (ANTHROPIC_API_KEY or DEEPSEEK_API_KEY required) — aborting");
    process.exit(1);
  }

  // 1. Get transcript from stdin (primary) or log file (manual)
  let rawTranscript = "";

  const forceLog   = args.includes("--date") || args.includes("--log");
  const SESSION_DIR = join(homedir(), ".openclaw/agents/codex/sessions");

  if (!forceLog && !process.stdin.isTTY) {
    const rl    = createInterface({ input: process.stdin });
    const lines = [];
    for await (const line of rl) lines.push(line);
    rawTranscript = lines.join("\n");
    console.log("[curator] reading transcript from stdin");
  } else {
    let sessionFile = null;

    const sessionIdx = args.indexOf("--session");
    if (sessionIdx !== -1 && args[sessionIdx + 1]) {
      sessionFile = join(SESSION_DIR, args[sessionIdx + 1] + ".jsonl");
    }

    if (!sessionFile && existsSync(SESSION_DIR)) {
      const { readdirSync, statSync } = await import("node:fs");
      const files = readdirSync(SESSION_DIR)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => ({ f, mtime: statSync(join(SESSION_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      const todayMs    = new Date(dateArg + "T00:00:00").getTime();
      const tomorrowMs = todayMs + 86400000;
      const todayFile  = files.find(({ mtime }) => mtime >= todayMs && mtime < tomorrowMs);
      if (todayFile) sessionFile = join(SESSION_DIR, todayFile.f);
      else if (files.length) sessionFile = join(SESSION_DIR, files[0].f);
    }

    if (sessionFile && existsSync(sessionFile)) {
      rawTranscript = readFile(sessionFile);
      console.log(`[curator] reading from ${sessionFile}`);
    } else {
      console.log("[curator] no session transcript found — running self-heal only");
      await runScript(join(import.meta.dirname, "self-heal.js"));
      return;
    }
  }

  // 2. Clean and cap
  const cleaned = cleanTranscript(rawTranscript);
  const turns   = countTurns(cleaned);
  const tokens  = estimateTokens(cleaned);

  console.log(`[curator] transcript: ${turns} turns, ~${tokens} tokens`);

  if (turns < 5 || tokens < 2000) {
    console.log("[curator] session too short — skipping curation");
    await runScript(join(import.meta.dirname, "self-heal.js"));
    return;
  }

  const capped = capTranscript(cleaned);

  // 3. Load existing memory context
  const existingMemory = readFile(MEMORY_MD);
  const existingMind   = readFile(MIND_MD);

  const searchLogPath = join(WORKSPACE, `memory/search-log-${TODAY}.json`);
  const searchLog     = readFile(searchLogPath);
  const searchSection = searchLog.trim()
    ? `\n\n## Today's memory retrievals (reinforce these in Step 2)\n${searchLog.slice(0, 800)}`
    : "";

  const contextSummary = `## Existing MEMORY.md\n${existingMemory.slice(0, 3000)}\n\n## Existing MIND.md (full)\n${existingMind}${searchSection}`;

  // 4. Call curator model
  const userMessage = `## Session Transcript\n\n${capped}\n\n## Existing Memory Context (avoid duplicates)\n\n${contextSummary}`;

  let curatorResult;
  try {
    curatorResult = await callCurator(CURATOR_PROMPT, userMessage);
  } catch (e) {
    console.error("[curator] curation failed:", e.message);
    await runScript(join(import.meta.dirname, "self-heal.js"));
    return;
  }

  const curatorOutput  = curatorResult.content;
  const reasoningTrace = curatorResult.reasoningContent;

  // 4b. Write R1 reasoning trace to WORKINGS.md
  if (reasoningTrace && reasoningTrace.trim().length > 100) {
    const traceSummary = reasoningTrace.trim().slice(0, 2000);
    const traceEntry   = `## R1 curation working — ${TODAY}
- date: ${TODAY}
- tags: [r1-trace, curation, reasoning]
- session: auto

DeepSeek R1 chain-of-thought during curation pass on ${TODAY}.

<details>
${traceSummary}${reasoningTrace.length > 2000 ? "\n...[truncated]" : ""}
</details>

---`;
    try { appendFileSync(WORKINGS_MD, "\n" + traceEntry + "\n"); } catch {}
    console.log(`[curator] wrote R1 trace to WORKINGS.md (~${estimateTokens(traceSummary)} tokens)`);
  }

  // 5. Parse and route blocks
  const blocks = parseMemoryBlocks(curatorOutput);
  console.log(`[curator] extracted ${blocks.length} memory blocks`);

  const memoryEntries = [];
  const mindEntries   = [];
  const indexEntries  = [];

  for (const block of blocks) {
    if (block.destination === "MIND")       mindEntries.push(block.markdown);
    else if (block.destination === "INDEX") indexEntries.push(block.markdown);
    else                                    memoryEntries.push(block.markdown);
  }

  if (mindEntries.length > 0) {
    upsertMindEntries(mindEntries);
  }

  if (memoryEntries.length > 0) {
    const section = `\n## Session ${TODAY}\n${memoryEntries.join("\n")}\n`;
    appendFileSync(MEMORY_MD, section);
    console.log(`[curator] wrote ${memoryEntries.length} entries to MEMORY.md`);
  }

  // Session index → memory/sessions/YYYY-MM-DD-N.md
  if (indexEntries.length > 0) {
    const { mkdirSync, readdirSync } = await import("node:fs");
    const sessionsDir = join(WORKSPACE, "memory/sessions");
    if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

    const existing  = readdirSync(sessionsDir).filter(f => f.startsWith(TODAY)).length;
    const indexFile = join(sessionsDir, `${TODAY}-${existing + 1}.md`);
    writeFileSync(indexFile, indexEntries.join("\n\n") + "\n");
    console.log(`[curator] wrote session index → memory/sessions/${TODAY}-${existing + 1}.md`);
  }

  // 6. Post-curation pipeline
  await promoteGraduates();
  await runScript(join(import.meta.dirname, "decay.js"));
  await runScript(join(import.meta.dirname, "hot-cache.js"));
  await runScript(join(import.meta.dirname, "self-heal.js"));

  console.log("[curator] done");
}

main().catch(e => {
  console.error("[curator] fatal:", e);
  process.exit(1);
});
