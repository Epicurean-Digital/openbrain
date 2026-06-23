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

import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { execSync }        from "node:child_process";
import { join }            from "node:path";
import { homedir }         from "node:os";
import { normalizeMemoryObject } from "./shared/memory-schema.js";
import { appendMemoryEvent } from "./shared/memory-store.js";

// ── Config ─────────────────────────────────────────────────────────────────────
const WORKSPACE   = process.env.OPENBRAIN_WORKSPACE
  || join(homedir(), ".openclaw/workspace");
const PRIVATE_MEMORY_ROOT = join(WORKSPACE, "memory/private");
const OPENBRAIN_LEDGER_DIR = join(PRIVATE_MEMORY_ROOT, "openbrain");
const DECISIONS_JSONL = join(OPENBRAIN_LEDGER_DIR, "decisions.jsonl");
const OUTCOMES_JSONL = join(OPENBRAIN_LEDGER_DIR, "outcomes.jsonl");
const MEMORY_MD   = join(WORKSPACE, "MEMORY.md");
const MIND_MD     = join(WORKSPACE, "memory/MIND.md");
const WORKINGS_MD = join(WORKSPACE, "memory/WORKINGS.md");
const DRIFT_PATTERNS_MD = join(WORKSPACE, "memory/drift-patterns.md");
const COMPENSATION_STRATEGIES_MD = join(WORKSPACE, "memory/compensation-strategies.md");
const CONCEPTUAL_MODELS_MD = join(WORKSPACE, "memory/conceptual-models.md");
const COGNITIVE_PATTERNS_MD = join(WORKSPACE, "memory/cognitive-patterns.md");
const EMOTIONAL_PATTERNS_MD = join(WORKSPACE, "memory/emotional-patterns.md");
const TRANSFER_HYPOTHESES_MD = join(WORKSPACE, "memory/transfer-hypotheses.md");
const CANDIDATES_DIR = join(WORKSPACE, "memory/candidates");
const PROCESSED_CANDIDATES_DIR = join(CANDIDATES_DIR, "processed");
const EVENT_LOG_PATH = join(WORKSPACE, "memory/events.jsonl");
const SHARED_MEMORY_DIR = join(WORKSPACE, "memory/shared");
const SHARED_MEMORY_MD = join(SHARED_MEMORY_DIR, "MEMORY.md");
const SHARED_MIND_MD = join(SHARED_MEMORY_DIR, "MIND.md");
const SHARED_DRIFT_PATTERNS_MD = join(SHARED_MEMORY_DIR, "drift-patterns.md");
const SHARED_COMPENSATION_STRATEGIES_MD = join(SHARED_MEMORY_DIR, "compensation-strategies.md");
const SHARED_CONCEPTUAL_MODELS_MD = join(SHARED_MEMORY_DIR, "conceptual-models.md");
const SHARED_COGNITIVE_PATTERNS_MD = join(SHARED_MEMORY_DIR, "cognitive-patterns.md");
const SHARED_EMOTIONAL_PATTERNS_MD = join(SHARED_MEMORY_DIR, "emotional-patterns.md");
const SHARED_TRANSFER_HYPOTHESES_MD = join(SHARED_MEMORY_DIR, "transfer-hypotheses.md");

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
const CANDIDATE_MODE = args.includes("--candidates");
const FALLBACK_ONLY = args.includes("--fallback-only") || process.env.OPENBRAIN_SKIP_MODEL === "1";

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

function safeSlug(text, fallback = "item") {
  const slug = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function getTerms(text) {
  return [...new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3)
  )];
}

function selectRelevantBlocks(content, seedText, maxBlocks = 6, maxChars = 2600) {
  if (!content.trim()) return "";
  const terms = getTerms(seedText);
  const blocks = content
    .split(/\n---+\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const ranked = blocks
    .map(block => ({
      block,
      hits: terms.filter(term => block.toLowerCase().includes(term)).length,
    }))
    .filter(entry => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, maxBlocks)
    .map(entry => entry.block);

  const combined = ranked.join("\n\n---\n\n");
  return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
}

function loadRecentCandidateFiles(limit = 24) {
  if (!existsSync(CANDIDATES_DIR)) return [];

  return readdirSync(CANDIDATES_DIR)
    .filter(name => name.endsWith(".json"))
    .map(name => ({
      name,
      path: join(CANDIDATES_DIR, name),
      mtimeMs: statSync(join(CANDIDATES_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(-limit);
}

function parseCandidateFiles(files) {
  const payloads = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(file.path, "utf8"));
      if (raw?.candidates?.length) payloads.push({ file, raw });
    } catch {}
  }
  return payloads;
}

function normalizeCandidateRecord(candidate, source = {}) {
  return normalizeMemoryObject(candidate, {
    type: candidate?.type || "candidate",
    scope: "private",
    owner_runtime: source.platform || source.runtime || "unknown",
    owner_agent: source.agent || source.name || "unknown",
    share_policy: candidate?.share_policy || "private",
    visibility: candidate?.visibility || "local",
    reinforcement_count: candidate?.reinforcement_count ?? 1,
    decay_mode: candidate?.decay_mode || "slow",
  });
}

function normalizeCandidatePayloads(payloads) {
  return payloads.map(({ file, raw }) => {
    const source = raw?.source || {};
    return {
      file,
      raw: {
        ...raw,
        candidates: (raw?.candidates || []).map(candidate => normalizeCandidateRecord(candidate, source)),
      },
    };
  });
}

function buildCandidatePromotionInput(payloads) {
  const candidateLines = [];
  const seedTerms = [];

  for (const { raw } of payloads) {
    seedTerms.push(raw.query_type || "", raw.session_id || "");
    for (const candidate of raw.candidates || []) {
      seedTerms.push(candidate.title || "", candidate.content || "");
      candidateLines.push([
        `- type: ${candidate.type}`,
        `- title: ${candidate.title}`,
        `- content: ${candidate.content}`,
        `- confidence: ${candidate.confidence}`,
        `- reuse_likelihood: ${candidate.reuse_likelihood}`,
        `- share_policy: ${candidate.share_policy}`,
        `- visibility: ${candidate.visibility}`,
        `- promotion_state: ${candidate.promotion_state}`,
        candidate.evidence ? `- evidence: ${JSON.stringify(candidate.evidence)}` : "",
      ].filter(Boolean).join("\n"));
    }
  }

  return {
    seedText: seedTerms.join(" "),
    candidateText: candidateLines.join("\n\n---\n\n"),
  };
}

function archiveCandidateFiles(payloads) {
  if (payloads.length === 0) return;
  mkdirSync(PROCESSED_CANDIDATES_DIR, { recursive: true });
  for (const { file } of payloads) {
    const target = join(PROCESSED_CANDIDATES_DIR, `${Date.now()}-${safeSlug(file.name, "candidate")}.json`);
    try { renameSync(file.path, target); } catch {}
  }
}

function emitPrivateCandidateArtifacts(payloads) {
  mkdirSync(SHARED_MEMORY_DIR, { recursive: true });
  for (const { raw } of payloads) {
    for (const candidate of raw.candidates || []) {
      appendMemoryEvent(EVENT_LOG_PATH, {
        ...candidate,
        type: candidate.type || "candidate",
        scope: "private",
        share_policy: candidate.share_policy || "private",
        visibility: candidate.visibility || "local",
      });
    }
  }
}

function isExplicitSharedArtifact(candidate) {
  return (candidate.share_policy || "") === "shared_explicit"
    && candidate.visibility !== "local"
    && (candidate.confidence || 0) >= 0.75;
}

function upsertEntriesAt(path, label, newBlocks) {
  const content = readFile(path);

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

  const all = [...updated, ...toAppend];
  const newContent = header.trimEnd()
    + "\n\n"
    + all.join("\n\n---\n\n")
    + (all.length > 0 ? "\n\n---\n" : "");

  writeFileSync(path, newContent, "utf8");
  console.log(`[curator] ${label}: ${replaced} updated, ${toAppend.length} new`);
}

function emitExplicitSharedArtifacts(payloads) {
  const sharedDriftBlocks = [];
  const sharedCompensationBlocks = [];
  const sharedConceptualBlocks = [];
  const sharedCognitiveBlocks = [];
  const sharedEmotionalBlocks = [];
  const sharedTransferBlocks = [];
  const sharedMindBlocks = [];
  const sharedMemoryBlocks = [];

  for (const { raw } of payloads) {
    for (const candidate of raw.candidates || []) {
      if (!isExplicitSharedArtifact(candidate)) continue;
      const block = buildFallbackBlock(candidate);
      if (!block) continue;
      if (block.destination === "DRIFT") sharedDriftBlocks.push(block.markdown);
      else if (block.destination === "COMPENSATION") sharedCompensationBlocks.push(block.markdown);
      else if (block.destination === "CONCEPTUAL") sharedConceptualBlocks.push(block.markdown);
      else if (block.destination === "COGNITIVE") sharedCognitiveBlocks.push(block.markdown);
      else if (block.destination === "EMOTIONAL") sharedEmotionalBlocks.push(block.markdown);
      else if (block.destination === "TRANSFER") sharedTransferBlocks.push(block.markdown);
      else if (block.destination === "MIND") sharedMindBlocks.push(block.markdown);
      else if (block.destination === "MEMORY") sharedMemoryBlocks.push(block.markdown);
    }
  }

  mkdirSync(SHARED_MEMORY_DIR, { recursive: true });
  if (sharedDriftBlocks.length > 0) {
    writeSpecializedFile(SHARED_DRIFT_PATTERNS_MD, "DRIFT PATTERNS", sharedDriftBlocks);
    console.log(`[curator] shared drift patterns: wrote ${sharedDriftBlocks.length} explicit shared entries`);
  }
  if (sharedCompensationBlocks.length > 0) {
    writeSpecializedFile(SHARED_COMPENSATION_STRATEGIES_MD, "COMPENSATION STRATEGIES", sharedCompensationBlocks);
    console.log(`[curator] shared compensation strategies: wrote ${sharedCompensationBlocks.length} explicit shared entries`);
  }
  if (sharedConceptualBlocks.length > 0) {
    writeSpecializedFile(SHARED_CONCEPTUAL_MODELS_MD, "CONCEPTUAL MODELS", sharedConceptualBlocks);
    console.log(`[curator] shared conceptual models: wrote ${sharedConceptualBlocks.length} explicit shared entries`);
  }
  if (sharedCognitiveBlocks.length > 0) {
    writeSpecializedFile(SHARED_COGNITIVE_PATTERNS_MD, "COGNITIVE PATTERNS", sharedCognitiveBlocks);
    console.log(`[curator] shared cognitive patterns: wrote ${sharedCognitiveBlocks.length} explicit shared entries`);
  }
  if (sharedEmotionalBlocks.length > 0) {
    writeSpecializedFile(SHARED_EMOTIONAL_PATTERNS_MD, "EMOTIONAL PATTERNS", sharedEmotionalBlocks);
    console.log(`[curator] shared emotional patterns: wrote ${sharedEmotionalBlocks.length} explicit shared entries`);
  }
  if (sharedTransferBlocks.length > 0) {
    writeSpecializedFile(SHARED_TRANSFER_HYPOTHESES_MD, "TRANSFER HYPOTHESES", sharedTransferBlocks);
    console.log(`[curator] shared transfer hypotheses: wrote ${sharedTransferBlocks.length} explicit shared entries`);
  }
  if (sharedMindBlocks.length > 0) {
    upsertEntriesAt(SHARED_MIND_MD, "shared MIND.md", sharedMindBlocks);
  }
  if (sharedMemoryBlocks.length > 0) {
    const section = `\n## Shared candidate promotion ${TODAY}\n${sharedMemoryBlocks.join("\n")}\n`;
    appendFileSync(SHARED_MEMORY_MD, section);
    console.log(`[curator] shared MEMORY.md: wrote ${sharedMemoryBlocks.length} explicit shared entries`);
  }
}

// ── Curator prompt ─────────────────────────────────────────────────────────────
const CURATOR_PROMPT = `You are the memory curator for a persistent AI brain. Your job is to process a session transcript and update the brain's long-term memory.

Work through the following six steps in order. Be conservative — fewer high-quality entries beats many weak ones.

## STEP 1 — EXTRACT FACTS AND EVENTS

What was established in this session that should persist across future sessions?
Include: decisions made, preferences revealed, facts learned, mistakes made, outcomes of actions.

For each item assign:
- type: semantic|episodic|procedural|decision|outcome|emotional|cognitive|metamemory|prospective|spatial
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
- type: semantic|episodic|procedural|decision|outcome|emotional|cognitive|metamemory|prospective|spatial
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

const CANDIDATE_PROMOTION_PROMPT = `You are the promotion curator for a persistent AI brain. You receive low-cost candidate memories extracted from recent sessions plus a small dedupe context from existing durable memory.

Your job is to promote only the highest-value candidates into durable memory.

Promotion rules:
- Be conservative. Promote fewer, better memories.
- Prefer: durable project facts, stable decisions, reusable procedures, reasoning patterns, and compensation strategies.
- Do not promote temporary same-day context unless it clearly becomes durable.
- Merge duplicates rather than creating near-copies.
- If a candidate extends an existing memory, output the full updated block.
- If a candidate is useful only short-term, omit it entirely.

Important categories:
- semantic
- procedural
- proven_procedure
- pattern
- reasoning_pattern
- discovered_pattern
- outcome_lesson
- conceptual_model
- cognitive_pattern
- emotional_pattern
- transfer_hypothesis
- cognitive
- metamemory
- constraint
- drift_signal
- compensation

You may also create \`pattern\` entries when multiple candidates imply a reusable reasoning move or compensation.

Self-learning rules:
- \`reasoning_pattern\` candidates come from the assistant's own successful method of solving a class of problem. Promote them only if they are abstract enough to reuse.
- \`discovered_pattern\` candidates come from investigations, synthesis, or repeated observations that surfaced a durable structure.
- \`outcome_lesson\` candidates encode what worked, failed, or restored coherence. Promote only if the lesson is portable beyond one isolated exchange.
- \`conceptual_model\` candidates capture durable distinctions or abstractions from conversation. Promote them only if they clarify a concept likely to recur.
- \`cognitive_pattern\` candidates capture recurring ways the user or system tends to think, scope, or drift under load. Promote only when behaviorally useful.
- \`emotional_pattern\` candidates capture recurring affective or regulation-relevant patterns that matter for future coherence. Avoid speculative psychologizing.
- \`transfer_hypothesis\` candidates capture possible cross-domain mappings. Promote them conservatively and only when the structural analogy is explicit enough to test later.
- Investigation findings are valid memory inputs when they uncover durable facts, constraints, or patterns. Prefer MIND for stable findings and MEMORY for uncertain but still useful leads.

For drift and compensation:
- \`drift_signal\` entries should describe a recurring failure mode, its context, and why it matters.
- \`compensation\` entries should describe the smallest intervention that reliably restores coherence.
- Both are durable if they recur or clearly generalize beyond the immediate session.

Output ONLY memory blocks separated by a line containing only ---.
Do not output a session index in candidate mode.
Do not output commentary.

Use the same memory block formats and DESTINATION rules as the normal curator.
Pattern entries should go to MIND.
Temporary or unconfirmed items can go to MEMORY only if they are clearly worth retaining beyond the current day.`;

// ── Memory write helpers ───────────────────────────────────────────────────────
function upsertMindEntries(newBlocks) {
  upsertEntriesAt(MIND_MD, "MIND.md", newBlocks);
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

function blockType(markdown) {
  const typeMatch = markdown.match(/^- type:\s*(.+)$/m);
  return typeMatch ? typeMatch[1].trim().toLowerCase() : "";
}

function blockTitle(markdown) {
  const titleMatch = markdown.match(/^##\s+\[(?:[^\]]+)\]\s*(.+?)(?:\n|$)/m);
  return titleMatch ? titleMatch[1].trim() : "";
}

function blockBody(markdown) {
  return markdown
    .split("\n")
    .filter((line) => !/^##\s+/.test(line) && !/^- (type|confidence|trajectory|reinforced|last_reinforced|decay|tags):/.test(line))
    .join("\n")
    .trim();
}

function buildMirroredDecisionRecord(markdown) {
  const body = blockBody(markdown);
  const title = blockTitle(markdown) || body.split(/\.\s+|\n+/)[0] || "curated decision";
  const confidenceMatch = markdown.match(/^- confidence:\s*([0-9.]+)$/m);
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) || 0.5 : 0.5;
  return normalizeMemoryObject({
    type: "decision",
    title,
    what: title,
    why: body || title,
    evidence: body ? [body] : [],
    alternatives: [],
    tradeoff: "clarity over ambiguity",
    outcome: { success: /worked|succeeded|resolved|kept|improved/i.test(body), summary: body || title },
    content: body || title,
    source_system: "curator",
    source_session: TODAY,
    confidence,
    visibility: "local",
  }, { type: "decision" });
}

function buildMirroredOutcomeRecord(markdown) {
  const body = blockBody(markdown);
  const title = blockTitle(markdown) || body.split(/\.\s+|\n+/)[0] || "curated outcome";
  const confidenceMatch = markdown.match(/^- confidence:\s*([0-9.]+)$/m);
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) || 0.5 : 0.5;
  return normalizeMemoryObject({
    type: "outcome",
    title,
    summary: body || title,
    outcome: {
      success: /worked|succeeded|resolved|kept|improved/i.test(body),
      summary: body || title,
    },
    evidence: body ? [body] : [],
    source_system: "curator",
    source_session: TODAY,
    confidence,
    visibility: "local",
  }, { type: "outcome" });
}

function mirrorDecisionOutcomeBlocks(blocks) {
  const decisionBlocks = [];
  const outcomeBlocks = [];

  for (const block of blocks) {
    const type = blockType(block.markdown);
    if (type === "decision") decisionBlocks.push(block.markdown);
    if (type === "outcome") outcomeBlocks.push(block.markdown);
  }

  if (decisionBlocks.length > 0) {
    mkdirSync(OPENBRAIN_LEDGER_DIR, { recursive: true });
    for (const markdown of decisionBlocks) {
      appendMemoryEvent(DECISIONS_JSONL, buildMirroredDecisionRecord(markdown));
    }
    console.log(`[curator] mirrored ${decisionBlocks.length} curated decision blocks`);
  }

  if (outcomeBlocks.length > 0) {
    mkdirSync(OPENBRAIN_LEDGER_DIR, { recursive: true });
    for (const markdown of outcomeBlocks) {
      appendMemoryEvent(OUTCOMES_JSONL, buildMirroredOutcomeRecord(markdown));
    }
    console.log(`[curator] mirrored ${outcomeBlocks.length} curated outcome blocks`);
  }
}

function splitSpecializedEntries(blocks) {
  const regularBlocks = [];
  const driftBlocks = [];
  const compensationBlocks = [];
  const conceptualBlocks = [];
  const cognitiveBlocks = [];
  const emotionalBlocks = [];
  const transferBlocks = [];

  for (const block of blocks) {
    const typeMatch = block.markdown.match(/^- type:\s*(.+)$/m);
    const type = typeMatch ? typeMatch[1].trim() : "";
    if (type === "drift_signal") driftBlocks.push(block.markdown);
    else if (type === "compensation") compensationBlocks.push(block.markdown);
    else if (type === "conceptual_model") conceptualBlocks.push(block.markdown);
    else if (type === "cognitive_pattern") cognitiveBlocks.push(block.markdown);
    else if (type === "emotional_pattern") emotionalBlocks.push(block.markdown);
    else if (type === "transfer_hypothesis") transferBlocks.push(block.markdown);
    else regularBlocks.push(block);
  }

  return { regularBlocks, driftBlocks, compensationBlocks, conceptualBlocks, cognitiveBlocks, emotionalBlocks, transferBlocks };
}

function writeSpecializedFile(path, title, blocks) {
  if (blocks.length === 0) return;
  const deduped = [];
  const seen = new Set();
  for (const block of blocks) {
    const normalized = block.replace(/\n---\s*$/m, "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  const content = [
    `# ${title}`,
    "",
    ...deduped.flatMap(block => [block, "", "---", ""]),
  ].join("\n");
  writeFileSync(path, content.trimEnd() + "\n", "utf8");
}

function normalizeSpecializedFile(path, title) {
  if (!existsSync(path)) return false;
  const raw = readFile(path);
  if (!raw.trim()) return false;

  const blocks = [];
  const regex = /(^##\s+[^\n]+[\s\S]*?)(?=^##\s+|\Z)/gm;
  for (const match of raw.matchAll(regex)) {
    const block = (match[1] || "").trim();
    if (block.startsWith("## ")) blocks.push(block);
  }

  if (blocks.length === 0) {
    const fallback = `# ${title}\n`;
    if (raw !== fallback) {
      writeFileSync(path, fallback, "utf8");
      return true;
    }
    return false;
  }

  const deduped = [];
  const seen = new Set();
  for (const block of blocks) {
    const normalized = block.trim();
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  const rebuilt = [
    `# ${title}`,
    "",
    ...deduped.flatMap(block => [block, "", "---", ""]),
  ].join("\n").trimEnd() + "\n";

  if (rebuilt !== raw) {
    writeFileSync(path, rebuilt, "utf8");
    return true;
  }
  return false;
}

function normalizeSpecializedFiles() {
  const targets = [
    [DRIFT_PATTERNS_MD, "DRIFT PATTERNS"],
    [COMPENSATION_STRATEGIES_MD, "COMPENSATION STRATEGIES"],
    [CONCEPTUAL_MODELS_MD, "CONCEPTUAL MODELS"],
    [COGNITIVE_PATTERNS_MD, "COGNITIVE PATTERNS"],
    [EMOTIONAL_PATTERNS_MD, "EMOTIONAL PATTERNS"],
    [TRANSFER_HYPOTHESES_MD, "TRANSFER HYPOTHESES"],
  ];
  let changed = 0;
  for (const [path, title] of targets) {
    if (normalizeSpecializedFile(path, title)) changed += 1;
  }
  if (changed > 0) console.log(`[curator] normalized ${changed} specialized memory file(s)`);
}

function sanitizeCandidateText(text) {
  return (text || "")
    .replace(/\[\[reply_to_current\]\]/gi, "")
    .replace(/\bConversation info \(untrusted metadata\):[\s\S]*?```/gi, "")
    .replace(/\bSender \(untrusted metadata\):[\s\S]*?```/gi, "")
    .replace(/\bOpenClaw runtime context \(internal\):/gi, "")
    .replace(/\[Internal task completion event\][\s\S]*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function candidateLooksNoisy(candidate) {
  const title = (candidate.title || "").toLowerCase();
  const content = sanitizeCandidateText(candidate.content || "").toLowerCase();
  const evidence = JSON.stringify(candidate.evidence || {}).toLowerCase();
  const combined = `${title}\n${content}\n${evidence}`;

  if (!content || content.length < 40) return true;
  if (/conversation info \(untrusted metadata\)|sender \(untrusted metadata\)|openclaw runtime context|internal task completion event|openclaw-control-ui/.test(combined)) return true;
  if (/\[\[reply_to_current\]\]|^dispatched$|^done\.?$|pause here|saved to `|saved to \/|keep the scaffold|repeat the word/.test(combined)) return true;
  if (/^reply-to-current-|^done-|^understood-we-ll-pause|^dispatched$/.test(title)) return true;
  if (/connection error|fetch failed|timed out|enoent|no such file or directory/.test(combined)) return true;
  if (/phase-\d+|current-baseline|target-runtime|fig-super-brain-execution-plan/.test(title) && /artifact/.test(evidence)) return true;
  if (/priority - high(est)?|outcome -|project_context/.test(combined) && /artifact/.test(evidence) && candidate.type === "semantic") return true;
  return false;
}

function looksLikeTaxonomyList(text) {
  const cleaned = sanitizeCandidateText(text);
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/);
  if (words.length < 8) return false;
  const separators = (cleaned.match(/\s-\s|,\s/g) || []).length;
  const longWordCount = words.filter(w => w.length >= 5).length;
  const sentenceCount = (cleaned.match(/[.!?]/g) || []).length;
  return separators >= 4 && sentenceCount === 0 && longWordCount >= 6;
}

function firstSentence(text, maxLen = 180) {
  const cleaned = sanitizeCandidateText(text);
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return sentence.slice(0, maxLen).trim();
}

function normalizeHigherOrderTitle(candidate, fallback) {
  const base = sanitizeCandidateText(candidate.title || "");
  if (base && base.length >= 12 && !looksLikeTaxonomyList(base)) return base.slice(0, 96);
  return firstSentence(candidate.content || "", 96) || fallback;
}

function validateHigherOrderCandidate(candidate) {
  const type = candidate.type;
  const content = sanitizeCandidateText(candidate.content || "");
  const lower = content.toLowerCase();
  const evidence = JSON.stringify(candidate.evidence || {}).toLowerCase();

  if (!content || content.length < 80) return false;
  if (looksLikeTaxonomyList(content)) return false;
  if (!/[.!?—-]/.test(content)) return false;
  if (/^\s*(stable facts|project facts|continuity state|procedures|reasoning patterns)\b/i.test(content)) return false;
  if (/artifact/.test(evidence) && /(^|[\s:])(priority|outcome|goal|principle|policy|architecture|definition)([\s-]|$)/i.test(content) && type !== "conceptual_model") return false;

  if (type === "conceptual_model") {
    return /\b(not just|not only|difference between|is not the same as|rather than|means that|goal is not|distinction)\b/i.test(lower);
  }
  if (type === "cognitive_pattern") {
    return /\b(tends to|under load|under pressure|when overloaded|when uncertainty rises|broadens scope|narrows|over-abstract|restate|thinking style|approaches problems|thinks in|maps structure|details second|systems first)\b/i.test(lower);
  }
  if (type === "emotional_pattern") {
    const affect = /\b(friction|dread|grief|relief|fear|shame|overwhelm|tension|care deeply|contract|moral injury)\b/i.test(lower);
    const patternish = /\b(when|under|around|during|tends to|what matters|shortcuts|non-negotiable)\b/i.test(lower);
    return affect && patternish;
  }
  if (type === "transfer_hypothesis") {
    return /\b(also applies|in another domain|same pattern|maps to|cross-domain|transfer|structurally similar)\b/i.test(lower);
  }
  return true;
}

function summarizePatternAbstract(content) {
  const cleaned = sanitizeCandidateText(content)
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 160);
}

function buildFallbackBlock(candidate) {
  const type = candidate.type;
  const tags = [type, "fallback-promotion"];
  const title = candidate.title || safeSlug(candidate.content || "memory", "memory");
  const content = sanitizeCandidateText(candidate.content || "");
  if (!content || content.length < 24) return null;
  if (candidateLooksNoisy(candidate)) return null;

  if (type === "drift_signal") {
    return {
      destination: "DRIFT",
      markdown: `## ${title}
- type: drift_signal
- confidence: ${Math.max(candidate.confidence || 0.5, 0.6).toFixed(2)}
- trajectory: learning
- source_session: ${candidate.source_session || "unknown"}
- tags: [${tags.join(", ")}]

${content}

---`
    };
  }

  if (type === "compensation") {
    return {
      destination: "COMPENSATION",
      markdown: `## ${title}
- type: compensation
- confidence: ${Math.max(candidate.confidence || 0.5, 0.6).toFixed(2)}
- trajectory: learning
- source_session: ${candidate.source_session || "unknown"}
- tags: [${tags.join(", ")}]

${content}

---`
    };
  }

  if (type === "conceptual_model") {
    if (!validateHigherOrderCandidate(candidate)) return null;
    return {
      destination: "CONCEPTUAL",
      markdown: `## ${normalizeHigherOrderTitle(candidate, title)}
- type: conceptual_model
- confidence: ${Math.max(candidate.confidence || 0.5, 0.6).toFixed(2)}
- trajectory: learning
- source_session: ${candidate.source_session || "unknown"}
- tags: [${tags.join(", ")}]

${content}

---`
    };
  }

  if (type === "cognitive_pattern") {
    if (!validateHigherOrderCandidate(candidate)) return null;
    return {
      destination: "COGNITIVE",
      markdown: `## ${normalizeHigherOrderTitle(candidate, title)}
- type: cognitive_pattern
- confidence: ${Math.max(candidate.confidence || 0.5, 0.58).toFixed(2)}
- trajectory: learning
- source_session: ${candidate.source_session || "unknown"}
- tags: [${tags.join(", ")}]

${content}

---`
    };
  }

  if (type === "emotional_pattern") {
    if (!validateHigherOrderCandidate(candidate)) return null;
    return {
      destination: "EMOTIONAL",
      markdown: `## ${normalizeHigherOrderTitle(candidate, title)}
- type: emotional_pattern
- confidence: ${Math.max(candidate.confidence || 0.5, 0.56).toFixed(2)}
- trajectory: learning
- source_session: ${candidate.source_session || "unknown"}
- tags: [${tags.join(", ")}]

${content}

---`
    };
  }

  if (type === "transfer_hypothesis") {
    if (!validateHigherOrderCandidate(candidate)) return null;
    return {
      destination: "TRANSFER",
      markdown: `## ${normalizeHigherOrderTitle(candidate, title)}
- type: transfer_hypothesis
- confidence: ${Math.max(candidate.confidence || 0.5, 0.56).toFixed(2)}
- trajectory: learning
- source_session: ${candidate.source_session || "unknown"}
- tags: [${tags.join(", ")}]

${content}

---`
    };
  }

  const durableTypes = new Set([
    "reasoning_pattern",
    "discovered_pattern",
    "outcome_lesson",
    "conceptual_model",
    "cognitive_pattern",
    "emotional_pattern",
    "transfer_hypothesis",
    "procedure",
    "pattern",
  ]);
  const destination = durableTypes.has(type) ? "MIND" : "MEMORY";
  const normalizedType = [
    "reasoning_pattern",
    "discovered_pattern",
    "outcome_lesson",
    "conceptual_model",
    "cognitive_pattern",
    "emotional_pattern",
    "transfer_hypothesis",
  ].includes(type)
    ? "pattern"
    : type;
  const abstract = destination === "MIND" && normalizedType === "pattern"
    ? `- abstract: ${summarizePatternAbstract(content)}`
    : null;

  return {
    destination,
    markdown: `## [${normalizedType}] ${title}
- type: ${normalizedType}
${abstract ? `${abstract}\n` : ""}- confidence: ${Math.max(candidate.confidence || 0.5, 0.58).toFixed(2)}
- trajectory: learning
- reinforced: 1
- last_reinforced: ${TODAY}
- decay: ${destination === "MIND" ? "permanent" : "slow"}
- tags: [${tags.join(", ")}]

${content}

---`
  };
}

function buildFallbackPromotions(payloads) {
  const accepted = [];
  const seen = new Set();
  const titleCounts = new Map();

  for (const { raw } of payloads) {
    for (const candidate of raw.candidates || []) {
      const key = `${candidate.type}:${(candidate.title || "").toLowerCase()}`;
      titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    }
  }

  for (const { raw } of payloads) {
    for (const candidate of raw.candidates || []) {
      if ((candidate.promotion_state || "") === "short_term") continue;
      if (candidateLooksNoisy(candidate)) continue;
      if ((candidate.reuse_likelihood || 0) < 0.62 && (candidate.confidence || 0) < 0.56) continue;
      if ((candidate.type === "drift_signal" || candidate.type === "compensation")
        && (titleCounts.get(`${candidate.type}:${(candidate.title || "").toLowerCase()}`) || 0) < 2
        && ((candidate.reuse_likelihood || 0) < 0.72 || (candidate.confidence || 0) < 0.6)) {
        continue;
      }
      if ((candidate.type === "reasoning_pattern"
        || candidate.type === "discovered_pattern"
        || candidate.type === "outcome_lesson"
        || candidate.type === "conceptual_model"
        || candidate.type === "cognitive_pattern"
        || candidate.type === "emotional_pattern"
        || candidate.type === "transfer_hypothesis")
        && sanitizeCandidateText(candidate.content || "").length < 80) {
        continue;
      }
      if ((candidate.type === "conceptual_model"
        || candidate.type === "cognitive_pattern"
        || candidate.type === "emotional_pattern"
        || candidate.type === "transfer_hypothesis")
        && !validateHigherOrderCandidate(candidate)) {
        continue;
      }
      const block = buildFallbackBlock(candidate);
      if (!block) continue;
      const key = `${block.destination}:${block.markdown.slice(0, 120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(block);
    }
  }

  const priority = block => {
    const text = block.markdown || "";
    if (block.destination === "COGNITIVE") return 100;
    if (block.destination === "CONCEPTUAL") return 95;
    if (block.destination === "EMOTIONAL") return 90;
    if (block.destination === "TRANSFER") return 88;
    if (block.destination === "DRIFT") return 82;
    if (block.destination === "COMPENSATION") return 80;
    if (block.destination === "MIND") return 72;
    if (block.destination === "MEMORY") return /\btype:\s*procedure\b/i.test(text) ? 68 : 60;
    return 50;
  };

  return accepted
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, 8);
}

function parseSectionBlocks(content) {
  return content
    .split(/\n---\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function migrateMisfiledHigherOrderEntries() {
  const content = readFile(MEMORY_MD);
  if (!content.trim()) return;

  const blocks = parseSectionBlocks(content);
  const keep = [];
  const conceptual = [];
  const cognitive = [];
  const emotional = [];
  const transfer = [];
  let migrated = 0;
  let removed = 0;

  for (const block of blocks) {
    const typeMatch = block.match(/^- type:\s*(.+)$/m);
    const type = typeMatch ? typeMatch[1].trim() : "";
    if (!["conceptual_model", "cognitive_pattern", "emotional_pattern", "transfer_hypothesis"].includes(type)) {
      keep.push(block);
      continue;
    }

    const titleMatch = block.match(/^## \[[^\]]+\]\s*(.+?)(?:\n|$)/m);
    const title = titleMatch ? titleMatch[1].trim() : "higher-order-memory";
    const bodyMatch = block.match(/\n\n([\s\S]*)$/);
    const candidate = {
      type,
      title,
      content: bodyMatch ? bodyMatch[1].replace(/\n---\s*$/m, "").trim() : "",
      confidence: Number((block.match(/^- confidence:\s*([0-9.]+)/m) || [])[1] || 0.6),
      source_session: (block.match(/^- source_session:\s*(.+)$/m) || [])[1] || "memory-migration",
      evidence: { migrated_from: "MEMORY.md" },
    };

    const rebuilt = buildFallbackBlock(candidate);
    if (!rebuilt) {
      removed += 1;
      continue;
    }

    if (rebuilt.destination === "CONCEPTUAL") conceptual.push(rebuilt.markdown);
    else if (rebuilt.destination === "COGNITIVE") cognitive.push(rebuilt.markdown);
    else if (rebuilt.destination === "EMOTIONAL") emotional.push(rebuilt.markdown);
    else if (rebuilt.destination === "TRANSFER") transfer.push(rebuilt.markdown);
    else keep.push(block);
    migrated += 1;
  }

  if (migrated === 0 && removed === 0) return;

  const rebuiltMemory = keep.length > 0 ? keep.join("\n\n---\n\n").trimEnd() + "\n" : "# MEMORY.md\n";
  writeFileSync(MEMORY_MD, rebuiltMemory, "utf8");
  if (conceptual.length > 0) writeSpecializedFile(CONCEPTUAL_MODELS_MD, "CONCEPTUAL MODELS", conceptual);
  if (cognitive.length > 0) writeSpecializedFile(COGNITIVE_PATTERNS_MD, "COGNITIVE PATTERNS", cognitive);
  if (emotional.length > 0) writeSpecializedFile(EMOTIONAL_PATTERNS_MD, "EMOTIONAL PATTERNS", emotional);
  if (transfer.length > 0) writeSpecializedFile(TRANSFER_HYPOTHESES_MD, "TRANSFER HYPOTHESES", transfer);
  console.log(`[curator] migrated ${migrated} higher-order entries out of MEMORY.md, removed ${removed} low-quality higher-order entries`);
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

async function runCandidatePromotion() {
  normalizeSpecializedFiles();
  migrateMisfiledHigherOrderEntries();
  const files = loadRecentCandidateFiles();
  if (files.length === 0) {
    console.log("[curator] no candidate files found — skipping candidate promotion");
    await runScript(join(import.meta.dirname, "self-heal.js"));
    return;
  }

  const payloads = parseCandidateFiles(files);
  if (payloads.length === 0) {
    console.log("[curator] no valid candidate payloads found");
    return;
  }

  const normalizedPayloads = normalizeCandidatePayloads(payloads);
  emitPrivateCandidateArtifacts(normalizedPayloads);

  const { seedText, candidateText } = buildCandidatePromotionInput(normalizedPayloads);
  if (!candidateText.trim()) {
    console.log("[curator] candidate payloads contained no promotable text");
    archiveCandidateFiles(payloads);
    return;
  }

  const existingMemory = readFile(MEMORY_MD);
  const existingMind = readFile(MIND_MD);
  const memoryContext = selectRelevantBlocks(existingMemory, seedText, 4, 1800);
  const mindContext = selectRelevantBlocks(existingMind, seedText, 6, 2600);
  const dedupeContext = [
    memoryContext ? `## Relevant MEMORY.md blocks\n${memoryContext}` : "",
    mindContext ? `## Relevant MIND.md blocks\n${mindContext}` : "",
  ].filter(Boolean).join("\n\n");

  const userMessage = `## Candidate memories\n\n${candidateText}\n\n## Existing durable context\n\n${dedupeContext || "(none)"}`;

  let curatorOutput = "";
  let reasoningTrace = null;

  if (!FALLBACK_ONLY) {
    let curatorResult;
    try {
      curatorResult = await callCurator(CANDIDATE_PROMOTION_PROMPT, userMessage);
      curatorOutput = curatorResult.content;
      reasoningTrace = curatorResult.reasoningContent;
    } catch (e) {
      console.error("[curator] candidate promotion failed, falling back locally:", e.message);
    }
  } else {
    console.log("[curator] skipping model promotion, using fallback-only mode");
  }

  if (reasoningTrace && reasoningTrace.trim().length > 100) {
    const traceSummary = reasoningTrace.trim().slice(0, 2000);
    const traceEntry = `## Candidate promotion working — ${TODAY}
- date: ${TODAY}
- tags: [candidate-promotion, reasoning]
- session: batched

<details>
${traceSummary}${reasoningTrace.length > 2000 ? "\n...[truncated]" : ""}
</details>

---`;
    try { appendFileSync(WORKINGS_MD, "\n" + traceEntry + "\n"); } catch {}
  }

  const blocks = parseMemoryBlocks(curatorOutput);
  console.log(`[curator] candidate promotion extracted ${blocks.length} memory blocks`);
  let { regularBlocks, driftBlocks, compensationBlocks, conceptualBlocks, cognitiveBlocks, emotionalBlocks, transferBlocks } = splitSpecializedEntries(blocks);

  if (blocks.length === 0) {
    const fallback = buildFallbackPromotions(normalizedPayloads);
    if (fallback.length > 0) {
      console.log(`[curator] applying fallback promotion for ${fallback.length} candidate(s)`);
      regularBlocks = fallback
        .filter(b => b.destination === "MIND" || b.destination === "MEMORY")
        .map(b => ({ destination: b.destination, markdown: b.markdown }));
      driftBlocks = fallback.filter(b => b.destination === "DRIFT").map(b => b.markdown);
      compensationBlocks = fallback.filter(b => b.destination === "COMPENSATION").map(b => b.markdown);
      conceptualBlocks = fallback.filter(b => b.destination === "CONCEPTUAL").map(b => b.markdown);
      cognitiveBlocks = fallback.filter(b => b.destination === "COGNITIVE").map(b => b.markdown);
      emotionalBlocks = fallback.filter(b => b.destination === "EMOTIONAL").map(b => b.markdown);
      transferBlocks = fallback.filter(b => b.destination === "TRANSFER").map(b => b.markdown);
    }
  }

  const memoryEntries = [];
  const mindEntries = [];

  for (const block of regularBlocks) {
    if (block.destination === "MIND") mindEntries.push(block.markdown);
    else if (block.destination === "MEMORY") memoryEntries.push(block.markdown);
  }

  if (mindEntries.length > 0) upsertMindEntries(mindEntries);

  if (memoryEntries.length > 0) {
    const section = `\n## Candidate promotion ${TODAY}\n${memoryEntries.join("\n")}\n`;
    appendFileSync(MEMORY_MD, section);
    console.log(`[curator] wrote ${memoryEntries.length} promoted candidate entries to MEMORY.md`);
  }

  if (driftBlocks.length > 0) {
    writeSpecializedFile(DRIFT_PATTERNS_MD, "DRIFT PATTERNS", driftBlocks);
    console.log(`[curator] wrote ${driftBlocks.length} drift pattern entries`);
  }

  if (compensationBlocks.length > 0) {
    writeSpecializedFile(COMPENSATION_STRATEGIES_MD, "COMPENSATION STRATEGIES", compensationBlocks);
    console.log(`[curator] wrote ${compensationBlocks.length} compensation entries`);
  }

  if (conceptualBlocks.length > 0) {
    writeSpecializedFile(CONCEPTUAL_MODELS_MD, "CONCEPTUAL MODELS", conceptualBlocks);
    console.log(`[curator] wrote ${conceptualBlocks.length} conceptual model entries`);
  }

  if (cognitiveBlocks.length > 0) {
    writeSpecializedFile(COGNITIVE_PATTERNS_MD, "COGNITIVE PATTERNS", cognitiveBlocks);
    console.log(`[curator] wrote ${cognitiveBlocks.length} cognitive pattern entries`);
  }

  if (emotionalBlocks.length > 0) {
    writeSpecializedFile(EMOTIONAL_PATTERNS_MD, "EMOTIONAL PATTERNS", emotionalBlocks);
    console.log(`[curator] wrote ${emotionalBlocks.length} emotional pattern entries`);
  }

  if (transferBlocks.length > 0) {
    writeSpecializedFile(TRANSFER_HYPOTHESES_MD, "TRANSFER HYPOTHESES", transferBlocks);
    console.log(`[curator] wrote ${transferBlocks.length} transfer hypothesis entries`);
  }

  emitExplicitSharedArtifacts(normalizedPayloads);
  archiveCandidateFiles(payloads);
  await promoteGraduates();
  await runScript(join(import.meta.dirname, "decay.js"));
  await runScript(join(import.meta.dirname, "hot-cache.js"));
  await runScript(join(import.meta.dirname, "self-heal.js"));
  console.log("[curator] candidate promotion done");
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  normalizeSpecializedFiles();
  if (!ANTHROPIC_KEY && !DEEPSEEK_KEY) {
    console.error("[curator] no API key available (ANTHROPIC_API_KEY or DEEPSEEK_API_KEY required) — aborting");
    process.exit(1);
  }

  if (CANDIDATE_MODE) {
    await runCandidatePromotion();
    return;
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

  const transcriptTerms = cleaned.slice(-3000);
  const mindContext = selectRelevantBlocks(existingMind, transcriptTerms, 8, 3200);
  const memoryContext = selectRelevantBlocks(existingMemory, transcriptTerms, 5, 2200);
  const contextSummary = `## Existing MEMORY.md (relevant)\n${memoryContext}\n\n## Existing MIND.md (relevant)\n${mindContext}${searchSection}`;

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
  mirrorDecisionOutcomeBlocks(blocks);

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
