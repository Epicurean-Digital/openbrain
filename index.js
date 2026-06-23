/**
 * OpenBrain — persistent memory, cross-session pattern learning, and context retrieval.
 *
 * Hooks used:
 *   before_prompt_build  — query classification + active/recent/long-term retrieval injection
 *   agent_end            — cost logging + continuity updates + candidate staging + selective coherence check + debounced curation
 *
 * Config (from openclaw.json plugins.entries.openbrain.config):
 *   workspace                — memory workspace path
 *   costWebhook              — optional HTTP endpoint for token cost logging
 *   curator.model            — curator model id
 *   curator.provider         — curator provider (anthropic|deepseek)
 *   eval.model               — eval model id
 *   eval.provider            — eval provider
 *   curationDebounceMinutes  — minutes of inactivity before curation fires (default 10)
 *   hotCacheSize             — top-N entries in HOT_CACHE.md (default 25)
 *   activeMemory.enabled     — enable same-day ACTIVE.md continuity layer (default true)
 *   activeMemory.maxChars    — max chars injected from ACTIVE.md (default 900)
 *   stableContext.enabled    — enable optional stable prefix retrieval from HOT_CACHE.md + STABLE_CONTEXT.md (default true)
 *   stableContext.maxChars   — max chars injected from STABLE_CONTEXT.md (default 500)
 *   constraints.maxChars     — max chars injected from durable constraints (default 700)
 *   procedures.maxChars      — max chars injected from proven procedures (default 800)
 *   openLoops.maxChars       — max chars injected from open-loops.md (default 700)
 *   retrieval.totalMaxChars  — max total chars injected by OpenBrain (default 1800)
 *   curateSubagents          — curate sub-agent sessions immediately (default false)
 *   coherenceCheck.enabled   — enable selective coherence checks (default true)
 *   coherenceCheck.minChars  — minimum response size to consider for check (default 280)
 *   coherenceCheck.provider  — provider for coherence checks (defaults to eval.provider)
 *   coherenceCheck.model     — model for coherence checks (defaults to eval.model)
 *   telemetry.enabled        — enable generic telemetry emission (default true)
 *   telemetry.webhook        — optional generic telemetry webhook
 *   telemetry.writeJsonl     — write JSONL telemetry under memory/telemetry/ (default true)
 */

import { writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join }    from "node:path";
import { spawn, spawnSync }   from "node:child_process";
import { homedir } from "node:os";
import { appendMemoryEvent } from "./scripts/shared/memory-store.js";

const PLUGIN_DIR = import.meta.dirname;
const DEFAULT_WORKSPACE = process.env.OPENBRAIN_WORKSPACE
  || join(homedir(), ".openclaw/workspace");
const PRIVATE_MEMORY_ROOT = join(DEFAULT_WORKSPACE, "memory/private");
const SHARED_MEMORY_ROOT = join(DEFAULT_WORKSPACE, "memory/shared");
const PRIVATE_HOST_ROOT = (runtime, agent = "main") => join(PRIVATE_MEMORY_ROOT, runtime, agent);
const EVENT_LOG_PATH = join(DEFAULT_WORKSPACE, "memory/events.jsonl");

/**
 * Memory contract:
 * @typedef {"event" | "episode" | "fact" | "constraint" | "procedure" | "decision" | "outcome" | "lesson" | "belief" | "drift_signal" | "compensation" | "candidate"} MemoryObjectType
 * @typedef {"local" | "shared_codex" | "shared_claude" | "shared_cross_llm"} MemoryVisibility
 */
const MEMORY_OBJECT_TYPES = Object.freeze([
  "event",
  "episode",
  "fact",
  "constraint",
  "procedure",
  "decision",
  "outcome",
  "lesson",
  "belief",
  "drift_signal",
  "compensation",
  "candidate",
]);

const MEMORY_VISIBILITY = Object.freeze([
  "local",
  "shared_codex",
  "shared_claude",
  "shared_cross_llm",
]);

// ── Query classifier ───────────────────────────────────────────────────────────
const TEMPORAL_RE   = /\b(current|latest|now|today|this week|recently|right now|price|status|news)\b/i;
const EPISODIC_RE   = /\b(remember|last time|we decided|what did|previously|earlier|before|discussed|mentioned|you said)\b/i;
const PROCEDURAL_RE = /\b(how (do|to|should|can)|steps|process|workflow|procedure|what.s the (way|approach))\b/i;

// PERSONAL_RE is built at load time from config.personalTerms — add your own project names, people, etc.
// These terms signal episodic/personal queries that benefit most from memory retrieval.
let PERSONAL_RE = null;

const STOP_WORDS = new Set([
  "that","this","with","from","have","what","when","where","which","your",
  "their","there","then","than","been","were","they","into","about","would",
]);

export function classifyQuery(text) {
  if (TEMPORAL_RE.test(text))             return "temporal";
  if (EPISODIC_RE.test(text))             return "episodic";
  if (PROCEDURAL_RE.test(text))           return "procedural";
  if (PERSONAL_RE && PERSONAL_RE.test(text)) return "personal";
  return "factual";
}

function getQueryTerms(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w))
  )];
}

function resolveExistingPath(pathOrPaths) {
  const candidates = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function readIfExists(path) {
  const resolved = resolveExistingPath(path);
  return resolved ? readFileSync(resolved, "utf8") : "";
}

function readPreferredText(...paths) {
  for (const candidate of paths.flat().filter(Boolean)) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return "";
}

function readPreferredJsonl(...paths) {
  for (const candidate of paths.flat().filter(Boolean)) {
    if (existsSync(candidate)) return readJsonlObjects(candidate);
  }
  return [];
}

function firstExistingPath(...paths) {
  for (const candidate of paths.flat().filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function trimToChars(text, maxChars) {
  if (!text) return "";
  if (!maxChars || text.length <= maxChars) return text.trim();
  const slice = text.slice(0, Math.max(0, maxChars - 16)).trimEnd();
  return `${slice}\n...[truncated]`;
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function collectBudgetedSections(sections, totalMaxChars) {
  const kept = [];
  let used = 0;
  const tierChars = { stable: 0, semi_stable: 0, volatile: 0 };
  const tierBodies = { stable: [], semi_stable: [], volatile: [] };
  const layersUsed = [];

  for (const section of sections) {
    if (!section?.body) continue;
    const body = section.body.trim();
    if (!body) continue;

    const tier = section.tier || "volatile";
    const layer = section.layer || safeSlug(section.title, "memory");
    const chunk = `<!-- brain-layer: ${layer}; tier: ${tier} -->\n### ${section.title}\n${body}`;
    const sep = kept.length ? 2 : 0;
    if (totalMaxChars && used + sep + chunk.length > totalMaxChars) {
      const remaining = totalMaxChars - used - sep;
      if (remaining < 120) break;
      const trimmedBody = trimToChars(body, remaining - (`<!-- brain-layer: ${layer}; tier: ${tier} -->\n### ${section.title}\n`).length);
      const trimmedChunk = `<!-- brain-layer: ${layer}; tier: ${tier} -->\n### ${section.title}\n${trimmedBody}`;
      kept.push(trimmedChunk);
      tierChars[tier] += trimmedBody.length;
      tierBodies[tier].push(trimmedBody);
      layersUsed.push(layer);
      break;
    }

    kept.push(chunk);
    used += sep + chunk.length;
    tierChars[tier] += body.length;
    tierBodies[tier].push(body);
    layersUsed.push(layer);
  }

  return {
    text: kept.join("\n\n"),
    tierChars,
    layersUsed,
    tierHashes: {
      stable: hashString(tierBodies.stable.join("\n\n")),
      semi_stable: hashString(tierBodies.semi_stable.join("\n\n")),
      volatile: hashString(tierBodies.volatile.join("\n\n")),
    },
  };
}

function safeSlug(text, fallback = "item") {
  const slug = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function normalizeLedgerText(text, maxChars = 220) {
  return trimToChars((text || "").replace(/\s+/g, " ").trim(), maxChars);
}

function ledgerPrivateRoot(workspace) {
  return join(workspace, "memory/private/openbrain");
}

function ledgerPath(workspace, kind) {
  return join(ledgerPrivateRoot(workspace), `${kind}.jsonl`);
}

function summarizeAlternatives(question, response) {
  const candidates = [];
  const text = `${question || ""}\n${response || ""}`;
  const patterns = [
    /\binstead of\s+([^.;\n]{3,120})/ig,
    /\brather than\s+([^.;\n]{3,120})/ig,
    /\balternatively[,:]?\s+([^.;\n]{3,120})/ig,
    /\bor\s+([^.;\n]{3,120})/ig,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const item = normalizeLedgerText(match[1], 120);
      if (item && !candidates.includes(item)) candidates.push(item);
      if (candidates.length >= 3) return candidates;
    }
  }

  return candidates.length ? candidates : [
    "keep the current direction",
    "choose a different implementation path",
  ];
}

function inferTradeoff(exchange, outcome) {
  const response = `${exchange?.response || ""}`.toLowerCase();
  const question = `${exchange?.question || ""}`.toLowerCase();
  if (outcome?.success === false || outcome?.corrections > 0) return "correctness over speed";
  if (/\bspeed|fast|quick|quickly\b/.test(response) && /\baccurate|correct|safe|safer\b/.test(response)) return "speed over certainty";
  if (/\bnarrow|scope|specific\b/.test(response) && /\bbroad|general|generalize\b/.test(question)) return "focus over breadth";
  if (/\breuse|repeat|pattern\b/.test(response)) return "reuse over novelty";
  return "clarity over ambiguity";
}

function extractWhy(exchange, outcome) {
  const response = exchange?.response || "";
  const whyMatch = response.match(/\b(?:because|since|so that|to)\b[:\s-]*([^.\n]{20,220})/i);
  if (whyMatch) return normalizeLedgerText(whyMatch[1], 180);
  if (outcome?.success === false) return "The session required correction after the chosen path exposed a mismatch or failure.";
  return normalizeLedgerText(exchange?.question || response, 180);
}

function outcomeSummary(outcome) {
  if (!outcome) return "No outcome recorded.";
  if (outcome.success) return "The choice produced a successful outcome.";
  if (outcome.corrections > 0) return "The choice produced a partial outcome that required correction.";
  if (outcome.escalated) return "The choice escalated instead of resolving cleanly.";
  return "The choice did not resolve cleanly.";
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function utilityScoreFromContext(context = {}) {
  const explicit = Number(context.utilityScore ?? context.utility_score ?? context.utility);
  if (Number.isFinite(explicit)) {
    return clamp01(explicit > 1 ? explicit / 100 : explicit);
  }

  const resolution = Number(context.resolutionScore);
  if (Number.isFinite(resolution)) {
    const normalized = clamp01(resolution > 1 ? resolution / 100 : resolution);
    const correctionPenalty = Math.min(0.18, (context.correctionTurns || 0) * 0.04);
    const clarificationPenalty = Math.min(0.12, (context.clarificationTurns || 0) * 0.02);
    const escalationPenalty = context.escalated ? 0.1 : 0;
    return clamp01(normalized - correctionPenalty - clarificationPenalty - escalationPenalty);
  }

  return clamp01(context.success ? 0.82 : 0.38);
}

function conflictCountFromContext(context = {}) {
  const explicit = Number(context.conflictCount ?? context.conflict_count);
  const contradictionSignal = Number(context.contradictions);
  const base = Number.isFinite(explicit) ? explicit : 0;
  const contradiction = Number.isFinite(contradictionSignal) ? contradictionSignal : 0;
  return Math.max(base, contradiction) + Math.max(0, context.constraintViolations?.length || 0) + (context.escalated ? 1 : 0);
}

function buildDecisionLedgerRecord(sessionId, exchange, context = {}) {
  const what = normalizeLedgerText(exchange?.response || exchange?.question || "session decision", 220);
  const signature = hashString(what.toLowerCase());
  const utilityScore = utilityScoreFromContext(context);
  const conflictCount = conflictCountFromContext(context);
  const outcome = {
    success: context.success,
    resolution_score: context.resolutionScore,
    corrections: context.correctionTurns || 0,
    clarifications: context.clarificationTurns || 0,
    escalated: Boolean(context.escalated),
    contradictions: context.contradictions || 0,
  };

  return {
    type: "decision",
    id: `decision:${signature}:${sessionId || "session"}`,
    session_id: sessionId || "default",
    decision_key: `decision_${signature}`,
    decision_signature: signature,
    what,
    why: extractWhy(exchange, outcome),
    utility_score: utilityScore,
    conflict_count: conflictCount,
    contradiction_count: conflictCount,
    evidence: {
      question: normalizeLedgerText(exchange?.question || "", 180),
      commitments: context.commitments || [],
      constraint_violations: context.constraintViolations || [],
      resolution_score: context.resolutionScore ?? null,
      assistant_chars: context.assistantChars ?? null,
    },
    alternatives: summarizeAlternatives(exchange?.question || "", exchange?.response || ""),
    tradeoff: inferTradeoff(exchange, outcome),
    outcome,
    source_refs: context.sourceRefs || [],
    confidence: context.success ? 0.78 : 0.62,
    visibility: "local",
  };
}

function buildOutcomeLedgerRecord(sessionId, exchange, context = {}) {
  const what = normalizeLedgerText(exchange?.response || exchange?.question || "session outcome", 220);
  const signature = hashString(what.toLowerCase());
  const success = context.success ?? false;
  const utilityScore = utilityScoreFromContext(context);
  const conflictCount = conflictCountFromContext(context);
  const outcome = {
    success,
    resolution_score: context.resolutionScore ?? null,
    clarifications: context.clarificationTurns || 0,
    corrections: context.correctionTurns || 0,
    escalated: Boolean(context.escalated),
    contradictions: context.contradictions || 0,
  };

  return {
    type: "outcome",
    id: `outcome:${signature}:${sessionId || "session"}`,
    session_id: sessionId || "default",
    outcome_key: `outcome_${signature}`,
    decision_key: `decision_${signature}`,
    decision_signature: signature,
    summary: outcomeSummary({
      success,
      corrections: outcome.corrections,
      escalated: outcome.escalated,
    }),
    utility_score: utilityScore,
    conflict_count: conflictCount,
    contradiction_count: conflictCount,
    outcome,
    evidence: {
      question: normalizeLedgerText(exchange?.question || "", 180),
      commitments: context.commitments || [],
      constraint_violations: context.constraintViolations || [],
      resolution_score: context.resolutionScore ?? null,
      assistant_chars: context.assistantChars ?? null,
      verified_claims: context.verifiedClaims ?? 0,
      failed_claims: context.failedClaims ?? 0,
    },
    source_refs: context.sourceRefs || [],
    confidence: success ? 0.74 : 0.58,
    visibility: "local",
  };
}

export function writeDecisionRecord(workspace, record) {
  if (!workspace || !record) return null;
  return appendMemoryEvent(ledgerPath(workspace, "decisions"), {
    ...record,
    type: "decision",
  });
}

export function writeOutcomeRecord(workspace, record) {
  if (!workspace || !record) return null;
  return appendMemoryEvent(ledgerPath(workspace, "outcomes"), {
    ...record,
    type: "outcome",
  });
}

function sanitizeExchangeText(text) {
  return (text || "")
    .replace(/Conversation info \(untrusted metadata\):[\s\S]*?```[\s\S]*?```/gi, "")
    .replace(/Sender \(untrusted metadata\):[\s\S]*?```[\s\S]*?```/gi, "")
    .replace(/Current time:[^\n]+/gi, "")
    .replace(/^\[cron:[^\]]+\]\s*/gi, "")
    .replace(/^\[[A-Z][a-z]{2}\s[^\]]+\]\s*\[Subagent Context\][\s\S]*?\[Subagent Task\]:\s*/gi, "")
    .replace(/\[Subagent Context\][\s\S]*?\[Subagent Task\]:\s*/gi, "")
    .replace(/\[\[reply_to_current\]\]\s*/gi, "")
    .replace(/<\/?final>/gi, "")
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")
    .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMemsearchOutput(output, maxChars = 900) {
  const text = (output || "").trim();
  if (!text) return "";
  const blocks = text
    .split(/\n---+\n/)
    .map(s => s.trim())
    .filter(Boolean);
  if (blocks.length === 0) return trimToChars(text, maxChars);
  return trimToChars(blocks.slice(0, 2).join("\n\n---\n\n"), maxChars);
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function retrieveMatchingSections(query, content, maxSections = 2) {
  if (!content) return "";
  const terms = getQueryTerms(query);
  if (terms.length === 0) return "";

  const sections = content
    .split(/\n(?=## )/)
    .map(s => s.trim())
    .filter(s => s.startsWith("## "));

  const ranked = sections
    .map(section => ({
      section,
      hits: terms.filter(term => section.toLowerCase().includes(term)).length,
    }))
    .filter(entry => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, maxSections)
    .map(entry => entry.section);

  return ranked.join("\n\n");
}

function parseSpecializedMarkdownBlocks(content = "") {
  return content
    .split(/\n---\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(block => {
      const title = (block.match(/^##\s+(.+)$/m) || [])[1]?.trim() || "";
      const type = (block.match(/^- type:\s*(.+)$/m) || [])[1]?.trim() || "";
      const reinforced = Number((block.match(/^- reinforced:\s*(\d+)/m) || [])[1] || 1);
      const lastReinforced = (block.match(/^- last_reinforced:\s*(.+)$/m) || [])[1]?.trim() || "";
      return { title, type, reinforced, lastReinforced, block };
    });
}

function retrieveFromSpecializedStore(query, content, maxItems = 2) {
  if (!content.trim()) return { text: "", titles: [] };
  const terms = getQueryTerms(query);
  if (terms.length === 0) return { text: "", titles: [] };

  const blocks = parseSpecializedMarkdownBlocks(content);
  const ranked = blocks
    .map(entry => ({
      ...entry,
      hits: terms.filter(term => entry.block.toLowerCase().includes(term)).length,
    }))
    .filter(entry => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, maxItems);

  return {
    text: ranked.map(entry => entry.block).join("\n\n---\n\n"),
    titles: ranked.map(entry => entry.title).filter(Boolean),
  };
}

function reinforceSpecializedEntries(path, expectedType, titles = []) {
  if (!existsSync(path) || !titles.length) return [];
  const targetTitles = new Set(titles.map(title => title.toLowerCase().trim()).filter(Boolean));
  if (!targetTitles.size) return [];

  const header = readFileSync(path, "utf8").split("\n")[0] || "";
  const blocks = parseSpecializedMarkdownBlocks(readFileSync(path, "utf8"));
  const changed = [];
  const updated = blocks.map(entry => {
    if (!targetTitles.has(entry.title.toLowerCase().trim())) return entry.block.replace(/\n---\s*$/m, "").trim();
    if (expectedType && entry.type !== expectedType) return entry.block.replace(/\n---\s*$/m, "").trim();

    let block = entry.block.replace(/\n---\s*$/m, "").trim();
    const nextReinforced = (entry.reinforced || 1) + 1;
    if (/^- reinforced:\s*\d+/m.test(block)) {
      block = block.replace(/^- reinforced:\s*\d+/m, `- reinforced: ${nextReinforced}`);
    } else {
      block = block.replace(/^- trajectory:\s*.+$/m, match => `${match}\n- reinforced: ${nextReinforced}`);
    }
    if (/^- last_reinforced:\s*.+$/m.test(block)) {
      block = block.replace(/^- last_reinforced:\s*.+$/m, `- last_reinforced: ${new Date().toISOString().slice(0, 10)}`);
    } else {
      block = block.replace(/^- reinforced:\s*\d+/m, match => `${match}\n- last_reinforced: ${new Date().toISOString().slice(0, 10)}`);
    }
    changed.push(entry.title);
    return block;
  });

  const rebuilt = [header, "", ...updated.flatMap(block => [block, "", "---", ""])].join("\n").trimEnd() + "\n";
  writeFileSync(path, rebuilt, "utf8");
  return changed;
}

function shouldInjectProstheticMemory(query, openLoopsText = "", activeText = "") {
  const q = (query || "").toLowerCase();
  const openLoopCount = (openLoopsText.match(/^- /gm) || []).length;
  const signals = [
    /\bdrift|stuck|overwhelmed|scattered|confused|spiraling\b/.test(q),
    /\bscope|priorit|focus|next step|open loop|unfinished|blocked|blocker\b/.test(q),
    /\bcoherence|consistent|align|contradict|constraint\b/.test(q),
    /\bdecide|decision|choose|which path|what should\b/.test(q),
    openLoopCount >= 3,
    /\bconstraint|priority|avoid|must|only|without\b/.test(activeText.toLowerCase()),
  ];

  return signals.filter(Boolean).length >= 2;
}

function shouldInjectHigherOrderMemory(query, type = "general") {
  const q = (query || "").toLowerCase();
  const signals = [
    /\bpattern|model|framework|distinction|concept|theory|expertise|geniality|genius|abstraction\b/.test(q),
    /\bthink|thinking|reasoning|cognitive|mental model|approach|scope|drift\b/.test(q),
    /\bemotion|emotional|regulation|friction|fear|dread|overwhelm|shame\b/.test(q),
    /\btransfer|analogy|maps to|applies here|cross-domain|another area\b/.test(q),
    ["procedural", "personal"].includes(type),
  ];
  return signals.filter(Boolean).length >= 1;
}

function normalizeFactKey(text) {
  return safeSlug((text || "").replace(/\bpath\b/gi, "").trim(), "fact");
}

function readStableFacts(path) {
  const resolved = resolveExistingPath(path);
  if (!resolved) return [];
  return readFileSync(resolved, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => safeJsonParse(line, null))
    .filter(Boolean);
}

function writeStableFacts(path, facts) {
  const lines = facts.map(fact => JSON.stringify(fact));
  writeFileSync(path, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

function readJsonlObjects(path) {
  const resolved = resolveExistingPath(path);
  if (!resolved) return [];
  return readFileSync(resolved, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => safeJsonParse(line, null))
    .filter(Boolean);
}

function writeJsonlObjects(path, objects) {
  const lines = objects.map(object => JSON.stringify(object));
  writeFileSync(path, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

function inferScope(text = "") {
  const lowered = text.toLowerCase();
  if (/\badaptable discipline\b/.test(lowered)) return "adaptable_discipline";
  if (/\breturn\b|\breturn store\b|\bshopify\b/.test(lowered)) return "return";
  if (/\bobsidian\b|\bvault\b/.test(lowered)) return "obsidian";
  if (/\bopenbrain\b/.test(lowered)) return "openbrain";
  if (/\bopenclaw\b|\bfig\b/.test(lowered)) return "openclaw";
  if (/\bquorum\b/.test(lowered)) return "quorum";
  return "global";
}

function uniqueNormalized(lines = []) {
  const seen = new Set();
  return lines.filter(line => {
    const normalized = (line || "").toLowerCase().trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function splitProcedureSteps(text = "", maxSteps = 5) {
  const steps = [];
  const parts = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map(part => part.replace(/^[-*0-9.]+\s*/, "").trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part.length < 18) continue;
    if (/^\{/.test(part)) continue;
    steps.push(summarizeLine(part, 180));
    if (steps.length >= maxSteps) break;
  }
  return uniqueNormalized(steps);
}

function materializeStableContext(path, facts) {
  const topFacts = facts
    .filter(f => (f.confidence || 0) >= 0.75)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 8);
  const lines = [
    "# STABLE CONTEXT",
    "",
    ...topFacts.map(fact => `- ${fact.statement}`),
    "",
  ];
  writeFileSync(path, lines.join("\n"), "utf8");
}

function upsertStableFacts(storePath, materializedPath, newFacts = []) {
  if (!newFacts.length) return [];
  const existing = readStableFacts(storePath);
  const byKey = new Map(existing.map(fact => [fact.fact_key, fact]));
  const changed = [];

  for (const fact of newFacts) {
    if (!fact?.fact_key || !fact.statement) continue;
    const current = byKey.get(fact.fact_key);
    if (!current) {
      byKey.set(fact.fact_key, {
        fact_key: fact.fact_key,
        statement: fact.statement,
        source_type: fact.source_type || "observed",
        confidence: fact.confidence ?? 0.8,
        confirmed_at: fact.confirmed_at || new Date().toISOString(),
        last_updated_at: new Date().toISOString(),
        reinforcement_count: 1,
        contradictions: [],
      });
      changed.push(fact.fact_key);
      continue;
    }

    const sameStatement = current.statement === fact.statement;
    const contradictions = Array.isArray(current.contradictions) ? current.contradictions : [];
    if (!sameStatement) {
      contradictions.push({
        old_claim: current.statement,
        corrected_to: fact.statement,
        ts: new Date().toISOString(),
        source_type: fact.source_type || "observed",
      });
    }

    byKey.set(fact.fact_key, {
      ...current,
      statement: fact.statement,
      source_type: fact.source_type || current.source_type || "observed",
      confidence: Math.max(current.confidence || 0, fact.confidence || 0.8, sameStatement ? 0.82 : 0.9),
      confirmed_at: fact.confirmed_at || current.confirmed_at || new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
      reinforcement_count: (current.reinforcement_count || 0) + 1,
      contradictions,
    });
    changed.push(fact.fact_key);
  }

  const facts = [...byKey.values()].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  writeStableFacts(storePath, facts);
  materializeStableContext(materializedPath, facts);
  return changed;
}

function extractStableFacts(messages) {
  const facts = [];
  const seen = new Set();
  const texts = (messages || [])
    .filter(msg => msg?.role === "user" || msg?.role === "assistant")
    .map(msg => ({ role: msg.role, text: getMessageText(msg) }))
    .filter(entry => entry.text);

  for (const { role, text } of texts.slice(-8)) {
    let match = text.match(/\bobsidian vault\b.*?\b(?:is|at)\b[: ]+([A-Za-z]:[\\/][^\n]+|\/mnt\/[a-z]\/[^\n]+|\/[A-Za-z0-9._\-\/ ]+)/i);
    if (match) {
      const path = match[1].trim().replace(/[.)]+$/, "");
      const statement = `Obsidian vault root: \`${path}\``;
      const key = "obsidian_vault_path";
      if (!seen.has(`${key}:${path}`)) {
        seen.add(`${key}:${path}`);
        facts.push({
          fact_key: key,
          statement,
          source_type: role === "user" ? "user_confirmed" : "assistant_observed",
          confidence: role === "user" ? 0.95 : 0.8,
          confirmed_at: new Date().toISOString(),
        });
      }
    }

    if (/wsl/i.test(text) && /windows/i.test(text) && /vault/i.test(text)) {
      const statement = "User runs in WSL while the Obsidian vault lives on the Windows filesystem.";
      const key = "obsidian_vault_topology";
      if (!seen.has(key)) {
        seen.add(key);
        facts.push({
          fact_key: key,
          statement,
          source_type: role === "user" ? "user_confirmed" : "assistant_observed",
          confidence: role === "user" ? 0.95 : 0.78,
          confirmed_at: new Date().toISOString(),
        });
      }
    }
  }

  return facts;
}

function materializeConstraintContext(path, constraints) {
  const lines = [
    "# CONSTRAINTS",
    "",
  ];

  for (const constraint of constraints
    .filter(item => (item.strength || 0) >= 0.72)
    .sort((a, b) => (b.strength || 0) - (a.strength || 0))
    .slice(0, 12)) {
    lines.push(`## [${constraint.constraint_key}] ${constraint.scope || "global"}`);
    lines.push(`- statement: ${constraint.statement}`);
    lines.push(`- scope: ${constraint.scope || "global"}`);
    lines.push(`- strength: ${constraint.strength ?? 0.8}`);
    lines.push(`- reinforcement_count: ${constraint.reinforcement_count || 1}`);
    lines.push(`- conflict_count: ${constraint.conflict_count || 0}`);
    if (constraint.applies_to?.length) lines.push(`- applies_to: ${constraint.applies_to.join(", ")}`);
    if (constraint.superseded_claims?.length) lines.push(`- superseded_claims: ${constraint.superseded_claims.slice(0, 3).join(" | ")}`);
    lines.push("");
  }

  writeFileSync(path, lines.join("\n"), "utf8");
}

function materializeProcedureContext(path, procedures) {
  const lines = [
    "# PROCEDURES",
    "",
  ];

  for (const procedure of procedures
    .filter(item => (item.reuse_score || 0) >= 0.58)
    .sort((a, b) => (b.reuse_score || 0) - (a.reuse_score || 0))
    .slice(0, 12)) {
    lines.push(`## [${procedure.procedure_key}] ${procedure.goal}`);
    lines.push(`- scope: ${procedure.scope || "global"}`);
    lines.push(`- reuse_count: ${procedure.reuse_count || 1}`);
    lines.push(`- reuse_score: ${procedure.reuse_score ?? 0.6}`);
    lines.push(`- conflict_count: ${procedure.conflict_count || 0}`);
    if (procedure.preconditions?.length) lines.push(`- preconditions: ${procedure.preconditions.join("; ")}`);
    if (procedure.superseded_paths?.length) lines.push(`- superseded_paths: ${procedure.superseded_paths.slice(0, 3).join(" | ")}`);
    lines.push("");
    if (procedure.steps?.length) {
      for (const step of procedure.steps.slice(0, 5)) lines.push(`- ${step}`);
      lines.push("");
    }
  }

  writeFileSync(path, lines.join("\n"), "utf8");
}

function upsertConstraints(storePath, materializedPath, newConstraints = []) {
  if (!newConstraints.length) return [];
  const existing = readJsonlObjects(storePath);
  const byKey = new Map(existing.map(item => [item.constraint_key, item]));
  const changed = [];

  for (const constraint of newConstraints) {
    if (!constraint?.constraint_key || !constraint.statement) continue;
    const current = byKey.get(constraint.constraint_key);
    if (!current) {
      byKey.set(constraint.constraint_key, {
        constraint_key: constraint.constraint_key,
        statement: constraint.statement,
        scope: constraint.scope || "global",
        source_type: constraint.source_type || "user_explicit",
        strength: constraint.strength ?? 0.85,
        confirmed_by_user: constraint.confirmed_by_user !== false,
        applies_to: constraint.applies_to || [],
        created_at: constraint.created_at || new Date().toISOString(),
        last_confirmed_at: constraint.last_confirmed_at || new Date().toISOString(),
        reinforcement_count: 1,
        violations: [],
        superseded_claims: [],
        conflict_count: 0,
      });
      changed.push(constraint.constraint_key);
      continue;
    }

    byKey.set(constraint.constraint_key, {
      ...current,
      statement: constraint.statement || current.statement,
      scope: constraint.scope || current.scope || "global",
      source_type: constraint.source_type || current.source_type || "user_explicit",
      strength: Math.max(current.strength || 0, constraint.strength || 0.85),
      confirmed_by_user: constraint.confirmed_by_user ?? current.confirmed_by_user ?? true,
      applies_to: uniqueNormalized([...(current.applies_to || []), ...(constraint.applies_to || [])]),
      last_confirmed_at: constraint.last_confirmed_at || new Date().toISOString(),
      reinforcement_count: (current.reinforcement_count || 0) + 1,
      violations: current.violations || [],
      superseded_claims: current.superseded_claims || [],
      conflict_count: current.conflict_count || 0,
    });
    changed.push(constraint.constraint_key);
  }

  const constraints = [...byKey.values()].sort((a, b) => (b.strength || 0) - (a.strength || 0));
  writeJsonlObjects(storePath, constraints);
  materializeConstraintContext(materializedPath, constraints);
  return changed;
}

function upsertProcedures(storePath, materializedPath, newProcedures = []) {
  if (!newProcedures.length) return [];
  const existing = readJsonlObjects(storePath);
  const byKey = new Map(existing.map(item => [item.procedure_key, item]));
  const changed = [];

  for (const procedure of newProcedures) {
    if (!procedure?.procedure_key || !procedure.goal) continue;
    const current = byKey.get(procedure.procedure_key);
    if (!current) {
      byKey.set(procedure.procedure_key, {
        procedure_key: procedure.procedure_key,
        goal: procedure.goal,
        scope: procedure.scope || "global",
        steps: uniqueNormalized(procedure.steps || []),
        preconditions: uniqueNormalized(procedure.preconditions || []),
        success_signals: uniqueNormalized(procedure.success_signals || []),
        failure_signals: uniqueNormalized(procedure.failure_signals || []),
        source_examples: uniqueNormalized(procedure.source_examples || []),
        last_success_at: procedure.last_success_at || new Date().toISOString(),
        reuse_count: 1,
        reuse_score: procedure.reuse_score ?? 0.62,
        superseded_paths: [],
        conflict_count: 0,
      });
      changed.push(procedure.procedure_key);
      continue;
    }

    byKey.set(procedure.procedure_key, {
      ...current,
      goal: procedure.goal || current.goal,
      scope: procedure.scope || current.scope || "global",
      steps: uniqueNormalized([...(current.steps || []), ...(procedure.steps || [])]).slice(0, 8),
      preconditions: uniqueNormalized([...(current.preconditions || []), ...(procedure.preconditions || [])]).slice(0, 5),
      success_signals: uniqueNormalized([...(current.success_signals || []), ...(procedure.success_signals || [])]).slice(0, 5),
      failure_signals: uniqueNormalized([...(current.failure_signals || []), ...(procedure.failure_signals || [])]).slice(0, 5),
      source_examples: uniqueNormalized([...(current.source_examples || []), ...(procedure.source_examples || [])]).slice(0, 6),
      last_success_at: procedure.last_success_at || new Date().toISOString(),
      reuse_count: (current.reuse_count || 0) + 1,
      reuse_score: Math.max(current.reuse_score || 0, procedure.reuse_score || 0.62),
      superseded_paths: current.superseded_paths || [],
      conflict_count: current.conflict_count || 0,
    });
    changed.push(procedure.procedure_key);
  }

  const procedures = [...byKey.values()].sort((a, b) => (b.reuse_score || 0) - (a.reuse_score || 0));
  writeJsonlObjects(storePath, procedures);
  materializeProcedureContext(materializedPath, procedures);
  return changed;
}

function extractConstraints(messages) {
  const constraints = [];
  const seen = new Set();
  const recent = (messages || [])
    .filter(msg => msg?.role === "user")
    .slice(-10)
    .map(msg => getMessageText(msg))
    .filter(Boolean);

  for (const text of recent) {
    const scope = inferScope(text);
    const sentences = text
      .split(/[.\n]/)
      .map(sentence => sentence.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      if (sentence.length < 14 || sentence.length > 220) continue;
      if (!/\b(don't|do not|should not|must not|never|without|avoid|i don't want|i do not want|no links?|only|keep .* out)\b/i.test(sentence)) continue;
      const statement = summarizeLine(sentence, 180);
      const key = `constraint_${safeSlug(`${scope}-${statement}`, "constraint")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      constraints.push({
        constraint_key: key,
        statement,
        scope,
        source_type: "user_explicit",
        strength: /\bmust not|never|do not|don't|i don't want|i do not want\b/i.test(sentence) ? 0.94 : 0.84,
        confirmed_by_user: true,
        applies_to: [scope],
        last_confirmed_at: new Date().toISOString(),
      });
      if (constraints.length >= 6) return constraints;
    }
  }

  return constraints;
}

function extractProcedures(messages) {
  const exchange = extractExchange(messages);
  if (!exchange?.question || !exchange?.response) return [];
  const queryType = classifyQuery(exchange.question);
  const userText = exchange.question;
  const scope = inferScope(`${exchange.question}\n${exchange.response}`);
  const proceduralSignal = queryType === "procedural"
    || /\b(access|token|credential|api key|shopify|query|recover|get the email|find the email|retrieve|look up)\b/i.test(userText);
  if (!proceduralSignal) return [];

  const goal = summarizeLine(userText, 180);
  const steps = splitProcedureSteps(exchange.response, 5);
  if (steps.length === 0) return [];

  return [{
    procedure_key: `procedure_${safeSlug(`${scope}-${goal}`, "procedure")}`,
    goal,
    scope,
    steps,
    preconditions: /\bcredential|token|auth|api\b/i.test(exchange.response) ? ["Required credentials or auth context available"] : [],
    success_signals: [
      /\bfound|retrieved|queried|verified|resolved|confirmed\b/i.test(exchange.response)
        ? "Requested information or state is confirmed."
        : "Task completes without re-asking the user for already-known inputs.",
    ],
    failure_signals: [
      "Repeatedly asks the user to re-supply already-solved information.",
      "Falls back to blind rediscovery before checking prior working methods.",
    ],
    source_examples: [goal],
    last_success_at: new Date().toISOString(),
    reuse_score: /\baccess|credential|token|shopify|email\b/i.test(userText) ? 0.8 : 0.64,
  }];
}

function retrieveFromObjectStore(query, objects = [], options = {}) {
  const terms = getQueryTerms(query);
  if (terms.length === 0 || objects.length === 0) return "";
  const maxItems = options.maxItems ?? 3;
  const lines = objects
    .map(object => {
      const text = options.toSearchText ? options.toSearchText(object) : JSON.stringify(object);
      const lowered = (text || "").toLowerCase();
      const hits = terms.filter(term => lowered.includes(term)).length;
      const weight = Number(options.weightFor ? options.weightFor(object) : 0);
      return { object, score: hits + weight };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map(entry => options.toRender ? options.toRender(entry.object) : JSON.stringify(entry.object, null, 2));

  return lines.join("\n\n");
}

function getRelevantConstraints(query = "", constraints = []) {
  if (!constraints.length) return [];
  const scope = inferScope(query);
  const lowered = query.toLowerCase();
  return constraints
    .filter(item =>
      item.scope === "global"
      || item.scope === scope
      || (item.applies_to || []).includes(scope)
    )
    .map(item => {
      const hay = `${item.statement || ""} ${item.scope || ""} ${(item.applies_to || []).join(" ")}`.toLowerCase();
      const terms = getQueryTerms(query);
      const hits = terms.filter(term => hay.includes(term)).length;
      const scopeBoost = item.scope === scope || (item.applies_to || []).includes(scope) ? 1.25 : 0;
      return { item, score: hits + constraintWeight(item) + scopeBoost + (lowered.includes("adaptable discipline") && hay.includes("adaptable discipline") ? 1 : 0) };
    })
    .filter(entry => entry.score > 0.6)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
}

function isHardNegativeConstraint(statement = "") {
  return /\b(don't|do not|should not|must not|never|without|avoid|keep .* out|no\b)\b/i.test(statement);
}

function buildConstraintPolicyNote(query = "", constraints = []) {
  const relevant = getRelevantConstraints(query, constraints)
    .filter(item => isHardNegativeConstraint(item.statement || ""))
    .slice(0, 4);
  if (!relevant.length) return "";

  const bullets = relevant.map(item => `- ${item.statement}`);
  return [
    "<!-- brain-constraint-policy -->",
    "Constraint policy: the following user constraints are active and override opportunistic suggestions.",
    "Do not propose, repeat, summarize, or endorse actions that violate them.",
    "If an existing file, prior plan, or retrieved artifact conflicts with these constraints, explicitly flag the conflict and revise the output to preserve the constraint instead of repeating the violating recommendation.",
    ...bullets,
  ].join("\n");
}

function isApprovalConstraint(statement = "") {
  return /\b(approval|approve|without my approval|ask first|one-way|one way door)\b/i.test(statement);
}

function queryLooksHighImpactChange(query = "") {
  const lowered = (query || "").toLowerCase();
  if (!lowered) return false;
  const changeSignal = /\b(change|edit|rewrite|replace|remove|delete|migrate|retire|switch|rebuild|backfill|cleanup|update)\b/.test(lowered);
  const systemSignal = /\b(prompt|scheduler|queue|cadence|policy|runtime|agent|workflow|publisher|cron|config|default model|routing)\b/.test(lowered);
  const deploymentSignal = /\b(live|production|default|for everyone|going forward|from now on)\b/.test(lowered);
  return (changeSignal && systemSignal) || (systemSignal && deploymentSignal);
}

function buildApprovalGateNote(query = "", constraints = []) {
  const relevant = getRelevantConstraints(query, constraints)
    .filter(item => isApprovalConstraint(item.statement || ""))
    .slice(0, 3);
  if (!relevant.length && !queryLooksHighImpactChange(query)) return "";

  const bullets = relevant.length
    ? relevant.map(item => `- ${item.statement}`)
    : ["- Do not execute high-impact operational or policy changes without explicit user approval."];
  return [
    "<!-- brain-approval-gate -->",
    "Approval gate: this request appears to involve a potentially one-way operational change.",
    "Do not silently execute prompt rewrites, scheduler/cadence changes, queue policy changes, deletion or retirement of live components, or default-routing changes without explicit user approval in the current conversation.",
    "You may analyze, propose, simulate, or prepare the change, but get confirmation before applying it live.",
    ...bullets,
  ].join("\n");
}

function constraintWeight(object) {
  return (object.strength || 0)
    + ((object.reinforcement_count || 0) * 0.04)
    + ((object.conflict_count || 0) * 0.18);
}

function procedureWeight(object) {
  return (object.reuse_score || 0)
    + ((object.reuse_count || 0) * 0.05)
    + ((object.conflict_count || 0) * 0.16);
}

function extractPathsFromText(text = "") {
  const matches = text.match(/(?:\/mnt\/[^\s)]+|\/home\/[^\s)]+|[A-Za-z]:\\[^\s)]+)/g) || [];
  return uniqueNormalized(matches.map(match => match.replace(/[.,]+$/, ""))).slice(0, 6);
}

function detectArtifactClaims(text = "") {
  const lowered = (text || "").toLowerCase();
  if (!/\b(saved|moved|wrote|created|added|updated)\b/.test(lowered)) return [];
  const paths = extractPathsFromText(text);
  if (paths.length === 0) return [];

  let action = "updated";
  if (/\bmoved\b/.test(lowered)) action = "moved";
  else if (/\bsaved\b/.test(lowered)) action = "saved";
  else if (/\bwrote\b/.test(lowered)) action = "wrote";
  else if (/\bcreated\b/.test(lowered) || /\badded\b/.test(lowered)) action = "created";

  return paths.map(path => ({ action, path }));
}

function extractReferencedArtifactPaths(text = "") {
  const cited = [
    ...(text.match(/`([^`\n]+\.md)`/g) || []).map(match => match.slice(1, -1)),
    ...(text.match(/\b[A-Za-z0-9 _\-\/]+\/[A-Za-z0-9 _\-]+\.md\b/g) || []),
  ];
  return uniqueNormalized(
    cited
      .map(item => item.trim().replace(/[.,]+$/, ""))
      .filter(item => item.includes("/") && !item.startsWith("/home/") && !item.startsWith("/mnt/"))
  ).slice(0, 6);
}

function detectUnverifiedArtifactClaim(text = "") {
  const lowered = (text || "").toLowerCase();
  if (!/\b(saved|moved|wrote|created|added|updated)\b/.test(lowered)) return null;
  const explicitPaths = extractPathsFromText(text);
  if (explicitPaths.length > 0) return null;
  if (!/\b(file|vault|note|doc|document|image|plan|markdown|md)\b/.test(lowered)) return null;

  let action = "updated";
  if (/\bmoved\b/.test(lowered)) action = "moved";
  else if (/\bsaved\b/.test(lowered)) action = "saved";
  else if (/\bwrote\b/.test(lowered)) action = "wrote";
  else if (/\bcreated\b/.test(lowered) || /\badded\b/.test(lowered)) action = "created";

  return {
    action,
    claim: summarizeLine(text, 220),
  };
}

function upsertCommitments(storePath, commitments = []) {
  if (!commitments.length) return [];
  const existing = readJsonlObjects(storePath);
  const byKey = new Map(existing.map(item => [item.commitment_key, item]));
  const changed = [];

  for (const commitment of commitments) {
    if (!commitment?.commitment_key) continue;
    const current = byKey.get(commitment.commitment_key);
    if (!current) {
      byKey.set(commitment.commitment_key, commitment);
      changed.push(commitment.commitment_key);
      continue;
    }
    byKey.set(commitment.commitment_key, {
      ...current,
      ...commitment,
      updated_at: new Date().toISOString(),
    });
    changed.push(commitment.commitment_key);
  }

  writeJsonlObjects(storePath, [...byKey.values()].slice(-300));
  return changed;
}

function upsertArtifacts(storePath, artifacts = []) {
  if (!artifacts.length) return [];
  const existing = readJsonlObjects(storePath);
  const byKey = new Map(existing.map(item => [item.artifact_key, item]));
  const changed = [];

  for (const artifact of artifacts) {
    if (!artifact?.artifact_key) continue;
    const current = byKey.get(artifact.artifact_key);
    if (!current) {
      byKey.set(artifact.artifact_key, artifact);
      changed.push(artifact.artifact_key);
      continue;
    }
    byKey.set(artifact.artifact_key, {
      ...current,
      ...artifact,
      updated_at: new Date().toISOString(),
    });
    changed.push(artifact.artifact_key);
  }

  writeJsonlObjects(storePath, [...byKey.values()].slice(-300));
  return changed;
}

function buildCommitmentsFromExchange(sessionId, exchange) {
  if (!exchange?.response) return { commitments: [], artifacts: [] };
  const claims = detectArtifactClaims(exchange.response);
  const unverifiedClaim = detectUnverifiedArtifactClaim(exchange.response);
  const commitments = [];
  const artifacts = [];

  for (const claim of claims) {
    const exists = existsSync(claim.path);
    const commitmentKey = `commitment_${safeSlug(`${claim.action}-${claim.path}`, "commitment")}`;
    const artifactKey = `artifact_${safeSlug(claim.path, "artifact")}`;
    commitments.push({
      commitment_key: commitmentKey,
      claim: `${claim.action} ${claim.path}`,
      task_context: summarizeLine(exchange.question, 180),
      target_artifact: artifactKey,
      intended_path: claim.path,
      actual_path: exists ? claim.path : null,
      verification_status: exists ? "verified" : "missing",
      created_at: new Date().toISOString(),
      resolved_at: exists ? new Date().toISOString() : null,
      session_id: sessionId,
    });
    artifacts.push({
      artifact_key: artifactKey,
      title: claim.path.split("/").pop() || claim.path,
      path: claim.path,
      created_by: "assistant",
      created_at: new Date().toISOString(),
      task_context: summarizeLine(exchange.question, 180),
      declared_destination: claim.path,
      verified_written: exists,
      session_id: sessionId,
    });
  }

  if (commitments.length === 0 && unverifiedClaim) {
    commitments.push({
      commitment_key: `commitment_${safeSlug(`${unverifiedClaim.action}-${Date.now()}`, "commitment")}`,
      claim: unverifiedClaim.claim,
      task_context: summarizeLine(exchange.question, 180),
      target_artifact: null,
      intended_path: null,
      actual_path: null,
      verification_status: "unverified",
      created_at: new Date().toISOString(),
      resolved_at: null,
      session_id: sessionId,
    });
  }

  return { commitments, artifacts };
}

function upsertConflictArtifacts(storePath, conflicts = []) {
  if (!conflicts.length) return [];
  const existing = readJsonlObjects(storePath);
  const byKey = new Map(existing.map(item => [item.conflict_key, item]));
  const changed = [];

  for (const conflict of conflicts) {
    if (!conflict?.conflict_key) continue;
    const current = byKey.get(conflict.conflict_key);
    if (!current) {
      byKey.set(conflict.conflict_key, conflict);
      changed.push(conflict.conflict_key);
      continue;
    }
    byKey.set(conflict.conflict_key, {
      ...current,
      ...conflict,
      conflict_count: (current.conflict_count || 0) + 1,
      updated_at: new Date().toISOString(),
      evidence: uniqueNormalized([...(current.evidence || []), ...(conflict.evidence || [])]).slice(0, 8),
      constraint_keys: uniqueNormalized([...(current.constraint_keys || []), ...(conflict.constraint_keys || [])]),
    });
    changed.push(conflict.conflict_key);
  }

  writeJsonlObjects(storePath, [...byKey.values()].slice(-200));
  return changed;
}

function buildArtifactConflictNote(query = "", constraints = [], conflictArtifacts = []) {
  const scope = inferScope(query);
  const relevantConstraints = getRelevantConstraints(query, constraints).filter(item => isHardNegativeConstraint(item.statement || ""));
  if (!relevantConstraints.length || !conflictArtifacts.length) return "";

  const relevantConflicts = conflictArtifacts
    .filter(item =>
      item.scope === scope
      || item.scope === "global"
      || (item.constraint_keys || []).some(key => relevantConstraints.some(constraint => constraint.constraint_key === key))
    )
    .sort((a, b) => (b.conflict_count || 0) - (a.conflict_count || 0))
    .slice(0, 3);

  if (!relevantConflicts.length) return "";

  const lines = [
    "<!-- brain-artifact-conflicts -->",
    "Known conflicting artifacts: these files or plans previously violated active constraints. Do not reuse, summarize, or endorse their conflicting recommendations without explicitly correcting them.",
  ];
  for (const conflict of relevantConflicts) {
    lines.push(`- ${conflict.path}: conflicts with ${conflict.constraint_keys?.join(", ") || "active constraints"}`);
  }
  return lines.join("\n");
}

function findLatestRoleMessage(messages, role) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === role) return msg;
  }
  return null;
}

function findPreviousAssistantBeforeLastUser(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  let sawLastUser = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!sawLastUser && msg?.role === "user") {
      sawLastUser = true;
      continue;
    }
    if (sawLastUser && msg?.role === "assistant") return msg;
  }
  return null;
}

function detectFailureTax(messages, stableFactsPath) {
  const latestUser = findLatestRoleMessage(messages, "user");
  const previousAssistant = findPreviousAssistantBeforeLastUser(messages);
  if (!latestUser || !previousAssistant) return null;

  const userText = (getMessageText(latestUser) || "").trim();
  const assistantText = (getMessageText(previousAssistant) || "").trim();
  if (!userText || !assistantText) return null;

  const correctionSignal = /\b(that'?s wrong|that is wrong|wrong\b|no\.|no,|actually\b|it'?s actually|its actually|you are in wsl|you're in wsl|not that|not correct)\b/i.test(userText);
  if (!correctionSignal) return null;

  const stableFacts = readStableFacts(stableFactsPath);
  const matchedFactKeys = stableFacts
    .filter(fact => {
      const terms = getQueryTerms(`${fact.fact_key} ${fact.statement}`);
      return terms.some(term => userText.toLowerCase().includes(term) || assistantText.toLowerCase().includes(term));
    })
    .map(fact => fact.fact_key)
    .slice(0, 4);

  return {
    previous_model: previousAssistant.model || null,
    correction_text: summarizeLine(userText, 220),
    previous_answer: summarizeLine(assistantText, 220),
    matched_fact_keys: matchedFactKeys,
    recommended_route: matchedFactKeys.length > 0 ? "anthropic/claude-sonnet-4-6" : "deepseek/deepseek-reasoner",
    correction_type: matchedFactKeys.length > 0 ? "stable_fact_correction" : "general_user_correction",
  };
}

function recordContradictionEvent(storePath, event) {
  if (!event?.target_key || !event?.target_type) return false;
  const existing = readJsonlObjects(storePath);
  const record = {
    contradiction_key: `contradiction_${safeSlug(`${event.target_type}-${event.target_key}-${Date.now()}`, "contradiction")}`,
    target_key: event.target_key,
    target_type: event.target_type,
    claim: event.claim || "",
    corrected_to: event.corrected_to || "",
    correction_source: event.correction_source || "user_correction",
    model: event.model || null,
    task_class: event.task_class || "unknown",
    severity: event.severity || "medium",
    timestamp: event.timestamp || new Date().toISOString(),
    session_id: event.session_id || null,
  };
  existing.push(record);
  writeJsonlObjects(storePath, existing.slice(-300));
  return true;
}

function reinforceConstraintFromCorrection(storePath, materializedPath, matchedKeys = [], correctionText = "") {
  if (!matchedKeys.length) return [];
  const constraints = readJsonlObjects(storePath);
  const changed = [];
  const updated = constraints.map(item => {
    if (!matchedKeys.includes(item.constraint_key)) return item;
    changed.push(item.constraint_key);
    return {
      ...item,
      strength: Math.min(0.99, Math.max(item.strength || 0.8, 0.92)),
      reinforcement_count: (item.reinforcement_count || 0) + 1,
      last_confirmed_at: new Date().toISOString(),
      violations: uniqueNormalized([...(item.violations || []), summarizeLine(correctionText, 180)]),
      conflict_count: (item.conflict_count || 0) + 1,
      superseded_claims: uniqueNormalized([...(item.superseded_claims || []), summarizeLine(correctionText, 180)]).slice(0, 8),
    };
  });
  if (changed.length) {
    writeJsonlObjects(storePath, updated);
    materializeConstraintContext(materializedPath, updated);
  }
  return changed;
}

function reinforceProcedureFromCorrection(storePath, materializedPath, matchedKeys = [], correctionText = "") {
  if (!matchedKeys.length) return [];
  const procedures = readJsonlObjects(storePath);
  const changed = [];
  const updated = procedures.map(item => {
    if (!matchedKeys.includes(item.procedure_key)) return item;
    changed.push(item.procedure_key);
    return {
      ...item,
      reuse_score: Math.min(0.99, Math.max(item.reuse_score || 0.62, 0.82)),
      reuse_count: (item.reuse_count || 0) + 1,
      last_success_at: new Date().toISOString(),
      failure_signals: uniqueNormalized([...(item.failure_signals || []), summarizeLine(correctionText, 180)]).slice(0, 6),
      conflict_count: (item.conflict_count || 0) + 1,
      superseded_paths: uniqueNormalized([...(item.superseded_paths || []), summarizeLine(correctionText, 180)]).slice(0, 8),
    };
  });
  if (changed.length) {
    writeJsonlObjects(storePath, updated);
    materializeProcedureContext(materializedPath, updated);
  }
  return changed;
}

function findMatchingConstraintKeys(userText = "", assistantText = "", storePath) {
  const constraints = readJsonlObjects(storePath);
  return constraints
    .filter(item => {
      const hay = `${userText} ${assistantText}`.toLowerCase();
      const terms = getQueryTerms(`${item.statement} ${item.scope} ${(item.applies_to || []).join(" ")}`);
      return terms.some(term => hay.includes(term));
    })
    .map(item => item.constraint_key)
    .slice(0, 4);
}

function findMatchingProcedureKeys(userText = "", assistantText = "", storePath) {
  const procedures = readJsonlObjects(storePath);
  return procedures
    .filter(item => {
      const hay = `${userText} ${assistantText}`.toLowerCase();
      const terms = getQueryTerms(`${item.goal} ${(item.steps || []).join(" ")} ${(item.source_examples || []).join(" ")}`);
      return terms.some(term => hay.includes(term));
    })
    .map(item => item.procedure_key)
    .slice(0, 4);
}

function negativeConstraintTerms(statement = "") {
  return getQueryTerms(
    statement
      .replace(/\b(don't|do not|should not|must not|never|without|avoid|only|keep)\b/gi, " ")
      .replace(/\b(add|include|use|put|place|bring|insert)\b/gi, " ")
      .replace(/\b(the|and|into|from|with|your|this|that)\b/gi, " ")
  ).slice(0, 8);
}

function detectConstraintViolations(query = "", response = "", storePath) {
  const constraints = readJsonlObjects(storePath);
  if (!constraints.length || !response) return [];

  const scope = inferScope(`${query}\n${response}`);
  const loweredResponse = response.toLowerCase();
  const relevant = constraints.filter(item =>
    item.scope === "global"
    || item.scope === scope
    || (item.applies_to || []).includes(scope)
  );
  const violations = [];

  for (const constraint of relevant) {
    const statement = (constraint.statement || "").toLowerCase();
    let violated = false;

    if (/\b(store links?|links? to .*store|add links?)\b/.test(statement)) {
      violated = /https?:\/\/|www\.|]\(|\breturn store\b|\bshopify\b|\bstore\b/.test(loweredResponse);
    } else if (/\bwithout\b|\bavoid\b|\bdo not\b|\bdon't\b|\bmust not\b|\bshould not\b|\bnever\b/.test(statement)) {
      const terms = negativeConstraintTerms(statement);
      const matched = terms.filter(term => loweredResponse.includes(term));
      violated = matched.length >= 2 || (matched.length >= 1 && terms.some(term => /link|store|shopify|email|credential|token/.test(term)));
    }

    if (violated) {
      violations.push({
        constraint_key: constraint.constraint_key,
        scope: constraint.scope || "global",
        statement: constraint.statement,
      });
    }
  }

  return violations.slice(0, 4);
}

function recordConstraintViolations(storePath, materializedPath, violations = [], response = "") {
  if (!violations.length) return [];
  const constraints = readJsonlObjects(storePath);
  const keys = violations.map(item => item.constraint_key);
  const changed = [];
  const updated = constraints.map(item => {
    if (!keys.includes(item.constraint_key)) return item;
    changed.push(item.constraint_key);
    return {
      ...item,
      violations: uniqueNormalized([...(item.violations || []), summarizeLine(response, 180)]).slice(0, 10),
      conflict_count: (item.conflict_count || 0) + 1,
      last_confirmed_at: item.last_confirmed_at || new Date().toISOString(),
    };
  });
  if (changed.length) {
    writeJsonlObjects(storePath, updated);
    materializeConstraintContext(materializedPath, updated);
  }
  return changed;
}

function detectClarificationSignal(text = "") {
  return /\b(what do you mean|can you explain|be more specific|which one|where exactly|how so|i don't understand|that doesn't answer|not what i asked|try again)\b/i.test(text);
}

function chooseEscalationRoute(queryText = "", matchedFactKeys = []) {
  if (matchedFactKeys.length > 0) return "anthropic/claude-sonnet-4-6";
  const type = classifyQuery(queryText);
  if (type === "procedural" || type === "factual" || type === "personal" || type === "episodic") {
    return "anthropic/claude-sonnet-4-6";
  }
  return "deepseek/deepseek-reasoner";
}

// ── Retrieval ──────────────────────────────────────────────────────────────────
function retrieveFromMind(query, mindMd) {
  if (!mindMd) return "";
  const terms = getQueryTerms(query);
  if (terms.length === 0) return "";

  const sections = mindMd
    .split(/\n---\n/)
    .map(s => s.trim())
    .filter(s => s.startsWith("## ["));

  const scored = sections
    .map(s => ({ s, hits: terms.filter(t => s.toLowerCase().includes(t)).length }))
    .filter(e => e.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4);

  return scored.map(e => e.s).join("\n\n---\n\n");
}

function retrieveFromSessions(query, workspace, daysBack = 14, options = {}) {
  const terms = getQueryTerms(query);
  if (terms.length === 0) return "";
  const results = [];
  const today   = new Date();

  const scope = memoryPaths(workspace, options.source || {});
  const sessionsDirs = [scope.sessionsDir, scope.sessionsFallbackDir];
  for (const sessionsDir of sessionsDirs) {
    if (!existsSync(sessionsDir)) continue;
    for (const f of readdirSync(sessionsDir).sort().reverse().slice(0, 30)) {
      if (!f.endsWith(".md")) continue;
      const raw  = readFileSync(join(sessionsDir, f), "utf8");
      const hits = terms.filter(t => raw.toLowerCase().includes(t)).length;
      if (hits >= 2) results.push(raw.slice(0, 400));
    }
  }

  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    for (const root of [scope.legacyRoot, scope.sharedRoot, scope.privateRoot]) {
      const path = join(root, `${dateStr}.md`);
      if (!existsSync(path)) continue;

      const content    = readFileSync(path, "utf8");
      const paragraphs = content.split(/\n\n+/);
      for (const p of paragraphs) {
        if (p.trim().length < 50) continue;
        const hits = terms.filter(t => p.toLowerCase().includes(t)).length;
        if (hits >= 2) results.push(`[${dateStr}] ${p.trim().slice(0, 300)}`);
      }
    }
  }

  return results.slice(0, 6).join("\n\n");
}

export function buildRetrievalContext(type, query, workspace, options = {}) {
  if (type === "temporal") {
    return {
      context: "<!-- brain: temporal query — prefer web search over memory for current information -->",
      layersUsed: [],
      tierChars: { stable: 0, semi_stable: 0, volatile: 0 },
      tierHashes: { stable: hashString(""), semi_stable: hashString(""), volatile: hashString("") },
      cacheFriendly: true,
    };
  }

  const scope = memoryPaths(workspace, options.source || {});
  const hotCachePath = options.hotCachePath || scope.hotCache;
  const stablePath  = options.stablePath || scope.stableContext;
  const stableFactsPath = options.stableFactsPath || scope.stableFacts;
  const constraintsPath = options.constraintsPath || scope.constraintsJsonl;
  const proceduresPath = options.proceduresPath || scope.proceduresJsonl;
  const activePath  = options.activePath || scope.active;
  const openLoopsPath = options.openLoopsPath || scope.openLoops;
  const handoffPath = options.handoffPath || scope.handoff;
  const driftPath   = options.driftPath || scope.driftPatterns;
  const compensationPath = options.compensationPath || scope.compensationStrategies;
  const conceptualPath = options.conceptualPath || scope.conceptual;
  const cognitivePath = options.cognitivePath || scope.cognitive;
  const emotionalPath = options.emotionalPath || scope.emotional;
  const transferPath = options.transferPath || scope.transfer;
  const mindMd      = readPreferredText(options.mindPath || scope.mind, scope.mindFallback);
  const parts       = [];
  const higherOrderHits = {
    conceptual_titles: [],
    cognitive_titles: [],
    emotional_titles: [],
    transfer_titles: [],
  };
  const activeMemoryEnabled = options.activeMemoryEnabled !== false;
  const stableContextEnabled = options.stableContextEnabled !== false;
  const active = activeMemoryEnabled
    ? trimToChars(readPreferredText(activePath, scope.activeFallback), options.activeMaxChars ?? 900)
    : "";
  const openLoops = activeMemoryEnabled
    ? trimToChars(readPreferredText(openLoopsPath, scope.openLoopsFallback), options.openLoopsMaxChars ?? 700)
    : "";
  const handoff = activeMemoryEnabled
    ? trimToChars(readPreferredText(handoffPath, scope.handoffFallback), options.handoffMaxChars ?? 550)
    : "";

  if (stableContextEnabled) {
    const hotCache = trimToChars(readPreferredText(hotCachePath, scope.hotCacheFallback), options.hotCacheMaxChars ?? 500);
    if (hotCache) parts.push({
      title: "Hot cache (L0)",
      layer: "hot_cache",
      tier: "stable",
      body: hotCache,
    });

    const stableFactsSourcePath = firstExistingPath(stableFactsPath, scope.stableFactsFallback);
    const stableFacts = readStableFacts(stableFactsSourcePath);
    const stableSource = stableFacts.length > 0
      ? stableFacts
          .slice(0, 8)
          .map(fact => `- ${fact.statement}`)
          .join("\n")
      : readPreferredText(stablePath, scope.stableContextFallback);
    const stableContext = trimToChars(stableSource, options.stableContextMaxChars ?? 500);
    if (stableContext) parts.push({
      title: "Stable context",
      layer: "stable_context",
      tier: "stable",
      body: stableContext,
    });
  }

  if (handoff) parts.push({
    title: "State handoff",
    layer: "handoff",
    tier: "volatile",
    body: handoff,
  });

  const constraints = readPreferredJsonl(constraintsPath, scope.constraintsJsonlFallback);
  const constraintMatches = retrieveFromObjectStore(query, constraints, {
    maxItems: 3,
    weightFor: constraintWeight,
    toSearchText: object => [object.statement, object.scope, ...(object.applies_to || [])].join(" "),
    toRender: object => `## [${object.constraint_key}] ${object.scope || "global"}\n- statement: ${object.statement}\n- scope: ${object.scope || "global"}\n- conflict_count: ${object.conflict_count || 0}${object.applies_to?.length ? `\n- applies_to: ${object.applies_to.join(", ")}` : ""}`,
  });
  if (constraintMatches) parts.push({
    title: "Active constraints",
    layer: "constraints",
    tier: "stable",
    body: trimToChars(constraintMatches, options.constraintMaxChars ?? 700),
  });

  const procedures = readPreferredJsonl(proceduresPath, scope.proceduresJsonlFallback);
  const procedureMatches = retrieveFromObjectStore(query, procedures, {
    maxItems: 2,
    weightFor: procedureWeight,
    toSearchText: object => [
      object.goal,
      object.scope,
      ...(object.steps || []),
      ...(object.preconditions || []),
      ...(object.source_examples || []),
    ].join(" "),
    toRender: object => {
      const steps = (object.steps || []).slice(0, 4).map(step => `- ${step}`).join("\n");
      return `## [${object.procedure_key}] ${object.goal}\n- scope: ${object.scope || "global"}\n- reuse_count: ${object.reuse_count || 1}\n- conflict_count: ${object.conflict_count || 0}${object.preconditions?.length ? `\n- preconditions: ${object.preconditions.join("; ")}` : ""}\n${steps}`;
    },
  });
  if (procedureMatches) parts.push({
    title: "Relevant proven procedures",
    layer: "procedures",
    tier: "semi_stable",
    body: trimToChars(procedureMatches, options.procedureMaxChars ?? 800),
  });

  const mindResults = retrieveFromMind(query, mindMd);
  if (mindResults) parts.push({
    title: "Relevant memories (L1)",
    layer: "mind",
    tier: "semi_stable",
    body: trimToChars(mindResults, options.mindMaxChars ?? 900),
  });

  if (options.prostheticMemoryEnabled && shouldInjectProstheticMemory(query, openLoops, active)) {
    const driftMatches = retrieveMatchingSections(query, readPreferredText(driftPath, scope.driftPatternsFallback), 2);
    if (driftMatches) parts.push({
      title: "Relevant drift patterns",
      layer: "drift_patterns",
      tier: "semi_stable",
      body: trimToChars(driftMatches, options.driftMaxChars ?? 500),
    });

    const compensationMatches = retrieveMatchingSections(query, readPreferredText(compensationPath, scope.compensationFallback), 2);
    if (compensationMatches) parts.push({
      title: "Relevant compensation strategies",
      layer: "compensation_strategies",
      tier: "semi_stable",
      body: trimToChars(compensationMatches, options.compensationMaxChars ?? 500),
    });
  }

  if (shouldInjectHigherOrderMemory(query, type)) {
    const conceptualResult = retrieveFromSpecializedStore(query, readPreferredText(conceptualPath, scope.conceptualFallback), 2);
    if (conceptualResult.text) parts.push({
      title: "Relevant conceptual models",
      layer: "conceptual_models",
      tier: "semi_stable",
      body: trimToChars(conceptualResult.text, options.conceptualMaxChars ?? 700),
    });
    higherOrderHits.conceptual_titles = conceptualResult.titles;

    const cognitiveResult = retrieveFromSpecializedStore(query, readPreferredText(cognitivePath, scope.cognitiveFallback), 2);
    if (cognitiveResult.text) parts.push({
      title: "Relevant cognitive patterns",
      layer: "cognitive_patterns",
      tier: "semi_stable",
      body: trimToChars(cognitiveResult.text, options.cognitiveMaxChars ?? 650),
    });
    higherOrderHits.cognitive_titles = cognitiveResult.titles;

    const emotionalResult = retrieveFromSpecializedStore(query, readPreferredText(emotionalPath, scope.emotionalFallback), 2);
    if (emotionalResult.text) parts.push({
      title: "Relevant emotional patterns",
      layer: "emotional_patterns",
      tier: "semi_stable",
      body: trimToChars(emotionalResult.text, options.emotionalMaxChars ?? 600),
    });
    higherOrderHits.emotional_titles = emotionalResult.titles;

    const transferResult = retrieveFromSpecializedStore(query, readPreferredText(transferPath, scope.transferFallback), 2);
    if (transferResult.text) parts.push({
      title: "Relevant transfer hypotheses",
      layer: "transfer_hypotheses",
      tier: "semi_stable",
      body: trimToChars(transferResult.text, options.transferMaxChars ?? 600),
    });
    higherOrderHits.transfer_titles = transferResult.titles;
  }

  if (activeMemoryEnabled) {
    if (active) parts.push({
      title: "Active frame",
      layer: "active_frame",
      tier: "volatile",
      body: active,
    });

    if (openLoops) parts.push({
      title: "Open loops",
      layer: "open_loops",
      tier: "volatile",
      body: openLoops,
    });
  }

  if (type === "episodic" || type === "personal") {
    const sessionResults = retrieveFromSessions(query, workspace, 14, { source: options.source || {} });
    if (sessionResults) parts.push({
      title: "Recent session context (L2)",
      layer: "sessions",
      tier: "volatile",
      body: trimToChars(sessionResults, options.sessionMaxChars ?? 800),
    });
  }

  if (
    options.memsearchEnabled &&
    typeof options.retrieveFromMemsearch === "function" &&
    typeof options.shouldUseMemsearch === "function" &&
    options.shouldUseMemsearch(query, type, parts)
  ) {
    const memsearchResults = options.retrieveFromMemsearch(query, type);
    if (memsearchResults) parts.push({
      title: "Semantic recall (memsearch)",
      layer: "memsearch",
      tier: "semi_stable",
      body: trimToChars(memsearchResults, options.memsearchMaxChars ?? 900),
    });
  }

  if (parts.length === 0) return null;
  const combined = collectBudgetedSections(parts, options.totalMaxChars ?? 2200);
  if (!combined?.text) return null;
  const stableAndSemi = combined.tierChars.stable + combined.tierChars.semi_stable;
  const volatile = combined.tierChars.volatile;
  const cacheFriendly = volatile <= Math.max(600, stableAndSemi);
  return {
    context: `<!-- brain-retrieval: ${type} -->\n${combined.text}`,
    layersUsed: combined.layersUsed,
    tierChars: combined.tierChars,
    tierHashes: combined.tierHashes,
    cacheFriendly,
    higherOrderHits,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function extractExchange(messages) {
  if (!Array.isArray(messages)) return null;
  let question = "", response = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg  = messages[i];
    if (!msg?.role) continue;
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === "text").map(b => b.text || "").join("\n")
        : "";
    const clean = sanitizeExchangeText(text);
    if (!clean) continue;
    if (!response && msg.role === "assistant") response = clean;
    if (!question && msg.role === "user")      question = clean;
    if (question && response) break;
  }
  return question || response ? { question, response } : null;
}

export function formatTranscript(messages) {
  const turns = [];
  for (const msg of (messages || [])) {
    if (!msg?.role) continue;
    const content = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === "text").map(b => b.text).join("\n")
        : "";
    const text = content
      .replace(/Sender \(untrusted metadata\):[\s\S]*?```\n[\s\S]*?```\n/g, "")
      .trim();
    if (!text || (msg.role === "assistant" && text.startsWith("{") && text.includes('"type"'))) continue;
    turns.push(`${msg.role === "user" ? "Human" : "Assistant"}: ${text}`);
  }
  return turns.join("\n\n");
}

function collectOpenLoops(messages) {
  const loops = [];
  const seen = new Set();
  const pattern = /\b(todo|follow up|follow-up|next step|need to|should|pending|blocker|open loop|later|defer|deferred)\b/i;
  const ignorePattern = /\b(updated successfully|no need to read it back|file state is current|already done|completed successfully|fixed successfully)\b/i;

  for (const msg of (messages || []).slice(-12)) {
    if (!msg?.role) continue;
    const content = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === "text").map(b => b.text || "").join("\n")
        : "";
    for (const rawLine of sanitizeExchangeText(content).split("\n")) {
      const line = rawLine.replace(/^[-*]\s*/, "").trim();
      if (line.length < 12 || line.length > 180) continue;
      if (/^conversation info|^sender\b/i.test(line)) continue;
      if (!pattern.test(line)) continue;
      if (ignorePattern.test(line)) continue;
      const normalized = line.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      loops.push(line);
      if (loops.length >= 6) return loops;
    }
  }

  return loops;
}

function isAcknowledgement(text) {
  const clean = summarizeHandoffText(text, 40).toLowerCase();
  return /^(yes|yep|yeah|ok|okay|sure|sounds good|continue|go ahead|do it|please|nice|great|cool)[.! ]*$/.test(clean);
}

function findMeaningfulLatestUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const text = sanitizeExchangeText(
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n")
          : ""
    );
    if (!text) continue;
    if (isAcknowledgement(text)) continue;
    return text;
  }
  return "";
}

const CONTINUATION_PREFIX = "This session is being continued from a previous conversation that ran out of context.";

function extractContinuationIntent(text) {
  const clean = sanitizeExchangeText(text);
  if (!clean || !clean.startsWith(CONTINUATION_PREFIX)) return "";
  const directMatch = clean.match(/Primary Request and Intent:\s*([\s\S]*?)(?:\n\s*\d+\.\s+[A-Z]|\n[A-Z][^\n]*:|$)/i);
  if (directMatch?.[1]) {
    return directMatch[1].replace(/\s+/g, " ").trim();
  }
  const summaryMatch = clean.match(/Summary:\s*([\s\S]*?)$/i);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].replace(/\s+/g, " ").trim();
  }
  return "";
}

function summarizeHandoffText(text, maxChars = 160) {
  const clean = sanitizeExchangeText(text);
  if (!clean) return "";
  const continuationIntent = extractContinuationIntent(clean);
  const source = continuationIntent || clean;
  return trimToChars(source.replace(/\s+/g, " ").trim(), maxChars);
}

function compactList(items, { maxItems = 3, maxChars = 120 } = {}) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const clean = summarizeHandoffText(item, maxChars);
    if (!clean) continue;
    const normalized = clean.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sameSummary(a, b) {
  const left = summarizeHandoffText(a, 200).toLowerCase();
  const right = summarizeHandoffText(b, 200).toLowerCase();
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function overlapRatioText(a, b) {
  const left = new Set(
    summarizeHandoffText(a, 220)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
  const right = new Set(
    summarizeHandoffText(b, 220)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
  if (left.size === 0) return 0;
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) hits += 1;
  }
  return hits / left.size;
}

function isUsefulHandoffItem(item, context = []) {
  const clean = summarizeHandoffText(item, 140);
  if (!clean) return false;
  if (clean.length < 18) return false;
  if (/^[`*_#>\-\s.]+$/.test(clean)) return false;
  if (/^[a-z0-9_-]+`?\s+or\s+/i.test(clean)) return false;
  if (/config`?\s+or\s+/i.test(clean)) return false;
  if (/^wait,\s+i noticed/i.test(clean)) return false;
  for (const baseline of context) {
    if (!baseline) continue;
    if (sameSummary(clean, baseline)) return false;
    if (overlapRatioText(clean, baseline) >= 0.75) return false;
  }
  return true;
}

function deriveActiveFrame(messages) {
  const exchange = extractExchange(messages);
  if (!exchange) return null;

  const userText = exchange.question && !isAcknowledgement(exchange.question)
    ? exchange.question
    : findMeaningfulLatestUserText(messages) || exchange.question || "";
  const assistantText = exchange.response || "";
  const objective = summarizeHandoffText(userText, 150);

  let nextStep = "";
  for (const paragraph of assistantText.split(/\n\n+/)) {
    const clean = paragraph.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    if (/\b(next|first|start|then|should|recommend|implement|update|check)\b/i.test(clean)) {
      nextStep = summarizeHandoffText(clean, 150);
      break;
    }
  }
  if (!nextStep && assistantText) {
    nextStep = summarizeHandoffText(assistantText, 150);
  }

  const constraints = [];
  const constraintSeen = new Set();
  for (const source of [userText, assistantText]) {
    for (const sentence of source.split(/[.\n]/)) {
      const clean = sentence.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      if (/\b(must|should not|don't|do not|without|only|need to|priority|constraint|avoid)\b/i.test(clean)) {
        const compact = summarizeHandoffText(clean, 120);
        if (!compact) continue;
        const normalized = compact.toLowerCase();
        if (constraintSeen.has(normalized)) continue;
        constraintSeen.add(normalized);
        constraints.push(compact);
      }
      if (constraints.length >= 3) break;
    }
    if (constraints.length >= 3) break;
  }

  return {
    objective,
    nextStep,
    constraints,
  };
}

function collectLikelyDecisions(messages, maxItems = 4) {
  const exchange = extractExchange(messages);
  if (!exchange?.response) return [];
  const decisions = [];
  const seen = new Set();
  for (const sentence of exchange.response.split(/[.\n]/)) {
    const clean = sentence.replace(/\s+/g, " ").trim();
    if (clean.length < 18 || clean.length > 220) continue;
    if (!/\b(decide|decision|approve|reject|should|will|must|do not|don't|keep|move|host|create|add|remove|use)\b/i.test(clean)) continue;
    const compact = summarizeHandoffText(clean, 120);
    if (!compact) continue;
    const normalized = compact.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    decisions.push(compact);
    if (decisions.length >= Math.min(maxItems, 3)) break;
  }
  return decisions;
}

function buildStateTransfer(sessionId, messages) {
  const frame = deriveActiveFrame(messages);
  const loops = collectOpenLoops(messages);
  const exchange = extractExchange(messages);
  const decisions = collectLikelyDecisions(messages);
  if (!frame && loops.length === 0 && decisions.length === 0 && !exchange) return null;

  const state = {
    session_id: sessionId,
    updated_at: new Date().toISOString(),
    objective: frame?.objective || "",
    constraints: compactList(
      (frame?.constraints || []).filter((item) => isUsefulHandoffItem(item, [frame?.objective, frame?.nextStep])),
      { maxItems: 3, maxChars: 120 }
    ),
    next_step: frame?.nextStep || "",
    open_loops: compactList(loops, { maxItems: 3, maxChars: 120 }),
    decisions: compactList(
      decisions.filter((item) => isUsefulHandoffItem(item, [frame?.objective, frame?.nextStep])),
      { maxItems: 3, maxChars: 120 }
    ),
    last_user_request: exchange?.question ? summarizeHandoffText(exchange.question, 140) : "",
    last_assistant_summary: exchange?.response ? summarizeHandoffText(exchange.response, 160) : "",
  };

  return state;
}

function materializeStateTransfer(path, state) {
  const displayConstraints = (state.constraints || []).filter((item) => isUsefulHandoffItem(item, [state.objective, state.next_step]));
  const displayOpenLoops = (state.open_loops || []).filter((item) => isUsefulHandoffItem(item, [state.objective, state.next_step]));
  const displayDecisions = (state.decisions || []).filter((item) => isUsefulHandoffItem(item, [state.objective, state.next_step]));
  const showLastUser = state.last_user_request
    && !sameSummary(state.last_user_request, state.objective)
    && overlapRatioText(state.last_user_request, state.objective) < 0.75;
  const showAssistantSummary = state.last_assistant_summary
    && !sameSummary(state.last_assistant_summary, state.next_step)
    && overlapRatioText(state.last_assistant_summary, state.next_step) < 0.75;
  const lines = [
    "# HANDOFF",
    `- updated_at: ${state.updated_at}`,
    `- session_id: ${state.session_id}`,
    "",
    "## Focus",
    state.objective || "(not captured)",
    "",
    "## Next step",
    state.next_step || "(not captured)",
    "",
    "## Constraints",
    ...(displayConstraints.length ? displayConstraints.map(item => `- ${item}`) : ["- none captured"]),
    "",
    "## Open loops",
    ...(displayOpenLoops.length ? displayOpenLoops.map(item => `- ${item}`) : ["- none captured"]),
    "",
    "## Decisions in force",
    ...(displayDecisions.length ? displayDecisions.map(item => `- ${item}`) : ["- none captured"]),
  ];
  if (showLastUser || showAssistantSummary) {
    lines.push("", "## Latest exchange");
    if (showLastUser) lines.push(`- user: ${state.last_user_request}`);
    if (showAssistantSummary) lines.push(`- assistant: ${state.last_assistant_summary}`);
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"), "utf8");
}

function summarizeLine(text, maxChars = 160) {
  return trimToChars((text || "").replace(/\s+/g, " ").trim(), maxChars);
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getMessageText(msg) {
  return summarizeLine(
    sanitizeExchangeText(
      msg?.message?.content ? contentToText(msg.message.content) : contentToText(msg?.content)
    ),
    600
  );
}

function collectToolObservations(messages) {
  const observations = [];

  for (const msg of messages) {
    const role = msg?.message?.role || msg?.role;
    if (role !== "toolResult") continue;
    const toolName = msg?.message?.toolName || msg?.toolName || "tool";
    if (["read", "sessions_spawn", "subagents", "exec"].includes(toolName)) continue;
    const text = getMessageText(msg);
    if (!text) continue;

    let observation = text.replace(/^Source:.*?---\s*/i, "").trim();
    if (toolName === "web_search" || observation.startsWith("{")) {
      try {
        const parsed = JSON.parse(observation);
        observation = parsed.content || parsed.result || parsed.summary || observation;
      } catch {}
    }
    observation = sanitizeExchangeText(observation)
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .trim();

    if (
      !observation ||
      observation.length < 40 ||
      /^(\{|\[)/.test(observation) ||
      /\bcurl:\s*\(\d+\)|connection error|fetch failed|timed out|unreachable|api error|could not connect|unable to connect\b/i.test(observation)
    ) continue;

    observations.push({
      tool: toolName,
      summary: summarizeLine(observation, 220),
    });
  }

  return observations.slice(0, 4);
}

function inferReasoningCandidates({ sessionId, queryType, frame, exchange, loops, toolObservations }) {
  const out = [];
  const questionSummary = summarizeLine(exchange.question, 180);
  const responseSummary = summarizeLine(exchange.response, 220);
  const response = exchange.response || "";
  const lowered = response.toLowerCase();

  if (
    /\b(first|start by|before|then|finally|prioritize|narrow|restate)\b/.test(lowered) &&
    /\b(next|step|scope|constraint|objective|plan)\b/.test(lowered)
  ) {
    out.push({
      id: `${Date.now()}-reasoning-pattern`,
      type: "reasoning_pattern",
      title: safeSlug(questionSummary || frame?.objective || "reasoning-pattern", "reasoning-pattern"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        objective: frame?.objective || "",
        query_type: queryType,
      },
      confidence: 0.54,
      reuse_likelihood: 0.72,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "reasoning_reuse",
    });
  }

  if (
    /\b(pattern|recurring|tends to|usually|often|consistently|signal)\b/.test(lowered) &&
    responseSummary
  ) {
    out.push({
      id: `${Date.now()}-discovered-pattern`,
      type: "discovered_pattern",
      title: safeSlug(responseSummary, "discovered-pattern"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        open_loops: loops.slice(0, 3),
      },
      confidence: 0.5,
      reuse_likelihood: 0.68,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "pattern_discovery",
    });
  }

  if (
    /\b(not just|not only|the difference between|distinction|means that|is not the same as|rather than)\b/.test(lowered) &&
    responseSummary
  ) {
    out.push({
      id: `${Date.now()}-conceptual-model`,
      type: "conceptual_model",
      title: safeSlug(responseSummary, "conceptual-model"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        objective: frame?.objective || "",
        query_type: queryType,
      },
      confidence: 0.52,
      reuse_likelihood: 0.74,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "conceptual_reuse",
    });
  }

  if (
    /\b(thinks in|tends to|under pressure|under load|approaches problems|maps|broadens scope|over-abstract|narrows|restate)\b/.test(lowered) &&
    /\b(think|approach|pattern|scope|abstract|systems|details|reasoning)\b/.test(lowered) &&
    responseSummary
  ) {
    out.push({
      id: `${Date.now()}-cognitive-pattern`,
      type: "cognitive_pattern",
      title: safeSlug(responseSummary, "cognitive-pattern"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        open_loops: loops.slice(0, 3),
      },
      confidence: 0.5,
      reuse_likelihood: 0.7,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "cognitive_regulation",
    });
  }

  if (
    /\b(friction|dread|grief|relief|care deeply|excite|afraid|fear|shame|tension|moral injury|contract|overwhelm)\b/.test(lowered) &&
    responseSummary
  ) {
    out.push({
      id: `${Date.now()}-emotional-pattern`,
      type: "emotional_pattern",
      title: safeSlug(responseSummary, "emotional-pattern"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        objective: frame?.objective || "",
      },
      confidence: 0.47,
      reuse_likelihood: 0.64,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "regulation_support",
    });
  }

  if (
    /\b(across domains|in another domain|also applies|same pattern|structurally similar|maps to|transfer)\b/.test(lowered) &&
    responseSummary
  ) {
    out.push({
      id: `${Date.now()}-transfer-hypothesis`,
      type: "transfer_hypothesis",
      title: safeSlug(responseSummary, "transfer-hypothesis"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        query_type: queryType,
      },
      confidence: 0.46,
      reuse_likelihood: 0.69,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "cross_domain_transfer",
    });
  }

  if (
    /\b(worked|helped|resolved|better|faster|avoid|failed|didn.t work|did not work|blocked)\b/.test(lowered) &&
    responseSummary
  ) {
    out.push({
      id: `${Date.now()}-outcome-lesson`,
      type: "outcome_lesson",
      title: safeSlug(responseSummary, "outcome-lesson"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        objective: frame?.objective || "",
      },
      confidence: 0.48,
      reuse_likelihood: 0.66,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "outcome_learning",
    });
  }

  for (const observation of toolObservations) {
    if (!observation.summary) continue;
    out.push({
      id: `${Date.now()}-${safeSlug(observation.tool, "investigation")}`,
      type: "semantic",
      title: safeSlug(`${observation.tool}-${questionSummary}`, "investigation-finding"),
      content: observation.summary,
      source_session: sessionId,
      evidence: {
        tool: observation.tool,
        question: questionSummary,
      },
      confidence: 0.46,
      reuse_likelihood: 0.58,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "investigation_recall",
    });
  }

  return out.slice(0, 10);
}

function detectDriftSignals(question, response, loops, frame) {
  const signals = [];
  const q = (question || "").toLowerCase();
  const r = (response || "").toLowerCase();

  if (loops.length >= 3) {
    signals.push({
      key: "unfinished_loop_overload",
      description: "Too many open loops are active at once, which increases restart friction and coherence loss.",
      intervention: "Restate priority order and collapse work into one primary next action.",
    });
  }

  if (/\bmaybe|could|also|another|instead|option|alternatively\b/.test(r) && /\bplan|build|implement|next\b/.test(r)) {
    signals.push({
      key: "scope_drift",
      description: "The work is branching into multiple paths instead of staying tightly scoped.",
      intervention: "Narrow to one bounded next action and defer non-critical branches.",
    });
  }

  if ((question || "").length > 220 && frame?.constraints?.length === 0) {
    signals.push({
      key: "context_drift",
      description: "The active task is detailed but the current frame is underspecified, increasing the chance of solving the wrong problem.",
      intervention: "Restate the active frame and explicit constraints before continuing.",
    });
  }

  if (/\bshould|need to|must\b/.test(q) && /\bmaybe|could|perhaps|option\b/.test(r)) {
    signals.push({
      key: "decision_avoidance",
      description: "The response shifts from a required decision toward open-ended possibilities.",
      intervention: "Choose a default path and state why it is the current recommendation.",
    });
  }

  if (/\barchitecture|design|strategy|framework\b/.test(q) && /\bphilosophy|vision|theory\b/.test(r)) {
    signals.push({
      key: "overcomplication",
      description: "The response is drifting upward in abstraction instead of staying operational.",
      intervention: "Drop one abstraction layer and return to implementation-level action.",
    });
  }

  return signals.slice(0, 3);
}

export function buildCandidatePayload(sessionId, messages) {
  const exchange = extractExchange(messages);
  if (!exchange) return null;

  const frame = deriveActiveFrame(messages);
  const loops = collectOpenLoops(messages);
  const queryType = classifyQuery(exchange.question || "");
  const responseSummary = summarizeLine(exchange.response, 220);
  const questionSummary = summarizeLine(exchange.question, 180);
  const driftSignals = detectDriftSignals(exchange.question, exchange.response, loops, frame);
  const toolObservations = collectToolObservations(messages);
  const extractedConstraints = extractConstraints(messages);
  const extractedProcedures = extractProcedures(messages);
  const candidates = [];

  if (frame?.objective) {
    candidates.push({
      id: `${Date.now()}-active-frame`,
      type: "decision",
      title: safeSlug(frame.objective, "active-frame"),
      content: frame.objective,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        next_step: frame.nextStep || "",
      },
      confidence: 0.7,
      reuse_likelihood: 0.8,
      promotion_state: "short_term",
      cost_to_create: 0,
      estimated_value: "same_day_continuity",
    });
  }

  if (frame?.nextStep) {
    candidates.push({
      id: `${Date.now()}-next-step`,
      type: "procedure",
      title: safeSlug(frame.nextStep, "next-step"),
      content: frame.nextStep,
      source_session: sessionId,
      evidence: {
        objective: frame?.objective || "",
        query_type: queryType,
      },
      confidence: 0.62,
      reuse_likelihood: 0.65,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "resume_support",
    });
  }

  for (const loop of loops.slice(0, 4)) {
    candidates.push({
      id: `${Date.now()}-${safeSlug(loop, "open-loop")}`,
      type: "decision",
      title: safeSlug(loop, "open-loop"),
      content: loop,
      source_session: sessionId,
      evidence: {
        objective: frame?.objective || "",
        query_type: queryType,
      },
      confidence: 0.55,
      reuse_likelihood: 0.7,
      promotion_state: "short_term",
      cost_to_create: 0,
      estimated_value: "open_loop_recall",
    });
  }

  if (queryType === "procedural" && responseSummary) {
    candidates.push({
      id: `${Date.now()}-procedural`,
      type: "procedure",
      title: safeSlug(questionSummary, "procedure"),
      content: responseSummary,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
      },
      confidence: 0.58,
      reuse_likelihood: 0.6,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "workflow_reuse",
    });
  }

  for (const candidate of inferReasoningCandidates({
    sessionId,
    queryType,
    frame,
    exchange,
    loops,
    toolObservations,
  })) {
    candidates.push(candidate);
  }

  for (const constraint of extractedConstraints.slice(0, 4)) {
    candidates.push({
      id: `${Date.now()}-${constraint.constraint_key}`,
      type: "constraint",
      title: constraint.constraint_key,
      content: constraint.statement,
      source_session: sessionId,
      evidence: {
        scope: constraint.scope,
        applies_to: constraint.applies_to || [],
      },
      confidence: constraint.strength ?? 0.84,
      reuse_likelihood: 0.82,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "policy_preservation",
    });
  }

  for (const procedure of extractedProcedures.slice(0, 3)) {
    candidates.push({
      id: `${Date.now()}-${procedure.procedure_key}`,
      type: "proven_procedure",
      title: procedure.procedure_key,
      content: [procedure.goal, ...(procedure.steps || [])].join("\n"),
      source_session: sessionId,
      evidence: {
        scope: procedure.scope,
        preconditions: procedure.preconditions || [],
      },
      confidence: procedure.reuse_score ?? 0.64,
      reuse_likelihood: 0.86,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "procedure_reuse",
    });
  }

  for (const signal of driftSignals) {
    candidates.push({
      id: `${Date.now()}-${signal.key}`,
      type: "drift_signal",
      title: signal.key,
      content: signal.description,
      source_session: sessionId,
      evidence: {
        question: questionSummary,
        objective: frame?.objective || "",
        open_loops: loops.slice(0, 3),
      },
      confidence: 0.52,
      reuse_likelihood: 0.68,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "drift_detection",
    });

    candidates.push({
      id: `${Date.now()}-${signal.key}-compensation`,
      type: "compensation",
      title: `${signal.key}-compensation`,
      content: signal.intervention,
      source_session: sessionId,
      evidence: {
        target_signal: signal.key,
        objective: frame?.objective || "",
      },
      confidence: 0.5,
      reuse_likelihood: 0.7,
      promotion_state: "candidate",
      cost_to_create: 0,
      estimated_value: "coherence_support",
    });
  }

  if (candidates.length === 0) return null;

  return {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    query_type: queryType,
    tool_observations: toolObservations,
    candidates,
  };
}

function hostSlug(host = "shared") {
  return safeSlug(String(host || "shared"), "shared");
}

function normalizeMemoryScope(source = {}) {
  const runtime = hostSlug(source.platform || source.runtime || source.host || "openbrain");
  const agent = hostSlug(source.agent || source.name || source.agentId || "main");
  return { runtime, agent };
}

function memoryPaths(workspace, source = {}) {
  const { runtime, agent } = normalizeMemoryScope(source);
  const legacyRoot = join(workspace, "memory");
  const privateRoot = join(workspace, "memory/private", runtime, agent);
  const sharedRoot = join(workspace, "memory/shared");

  return {
    runtime,
    platform: runtime,
    agent,
    name: agent,
    legacyRoot,
    privateRoot,
    sharedRoot,
    memoryRoot: privateRoot,
    hostRoot: privateRoot,
    active: join(privateRoot, "ACTIVE.md"),
    activeFallback: join(legacyRoot, "ACTIVE.md"),
    handoff: join(privateRoot, "HANDOFF.md"),
    handoffFallback: join(legacyRoot, "HANDOFF.md"),
    stateTransfer: join(privateRoot, "state-transfer.json"),
    stateTransferFallback: join(legacyRoot, "state-transfer.json"),
    openLoops: join(privateRoot, "open-loops.md"),
    openLoopsFallback: join(legacyRoot, "open-loops.md"),
    driftPatterns: join(privateRoot, "drift-patterns.md"),
    driftPatternsFallback: join(legacyRoot, "drift-patterns.md"),
    compensationStrategies: join(privateRoot, "compensation-strategies.md"),
    compensationFallback: join(legacyRoot, "compensation-strategies.md"),
    candidatesDir: join(privateRoot, "candidates"),
    sharedDriftPatterns: join(sharedRoot, "drift-patterns.md"),
    sharedCompensationStrategies: join(sharedRoot, "compensation-strategies.md"),
    sharedStableFacts: join(sharedRoot, "stable-facts.jsonl"),
    sharedStableContext: join(sharedRoot, "STABLE_CONTEXT.md"),
    sharedConstraintsJsonl: join(sharedRoot, "constraints.jsonl"),
    sharedConstraintsMd: join(sharedRoot, "CONSTRAINTS.md"),
    sharedProceduresJsonl: join(sharedRoot, "procedures.jsonl"),
    sharedProceduresMd: join(sharedRoot, "PROCEDURES.md"),
    stableFacts: join(privateRoot, "stable-facts.jsonl"),
    stableFactsFallback: join(legacyRoot, "stable-facts.jsonl"),
    stableContext: join(privateRoot, "STABLE_CONTEXT.md"),
    stableContextFallback: join(legacyRoot, "STABLE_CONTEXT.md"),
    constraintsJsonl: join(privateRoot, "constraints.jsonl"),
    constraintsJsonlFallback: join(legacyRoot, "constraints.jsonl"),
    constraintsMd: join(privateRoot, "CONSTRAINTS.md"),
    constraintsMdFallback: join(legacyRoot, "CONSTRAINTS.md"),
    proceduresJsonl: join(privateRoot, "procedures.jsonl"),
    proceduresJsonlFallback: join(legacyRoot, "procedures.jsonl"),
    proceduresMd: join(privateRoot, "PROCEDURES.md"),
    proceduresMdFallback: join(legacyRoot, "PROCEDURES.md"),
    hotCache: join(privateRoot, "HOT_CACHE.md"),
    hotCacheFallback: join(legacyRoot, "HOT_CACHE.md"),
    sharedHotCache: join(sharedRoot, "HOT_CACHE.md"),
    mind: join(privateRoot, "MIND.md"),
    mindFallback: join(legacyRoot, "MIND.md"),
    sharedMind: join(sharedRoot, "MIND.md"),
    conceptual: join(privateRoot, "conceptual-models.md"),
    conceptualFallback: join(legacyRoot, "conceptual-models.md"),
    sharedConceptual: join(sharedRoot, "conceptual-models.md"),
    cognitive: join(privateRoot, "cognitive-patterns.md"),
    cognitiveFallback: join(legacyRoot, "cognitive-patterns.md"),
    sharedCognitive: join(sharedRoot, "cognitive-patterns.md"),
    emotional: join(privateRoot, "emotional-patterns.md"),
    emotionalFallback: join(legacyRoot, "emotional-patterns.md"),
    sharedEmotional: join(sharedRoot, "emotional-patterns.md"),
    transfer: join(privateRoot, "transfer-hypotheses.md"),
    transferFallback: join(legacyRoot, "transfer-hypotheses.md"),
    sharedTransfer: join(sharedRoot, "transfer-hypotheses.md"),
    sessionsDir: join(privateRoot, "sessions"),
    sessionsFallbackDir: join(legacyRoot, "sessions"),
  };
}

export function hostMemoryPaths(workspace, source = {}) {
  return memoryPaths(workspace, source);
}

export function ensureWorkspaceScaffolding(workspace, source = {}) {
  const paths = hostMemoryPaths(workspace, source);
  mkdirSync(paths.legacyRoot, { recursive: true });
  mkdirSync(paths.sharedRoot, { recursive: true });
  mkdirSync(paths.hostRoot, { recursive: true });
  mkdirSync(paths.candidatesDir, { recursive: true });
  return paths;
}

function withSourceMetadata(items = [], source = {}) {
  return items.map((item) => ({
    ...item,
    source_platform: source.platform || source.host || "unknown",
    source_agent: source.agent || source.name || "",
    source_session: source.sessionId || item.source_session || "",
  }));
}

export function writeContinuitySnapshot(workspace, sessionId, messages, source = {}) {
  const paths = ensureWorkspaceScaffolding(workspace, source);
  const frame = deriveActiveFrame(messages);
  const loops = collectOpenLoops(messages);
  const ts = new Date().toISOString();

  if (frame) {
    const activeLines = [
      "# ACTIVE",
      `- updated_at: ${ts}`,
      `- session_id: ${sessionId}`,
      `- source_platform: ${paths.platform}`,
      `- source_agent: ${paths.agent}`,
      "",
      "## Current objective",
      frame.objective || "(not captured)",
      "",
      "## Constraints",
      ...(frame.constraints.length ? frame.constraints.map((item) => `- ${item}`) : ["- none captured"]),
      "",
      "## Likely next step",
      frame.nextStep || "(not captured)",
      "",
    ];
    writeFileSync(paths.active, activeLines.join("\n"), "utf8");
  }

  const stateTransfer = buildStateTransfer(sessionId, messages);
  if (stateTransfer) {
    const enrichedStateTransfer = {
      ...stateTransfer,
      source_platform: paths.platform,
      source_agent: source.agent || source.name || paths.agent,
    };
    writeFileSync(paths.stateTransfer, `${JSON.stringify(enrichedStateTransfer, null, 2)}\n`, "utf8");
    materializeStateTransfer(paths.handoff, enrichedStateTransfer);
  }

  if (loops.length > 0) {
    const openLoopLines = [
      "# OPEN LOOPS",
      `- updated_at: ${ts}`,
      `- session_id: ${sessionId}`,
      `- source_platform: ${paths.platform}`,
      `- source_agent: ${paths.agent}`,
      "",
      ...loops.map((loop) => `- ${loop}`),
      "",
    ];
    writeFileSync(paths.openLoops, openLoopLines.join("\n"), "utf8");
  }

  const exchange = extractExchange(messages);
  if (exchange) {
    const driftSignals = detectDriftSignals(exchange.question, exchange.response, loops, frame);
    if (driftSignals.length > 0) {
      const driftLines = [
        "# DRIFT PATTERNS",
        `- updated_at: ${ts}`,
        `- session_id: ${sessionId}`,
        `- source_platform: ${paths.platform}`,
        `- source_agent: ${paths.agent}`,
        "",
        ...driftSignals.map((signal) => `## ${signal.key}\n- description: ${signal.description}\n- suggested_intervention: ${signal.intervention}\n`),
      ];
      writeFileSync(paths.driftPatterns, driftLines.join("\n"), "utf8");

      const compensationLines = [
        "# COMPENSATION STRATEGIES",
        `- updated_at: ${ts}`,
        `- session_id: ${sessionId}`,
        `- source_platform: ${paths.platform}`,
        `- source_agent: ${paths.agent}`,
        "",
        ...driftSignals.map((signal) => `## ${signal.key}\n- intervention: ${signal.intervention}\n- target_signal: ${signal.key}\n`),
      ];
      writeFileSync(paths.compensationStrategies, compensationLines.join("\n"), "utf8");
    }
  }

  const stableFacts = withSourceMetadata(extractStableFacts(messages), {
    ...source,
    platform: paths.platform,
    sessionId,
  });
  upsertStableFacts(paths.stableFacts, paths.stableContext, stableFacts);

  const constraints = withSourceMetadata(extractConstraints(messages), {
    ...source,
    platform: paths.platform,
    sessionId,
  });
  upsertConstraints(paths.constraintsJsonl, paths.constraintsMd, constraints);

  const procedures = withSourceMetadata(extractProcedures(messages), {
    ...source,
    platform: paths.platform,
    sessionId,
  });
  upsertProcedures(paths.proceduresJsonl, paths.proceduresMd, procedures);

  return {
    paths,
    frame,
    loops,
    exchange,
  };
}

export function stageCandidatePayload(workspace, payload, source = {}) {
  if (!payload) return null;
  const paths = ensureWorkspaceScaffolding(workspace, source);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(paths.candidatesDir, `${ts}-${safeSlug(payload.session_id || source.sessionId || "session", "session")}.json`);
  const enriched = {
    ...payload,
    share_policy: payload.share_policy || "private",
    visibility: payload.visibility || "local",
    source: {
      platform: paths.platform,
      agent: source.agent || source.name || paths.agent,
      session_id: source.sessionId || payload.session_id || "",
    },
    candidates: withSourceMetadata(payload.candidates || [], {
      ...source,
      platform: paths.platform,
      sessionId: source.sessionId || payload.session_id || "",
    }),
  };
  writeFileSync(file, JSON.stringify(enriched, null, 2), "utf8");
  return { file, payload: enriched };
}

export function ingestMessages(workspace, sessionId, messages, source = {}) {
  const continuity = writeContinuitySnapshot(workspace, sessionId, messages, source);
  const payload = buildCandidatePayload(sessionId, messages);
  const staged = stageCandidatePayload(workspace, payload, {
    ...source,
    sessionId,
  });
  return {
    continuity,
    candidateFile: staged?.file || null,
    candidateCount: staged?.payload?.candidates?.length || 0,
  };
}

export function recallForSource(workspace, query, source = {}, options = {}) {
  const type = classifyQuery(query || "");
  const paths = hostMemoryPaths(workspace, source);
  const retrieval = buildRetrievalContext(type, query, workspace, {
    ...options,
    hotCachePath: [paths.hotCache, paths.sharedHotCache, paths.hotCacheFallback],
    stablePath: [paths.stableContext, paths.sharedStableContext, paths.stableContextFallback],
    stableFactsPath: [paths.stableFacts, paths.sharedStableFacts, paths.stableFactsFallback],
    constraintsPath: [paths.constraintsJsonl, paths.sharedConstraintsJsonl, paths.constraintsJsonlFallback],
    proceduresPath: [paths.proceduresJsonl, paths.sharedProceduresJsonl, paths.proceduresJsonlFallback],
    activePath: [paths.active, paths.activeFallback],
    openLoopsPath: [paths.openLoops, paths.openLoopsFallback],
    handoffPath: [paths.handoff, paths.handoffFallback],
    driftPath: [paths.driftPatterns, paths.sharedDriftPatterns, paths.driftPatternsFallback],
    compensationPath: [paths.compensationStrategies, paths.sharedCompensationStrategies, paths.compensationFallback],
    conceptualPath: [paths.conceptual, paths.sharedConceptual, paths.conceptualFallback],
    cognitivePath: [paths.cognitive, paths.sharedCognitive, paths.cognitiveFallback],
    emotionalPath: [paths.emotional, paths.sharedEmotional, paths.emotionalFallback],
    transferPath: [paths.transfer, paths.sharedTransfer, paths.transferFallback],
    mindPath: [paths.mind, paths.sharedMind, paths.mindFallback],
  });

  return {
    type,
    source_platform: paths.runtime,
    source_agent: paths.agent,
    ...(retrieval || {
      context: "",
      layersUsed: [],
      tierChars: { stable: 0, semi_stable: 0, volatile: 0 },
      tierHashes: null,
      cacheFriendly: false,
      higherOrderHits: {
        conceptual_titles: [],
        cognitive_titles: [],
        emotional_titles: [],
        transfer_titles: [],
      },
    }),
  };
}

// ── Plugin entry point ────────────────────────────────────────────────────────
export default function openBrainPlugin(api) {
  const config = api.pluginConfig || {};

  // Build personal terms regex from config (add your own project names, people, etc.)
  const personalTerms = Array.isArray(config.personalTerms) && config.personalTerms.length > 0
    ? config.personalTerms
    : null;
  if (personalTerms) {
    const escaped = personalTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    PERSONAL_RE = new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
  }

  const WORKSPACE               = config.workspace || join(process.env.HOME || homedir(), ".openclaw/workspace");
  const COST_WEBHOOK            = config.costWebhook || null;
  const CURATOR_MODEL           = config.curator?.model    || "claude-sonnet-4-6";
  const CURATOR_PROVIDER        = config.curator?.provider || "anthropic";
  const EVAL_MODEL              = config.eval?.model    || "claude-haiku-4-5-20251001";
  const EVAL_PROVIDER           = config.eval?.provider || "anthropic";
  const COHERENCE_MODEL         = config.coherenceCheck?.model    || EVAL_MODEL;
  const COHERENCE_PROVIDER      = config.coherenceCheck?.provider || EVAL_PROVIDER;
  const DEBOUNCE_MS             = (config.curationDebounceMinutes ?? 10) * 60 * 1000;
  const HOT_CACHE_SIZE          = String(config.hotCacheSize ?? 25);
  const ACTIVE_MEMORY_ENABLED   = config.activeMemory?.enabled !== false;
  const ACTIVE_MEMORY_MAX_CHARS = config.activeMemory?.maxChars ?? 900;
  const STABLE_CONTEXT_ENABLED  = config.stableContext?.enabled !== false;
  const STABLE_CONTEXT_MAX_CHARS = config.stableContext?.maxChars ?? 700;
  const CONSTRAINT_MAX_CHARS    = config.constraints?.maxChars ?? 700;
  const PROCEDURE_MAX_CHARS     = config.procedures?.maxChars ?? 800;
  const OPEN_LOOPS_MAX_CHARS    = config.openLoops?.maxChars ?? 700;
  const RETRIEVAL_TOTAL_MAX     = config.retrieval?.totalMaxChars ?? 1800;
  const CURATE_SUBAGENTS        = config.curateSubagents === true;
  const COHERENCE_ENABLED       = config.coherenceCheck?.enabled !== false;
  const COHERENCE_MIN_CHARS     = config.coherenceCheck?.minChars ?? 280;
  const MEMSEARCH_ENABLED       = config.memsearch?.enabled !== false;
  const MEMSEARCH_MAX_CHARS     = config.memsearch?.maxChars ?? 900;
  const AUTOSCALE_ENABLED       = config.autoscale?.enabled !== false;
  const AUTOSCALE_CLARIFY_TURNS = config.autoscale?.clarificationTurns ?? 2;
  const AUTOSCALE_CORRECT_TURNS = config.autoscale?.correctionTurns ?? 1;
  const TELEMETRY_ENABLED       = config.telemetry?.enabled !== false;
  const TELEMETRY_WEBHOOK       = config.telemetry?.webhook || null;
  const TELEMETRY_WRITE_JSONL   = config.telemetry?.writeJsonl !== false;
  const MEMORY = memoryPaths(WORKSPACE, { platform: "openbrain", agent: "main" });

  const WORKINGS_MD  = join(WORKSPACE, "memory/WORKINGS.md");
  const ACTIVE_MD    = MEMORY.active;
  const HANDOFF_MD   = MEMORY.handoff;
  const STATE_TRANSFER_JSON = MEMORY.stateTransfer;
  const STABLE_CONTEXT_MD = MEMORY.stableContext;
  const STABLE_FACTS_JSONL = MEMORY.stableFacts;
  const CONSTRAINTS_JSONL = MEMORY.constraintsJsonl;
  const CONSTRAINTS_MD = MEMORY.constraintsMd;
  const PROCEDURES_JSONL = MEMORY.proceduresJsonl;
  const PROCEDURES_MD = MEMORY.proceduresMd;
  const CONTRADICTIONS_JSONL = join(MEMORY.sharedRoot, "contradictions.jsonl");
  const COMMITMENTS_JSONL = join(MEMORY.sharedRoot, "commitments.jsonl");
  const ARTIFACTS_JSONL = join(MEMORY.sharedRoot, "artifacts.jsonl");
  const CONFLICT_ARTIFACTS_JSONL = join(MEMORY.sharedRoot, "conflicting-artifacts.jsonl");
  const OPEN_LOOPS_MD = MEMORY.openLoops;
  const DRIFT_PATTERNS_MD = MEMORY.driftPatterns;
  const COMPENSATION_STRATEGIES_MD = MEMORY.compensationStrategies;
  const CURATOR_SCRIPT = join(PLUGIN_DIR, "scripts/curator.js");
  const COHERENCE_SCRIPT = join(PLUGIN_DIR, "scripts/coherence-check.js");
  const SEARCH_WRAPPER_SCRIPT = join(PLUGIN_DIR, "scripts/search-wrapper.js");
  const CANDIDATES_DIR = MEMORY.candidatesDir;
  const TELEMETRY_DIR  = join(WORKSPACE, "memory/telemetry");
  const TODAY          = () => new Date().toISOString().slice(0, 10);
  const MIN_CHARS      = 200;
  const MEMSEARCH_BIN  = join(process.env.HOME || homedir(), ".memsearch-venv/bin/memsearch");

  // Read API keys from environment or openclaw.json
  function getApiKey(provider) {
    if (provider === "deepseek") {
      if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
      try {
        const cfg = JSON.parse(readFileSync(
          join(process.env.HOME || homedir(), ".openclaw/openclaw.json"), "utf8"
        ));
        return cfg?.models?.providers?.deepseek?.apiKey || null;
      } catch { return null; }
    }
    // anthropic
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    try {
      const profiles = JSON.parse(readFileSync(
        join(process.env.HOME || homedir(), ".openclaw/agents/main/agent/auth-profiles.json"), "utf8"
      ));
      return profiles?.profiles?.["anthropic:default"]?.key || null;
    } catch { return null; }
  }

  const ANTHROPIC_KEY = getApiKey("anthropic");
  const DEEPSEEK_KEY  = getApiKey("deepseek");

  // Write config.json for eval.js to read
  try {
    writeFileSync(join(PLUGIN_DIR, "config.json"), JSON.stringify({
      eval_model:    EVAL_MODEL,
      eval_provider: EVAL_PROVIDER,
      coherence_model: COHERENCE_MODEL,
      coherence_provider: COHERENCE_PROVIDER,
      // curator fields (for manual runs of curator.js)
      curator_model:    CURATOR_MODEL,
      curator_provider: CURATOR_PROVIDER,
    }, null, 2));
  } catch {}

  // Env vars passed to all child processes
  const childEnv = () => ({
    ...process.env,
    OPENBRAIN_WORKSPACE:        WORKSPACE,
    OPENBRAIN_PLUGIN_DIR:       PLUGIN_DIR,
    OPENBRAIN_HOT_CACHE_SIZE:   HOT_CACHE_SIZE,
    OPENBRAIN_CURATOR_MODEL:    CURATOR_MODEL,
    OPENBRAIN_CURATOR_PROVIDER: CURATOR_PROVIDER,
    ...(ANTHROPIC_KEY ? { ANTHROPIC_API_KEY: ANTHROPIC_KEY } : {}),
    ...(DEEPSEEK_KEY  ? { DEEPSEEK_API_KEY:  DEEPSEEK_KEY  } : {}),
  });

  // Per-session debounce state (main agent only)
  const pendingCurations = new Map();
  const sessionAutoscale = new Map();
  const sessionMemsearch = new Map();
  const sessionRetrievalState = new Map();
  const sessionActionTruth = new Map();

  try {
    mkdirSync(MEMORY.legacyRoot, { recursive: true });
    mkdirSync(MEMORY.sharedRoot, { recursive: true });
    mkdirSync(MEMORY.hostRoot, { recursive: true });
    mkdirSync(CANDIDATES_DIR, { recursive: true });
    mkdirSync(TELEMETRY_DIR, { recursive: true });
  } catch {}

  // Detect sub-agent sessions by session key format: agent:<id>:subagent:<uuid>
  function isSubagentSession(sessionId) {
    return typeof sessionId === "string" && sessionId.includes("subagent");
  }

  async function emitTelemetry(eventType, payload = {}) {
    if (!TELEMETRY_ENABLED) return;
    const event = {
      ts: new Date().toISOString(),
      source: "openbrain",
      event_type: eventType,
      payload,
    };

    if (TELEMETRY_WRITE_JSONL) {
      try {
        appendFileSync(join(TELEMETRY_DIR, `${TODAY()}.jsonl`), JSON.stringify(event) + "\n");
      } catch {}
    }

    if (TELEMETRY_WEBHOOK) {
      try {
        await fetch(TELEMETRY_WEBHOOK, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
      } catch {}
    }
  }

  // ── Cost logging ──────────────────────────────────────────────────────────────
  async function logCostToWebhook(event) {
    if (!COST_WEBHOOK) return;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    let usage = null, model = event.model || null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant" && msg.usage) {
        usage = msg.usage;
        if (!model && msg.model) model = msg.model;
        break;
      }
    }
    if (!usage) return;

    const body = {
      session_id:     event.sessionId || event.session_id || null,
      model:          model || `${CURATOR_PROVIDER}/${CURATOR_MODEL}`,
      role:           "assistant",
      tokens_in:      usage.input_tokens  || usage.prompt_tokens    || 0,
      tokens_out:     usage.output_tokens || usage.completion_tokens || 0,
      reported_cost:  usage.cost?.total ?? null,
      tags:           "openbrain-session",
    };

    await fetch(COST_WEBHOOK, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });

    emitTelemetry("cost.logged", body).catch(() => {});
  }

  // ── Curation scheduling ───────────────────────────────────────────────────────
  function scheduleCuration(sessionId, messages) {
    if (pendingCurations.has(sessionId)) {
      clearTimeout(pendingCurations.get(sessionId).timer);
    }

    const timer = setTimeout(() => {
      pendingCurations.delete(sessionId);
      const transcript = formatTranscript(messages);
      if (!transcript || transcript.length < 1000) return;

      api.logger?.info(`[openbrain] session ${sessionId.slice(0, 8)} idle — starting curation`);
      emitTelemetry("curation.started", {
        session_id: sessionId,
        mode: "candidates",
        transcript_chars: transcript.length,
      }).catch(() => {});

      const child = spawn("node", [CURATOR_SCRIPT, "--candidates"], { env: childEnv() });
      let stdout = "";
      child.stdout.on("data", d => { stdout += d; });
      child.stderr.on("data", d => api.logger?.warn(`[openbrain] curator: ${d.toString().trim()}`));
      child.on("close", code => {
        const last = stdout.trim().split("\n").pop() || "";
        api.logger?.info(`[openbrain] curation done (exit ${code}): ${last}`);
        emitTelemetry("curation.completed", {
          session_id: sessionId,
          mode: "candidates",
          exit_code: code,
          summary: last,
        }).catch(() => {});
      });
      child.on("error", e => api.logger?.warn(`[openbrain] curator spawn error: ${e.message}`));

      child.stdin.write(transcript);
      child.stdin.end();
    }, DEBOUNCE_MS);

    pendingCurations.set(sessionId, { timer, messages });
  }

  // ── Coherence check ───────────────────────────────────────────────────────────
  function runCoherenceCheck(payload) {
    return new Promise((resolve) => {
      const child = spawn("node", [COHERENCE_SCRIPT], { timeout: 25000, env: childEnv() });
      let stdout  = "";
      child.stdout.on("data", d => { stdout += d; });
      child.on("close", code  => resolve(code === 2 ? null : stdout.trim() || null));
      child.on("error", ()    => resolve(null));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  function logToWorkings(kind, verdict, question, response, activeContext = "") {
    const entry = `## ${kind} trace — ${TODAY()}
- verdict: ${verdict.split(":")[0]}
- tags: [${kind}, trace]

**Verdict:** ${verdict}

**Question (truncated):** ${question.slice(0, 200)}

**Response (truncated):** ${response.slice(0, 300)}

${activeContext ? `\n**Active context (truncated):** ${activeContext.slice(0, 220)}\n` : ""}

---
`;
    try { appendFileSync(WORKINGS_MD, "\n" + entry); } catch {}
  }

  function updateContinuityFiles(sessionId, messages) {
    if (!ACTIVE_MEMORY_ENABLED) return;

    const frame = deriveActiveFrame(messages);
    const loops = collectOpenLoops(messages);
    const ts = new Date().toISOString();

    if (frame) {
      const activeLines = [
        "# ACTIVE",
        `- updated_at: ${ts}`,
        `- session_id: ${sessionId}`,
        "",
        "## Current objective",
        frame.objective || "(not captured)",
        "",
        "## Constraints",
        ...(frame.constraints.length ? frame.constraints.map(c => `- ${c}`) : ["- none captured"]),
        "",
        "## Likely next step",
        frame.nextStep || "(not captured)",
        "",
      ];
      try { writeFileSync(ACTIVE_MD, activeLines.join("\n"), "utf8"); } catch {}
    }

    const stateTransfer = buildStateTransfer(sessionId, messages);
    if (stateTransfer) {
      try { writeFileSync(STATE_TRANSFER_JSON, `${JSON.stringify(stateTransfer, null, 2)}\n`, "utf8"); } catch {}
      try { materializeStateTransfer(HANDOFF_MD, stateTransfer); } catch {}
    }

    if (loops.length > 0) {
      const openLoopLines = [
        "# OPEN LOOPS",
        `- updated_at: ${ts}`,
        `- session_id: ${sessionId}`,
        "",
        ...loops.map(loop => `- ${loop}`),
        "",
      ];
      try { writeFileSync(OPEN_LOOPS_MD, openLoopLines.join("\n"), "utf8"); } catch {}
    }

    const exchange = extractExchange(messages);
    if (exchange) {
      const driftSignals = detectDriftSignals(exchange.question, exchange.response, loops, frame);
      emitTelemetry("continuity.updated", {
        session_id: sessionId,
        has_active_frame: Boolean(frame),
        has_state_handoff: Boolean(stateTransfer),
        open_loops_count: loops.length,
        drift_signal_count: driftSignals.length,
      }).catch(() => {});
      if (driftSignals.length > 0) {
        const driftLines = [
          "# DRIFT PATTERNS",
          `- updated_at: ${ts}`,
          `- session_id: ${sessionId}`,
          "",
          ...driftSignals.map(signal => `## ${signal.key}\n- description: ${signal.description}\n- suggested_intervention: ${signal.intervention}\n`),
        ];
        try { writeFileSync(DRIFT_PATTERNS_MD, driftLines.join("\n"), "utf8"); } catch {}

        const compensationLines = [
          "# COMPENSATION STRATEGIES",
          `- updated_at: ${ts}`,
          `- session_id: ${sessionId}`,
          "",
          ...driftSignals.map(signal => `## ${signal.key}\n- intervention: ${signal.intervention}\n- target_signal: ${signal.key}\n`),
        ];
        try { writeFileSync(COMPENSATION_STRATEGIES_MD, compensationLines.join("\n"), "utf8"); } catch {}
      }
    }

    const stableFacts = extractStableFacts(messages);
    const changedFacts = upsertStableFacts(STABLE_FACTS_JSONL, STABLE_CONTEXT_MD, stableFacts);
    if (changedFacts.length > 0) {
      emitTelemetry("stable_facts.updated", {
        session_id: sessionId,
        fact_keys: changedFacts,
        count: changedFacts.length,
      }).catch(() => {});
    }

    const constraints = extractConstraints(messages);
    const changedConstraints = upsertConstraints(CONSTRAINTS_JSONL, CONSTRAINTS_MD, constraints);
    if (changedConstraints.length > 0) {
      emitTelemetry("constraint.captured", {
        session_id: sessionId,
        constraint_keys: changedConstraints,
        count: changedConstraints.length,
      }).catch(() => {});
    }

    const procedures = extractProcedures(messages);
    const changedProcedures = upsertProcedures(PROCEDURES_JSONL, PROCEDURES_MD, procedures);
    if (changedProcedures.length > 0) {
      emitTelemetry("procedure.captured", {
        session_id: sessionId,
        procedure_keys: changedProcedures,
        count: changedProcedures.length,
      }).catch(() => {});
    }
  }

  function writeCandidateMemory(sessionId, messages) {
    const payload = buildCandidatePayload(sessionId, messages);
    if (!payload) return;

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(CANDIDATES_DIR, `${ts}-${safeSlug(sessionId, "session")}.json`);
    try { writeFileSync(file, JSON.stringify(payload, null, 2), "utf8"); } catch {}
    const byType = Object.create(null);
    for (const candidate of payload.candidates) {
      byType[candidate.type] = (byType[candidate.type] || 0) + 1;
    }
    emitTelemetry("candidates.staged", {
      session_id: sessionId,
      query_type: payload.query_type,
      candidate_count: payload.candidates.length,
      candidate_types: byType,
      file,
    }).catch(() => {});
  }

  function retrieveFromMemsearch(query, type) {
    if (!MEMSEARCH_ENABLED) return "";
    if (!existsSync(SEARCH_WRAPPER_SCRIPT) || !existsSync(MEMSEARCH_BIN)) return "";
    if (type === "temporal") return "";
    if (query.length < 16) return "";

    const result = spawnSync("node", [SEARCH_WRAPPER_SCRIPT, "search", query, "--provider", "local"], {
      env: childEnv(),
      encoding: "utf8",
      timeout: 6000,
      maxBuffer: 2 * 1024 * 1024,
    });

    if (result.error || result.status !== 0) {
      emitTelemetry("memsearch.lookup", {
        query,
        query_type: type,
        status: "miss",
        reason: result.error?.message || `exit_${result.status}`,
      }).catch(() => {});
      return "";
    }
    const parsed = parseMemsearchOutput(result.stdout, MEMSEARCH_MAX_CHARS);
    emitTelemetry("memsearch.lookup", {
      query,
      query_type: type,
      status: parsed ? "hit" : "miss",
      result_chars: parsed.length,
    }).catch(() => {});
    return parsed;
  }

  function shouldUseMemsearch(query, type, existingParts = [], sessionId = "default") {
    if (!MEMSEARCH_ENABLED) return false;
    if (type === "temporal") return false;
    if ((query || "").length < 32) return false;

    const q = (query || "").toLowerCase();
    const recallIntent = /\b(remember|previous|earlier|before|we decided|where is|what is the|path|token|credential|email|shopify|return|obsidian|vault|how do we|get the|recover|retrieve)\b/.test(q);
    const allowedType = type === "episodic" || type === "personal" || type === "procedural";
    if (!allowedType && !recallIntent) return false;

    const localChars = existingParts.reduce((sum, part) => sum + ((part?.body || "").length), 0);
    const strongLocalLayers = existingParts.filter(part =>
      ["stable_context", "constraints", "procedures", "mind", "active_frame"].includes(part?.layer)
    ).length;
    if (strongLocalLayers >= 3 || localChars >= 1100) return false;

    const now = Date.now();
    const last = sessionMemsearch.get(sessionId);
    if (last && (now - last.ts) < 90000) {
      const overlap = getQueryTerms(`${last.query} ${query}`).length;
      if (overlap >= 2) return false;
    }

    sessionMemsearch.set(sessionId, { ts: now, query });
    return true;
  }

  function shouldRunCoherenceCheck(exchange, subagent) {
    if (!COHERENCE_ENABLED || subagent) return false;
    if (!exchange?.response || exchange.response.length < COHERENCE_MIN_CHARS) return false;

    const question = exchange.question || "";
    const response = exchange.response || "";
    const activeContext = readIfExists(ACTIVE_MD);
    const riskSignals = [
      activeContext.length > 80,
      /\bmust|constraint|avoid|priority|only|without\b/i.test(question),
      /\bplan|architecture|strategy|design|decide|review|spec\b/i.test(question),
      response.length > 900,
    ];

    return riskSignals.filter(Boolean).length >= 2;
  }

  function updateAutoscaleState(sessionId, messages) {
    if (!AUTOSCALE_ENABLED) return null;
    const latestUser = findLatestRoleMessage(messages, "user");
    if (!latestUser) return null;
    const userText = getMessageText(latestUser);
    const failureTax = detectFailureTax(messages, STABLE_FACTS_JSONL);
    const current = sessionAutoscale.get(sessionId) || {
      clarification_turns: 0,
      correction_turns: 0,
      triggered: false,
      recommended_route: null,
      matched_fact_keys: [],
    };

    if (detectClarificationSignal(userText)) {
      current.clarification_turns += 1;
    }
    if (failureTax) {
      current.correction_turns += 1;
      current.matched_fact_keys = failureTax.matched_fact_keys || [];
      current.recommended_route = failureTax.recommended_route;
      current.correction_text = failureTax.correction_text || "";
      current.previous_answer = failureTax.previous_answer || "";
    }

    const shouldTrigger = current.correction_turns >= AUTOSCALE_CORRECT_TURNS
      || current.clarification_turns >= AUTOSCALE_CLARIFY_TURNS;
    if (shouldTrigger) {
      current.triggered = true;
      current.recommended_route = current.recommended_route || chooseEscalationRoute(userText, current.matched_fact_keys);
    }

    sessionAutoscale.set(sessionId, current);
    return { current, failureTax, userText };
  }

  // ── Hook: before_prompt_build — retrieval injection ───────────────────────────
  api.on("before_prompt_build", (event) => {
    try {
      let query = "";
      if (typeof event.prompt === "string") {
        query = event.prompt;
      } else if (Array.isArray(event.prompt)) {
        query = event.prompt.filter(b => b.type === "text").map(b => b.text).join(" ");
      } else {
        const messages = event.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === "user") {
            const c = messages[i].content;
            query   = typeof c === "string" ? c
              : Array.isArray(c) ? c.filter(b => b.type === "text").map(b => b.text).join(" ")
              : "";
            break;
          }
        }
      }

      if (!query || query.length < 10) return {};

      const sessionId = event.sessionId || event.session_id || "default";
      const type    = classifyQuery(query);
      const retrieval = buildRetrievalContext(type, query, WORKSPACE, {
        sessionId,
        stableContextEnabled: STABLE_CONTEXT_ENABLED,
        hotCacheMaxChars: 450,
        stableContextMaxChars: Math.min(STABLE_CONTEXT_MAX_CHARS, 450),
        activeMemoryEnabled: ACTIVE_MEMORY_ENABLED,
        prostheticMemoryEnabled: true,
        activeMaxChars: ACTIVE_MEMORY_MAX_CHARS,
        constraintMaxChars: CONSTRAINT_MAX_CHARS,
        procedureMaxChars: PROCEDURE_MAX_CHARS,
        openLoopsMaxChars: OPEN_LOOPS_MAX_CHARS,
        totalMaxChars: RETRIEVAL_TOTAL_MAX,
        sessionMaxChars: 600,
        mindMaxChars: 700,
        driftMaxChars: 400,
        compensationMaxChars: 400,
        memsearchEnabled: MEMSEARCH_ENABLED,
        memsearchMaxChars: MEMSEARCH_MAX_CHARS,
        retrieveFromMemsearch,
        shouldUseMemsearch: (currentQuery, currentType, parts) =>
          shouldUseMemsearch(currentQuery, currentType, parts, sessionId),
      });
      const context = retrieval?.context || null;
      const layersUsed = retrieval?.layersUsed || [];
      emitTelemetry("retrieval.built", {
        query_type: type,
        session_id: sessionId,
        layers_used: layersUsed,
        context_chars: context?.length || 0,
        tier_chars: retrieval?.tierChars || { stable: 0, semi_stable: 0, volatile: 0 },
        tier_hashes: retrieval?.tierHashes || null,
        cache_friendly: retrieval?.cacheFriendly ?? false,
        corrected_knowledge_used: layersUsed.includes("constraints") || layersUsed.includes("procedures"),
        used_handoff: layersUsed.includes("handoff"),
      }).catch(() => {});
      sessionRetrievalState.set(sessionId, {
        queryType: type,
        layersUsed,
        contextChars: context?.length || 0,
        builtAt: Date.now(),
        higherOrderHits: retrieval?.higherOrderHits || {
          conceptual_titles: [],
          cognitive_titles: [],
          emotional_titles: [],
          transfer_titles: [],
        },
      });

      if (layersUsed.includes("constraints")) {
        emitTelemetry("constraint.retrieved", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }
      if (layersUsed.includes("handoff")) {
        emitTelemetry("handoff.used", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }
      if (layersUsed.includes("procedures")) {
        emitTelemetry("procedure.retrieved", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }
      if (layersUsed.includes("conceptual_models")) {
        emitTelemetry("conceptual.retrieved", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }
      if (layersUsed.includes("cognitive_patterns")) {
        emitTelemetry("cognitive.retrieved", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }
      if (layersUsed.includes("emotional_patterns")) {
        emitTelemetry("emotional.retrieved", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }
      if (layersUsed.includes("transfer_hypotheses")) {
        emitTelemetry("transfer.retrieved", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }

      const liveConstraints = readJsonlObjects(CONSTRAINTS_JSONL);
      const constraintPolicyNote = buildConstraintPolicyNote(query, liveConstraints);
      const approvalGateNote = buildApprovalGateNote(query, liveConstraints);
      const artifactConflictNote = buildArtifactConflictNote(query, liveConstraints, readJsonlObjects(CONFLICT_ARTIFACTS_JSONL));
      if (approvalGateNote) {
        emitTelemetry("approval_gate.triggered", {
          session_id: sessionId,
          query_type: type,
        }).catch(() => {});
      }

      api.logger?.info(`[openbrain] ${type} query → retrieval ${context ? "hit" : "miss"}`);
      const autoscaleState = sessionAutoscale.get(sessionId);
      const actionTruthState = sessionActionTruth.get(sessionId);
      const routingNote = autoscaleState?.triggered
        ? `<!-- brain-autoscale -->\nRouting note: the cheap path is looping in this session (${autoscaleState.clarification_turns} clarification turns, ${autoscaleState.correction_turns} correction turns). Prefer escalating to ${autoscaleState.recommended_route || "anthropic/claude-sonnet-4-6"} if the current answer remains ambiguous.`
        : "";
      const actionTruthNote = actionTruthState?.unverified_claims >= 1
        ? `<!-- brain-action-truth -->\nAction-truth note: recent turns included ${actionTruthState.unverified_claims} unverified completion claim(s). If you claim a file or artifact was saved, moved, created, or updated, include the explicit output path so the claim is verifiable. Avoid vague completion claims.`
        : "";
      const appendSystemContext = [constraintPolicyNote, approvalGateNote, artifactConflictNote, context, routingNote, actionTruthNote].filter(Boolean).join("\n\n");
      return appendSystemContext ? { appendSystemContext } : {};
    } catch (e) {
      api.logger?.warn(`[openbrain] retrieval error: ${e.message}`);
      return {};
    }
  });

  // ── Immediate curation (sub-agents) ──────────────────────────────────────────
  function curateNow(sessionId, messages) {
    const transcript = formatTranscript(messages);
    if (!transcript || transcript.length < 1000) return;

    api.logger?.info(`[openbrain] subagent ${sessionId.slice(0, 16)} ended — curating immediately`);
    emitTelemetry("curation.started", {
      session_id: sessionId,
      mode: "candidates",
      subagent: true,
      transcript_chars: transcript.length,
    }).catch(() => {});

    const child = spawn("node", [CURATOR_SCRIPT, "--candidates"], { env: childEnv() });
    let stdout = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => api.logger?.warn(`[openbrain] curator: ${d.toString().trim()}`));
    child.on("close", code => {
      const last = stdout.trim().split("\n").pop() || "";
      api.logger?.info(`[openbrain] curation done (exit ${code}): ${last}`);
      emitTelemetry("curation.completed", {
        session_id: sessionId,
        mode: "candidates",
        subagent: true,
        exit_code: code,
        summary: last,
      }).catch(() => {});
    });
    child.on("error", e => api.logger?.warn(`[openbrain] curator spawn error: ${e.message}`));

    child.stdin.write(transcript);
    child.stdin.end();
  }

  // ── Hook: agent_end — cost log + eval + curation ──────────────────────────────
  api.on("agent_end", async (event) => {
    // Cost logging
    logCostToWebhook(event).catch(err =>
      api.logger?.warn(`[openbrain] cost-log failed: ${err.message}`)
    );

    const sessionId = event.sessionId || event.session_id || "default";
    const subagent  = isSubagentSession(sessionId);

    updateContinuityFiles(sessionId, event.messages || []);
    writeCandidateMemory(sessionId, event.messages || []);
    const autoscale = updateAutoscaleState(sessionId, event.messages || []);
    const failureTax = autoscale?.failureTax;
    if (failureTax) {
      const correctionText = failureTax.correction_text || "";
      const previousAnswer = failureTax.previous_answer || "";
      const constraintKeys = findMatchingConstraintKeys(correctionText, previousAnswer, CONSTRAINTS_JSONL);
      const procedureKeys = findMatchingProcedureKeys(correctionText, previousAnswer, PROCEDURES_JSONL);
      const contradictionEvents = [];
      for (const factKey of failureTax.matched_fact_keys || []) {
        contradictionEvents.push({
          target_key: factKey,
          target_type: "stable_fact",
          claim: previousAnswer,
          corrected_to: correctionText,
          correction_source: "user_correction",
          model: failureTax.previous_model,
          task_class: autoscale?.current?.recommended_route ? "autoscaled" : "direct",
          severity: "high",
          session_id: sessionId,
        });
      }
      for (const constraintKey of constraintKeys) {
        contradictionEvents.push({
          target_key: constraintKey,
          target_type: "constraint",
          claim: previousAnswer,
          corrected_to: correctionText,
          correction_source: "user_correction",
          model: failureTax.previous_model,
          task_class: "constraint_violation",
          severity: "high",
          session_id: sessionId,
        });
      }
      for (const procedureKey of procedureKeys) {
        contradictionEvents.push({
          target_key: procedureKey,
          target_type: "procedure",
          claim: previousAnswer,
          corrected_to: correctionText,
          correction_source: "user_correction",
          model: failureTax.previous_model,
          task_class: "procedure_failure",
          severity: "medium",
          session_id: sessionId,
        });
      }
      let contradictionCount = 0;
      for (const contradictionEvent of contradictionEvents) {
        if (recordContradictionEvent(CONTRADICTIONS_JSONL, contradictionEvent)) contradictionCount += 1;
      }
      const reinforcedConstraints = reinforceConstraintFromCorrection(
        CONSTRAINTS_JSONL,
        CONSTRAINTS_MD,
        constraintKeys,
        correctionText,
      );
      const reinforcedProcedures = reinforceProcedureFromCorrection(
        PROCEDURES_JSONL,
        PROCEDURES_MD,
        procedureKeys,
        correctionText,
      );
      emitTelemetry("model.failure_tax", {
        session_id: sessionId,
        ...failureTax,
        matched_constraint_keys: constraintKeys,
        matched_procedure_keys: procedureKeys,
      }).catch(() => {});
      if (contradictionCount > 0) {
        emitTelemetry("contradiction.detected", {
          session_id: sessionId,
          count: contradictionCount,
          stable_fact_keys: failureTax.matched_fact_keys || [],
          constraint_keys: constraintKeys,
          procedure_keys: procedureKeys,
        }).catch(() => {});
      }
      if (reinforcedConstraints.length > 0 || reinforcedProcedures.length > 0) {
        emitTelemetry("correction.applied", {
          session_id: sessionId,
          constraint_keys: reinforcedConstraints,
          procedure_keys: reinforcedProcedures,
        }).catch(() => {});
        emitTelemetry("object.superseded", {
          session_id: sessionId,
          constraint_keys: reinforcedConstraints,
          procedure_keys: reinforcedProcedures,
        }).catch(() => {});
      }
    }
    if (autoscale?.current?.triggered) {
      emitTelemetry("model.escalation_recommended", {
        session_id: sessionId,
        clarification_turns: autoscale.current.clarification_turns,
        correction_turns: autoscale.current.correction_turns,
        recommended_route: autoscale.current.recommended_route,
        matched_fact_keys: autoscale.current.matched_fact_keys || [],
      }).catch(() => {});
    }

    const retrievalState = sessionRetrievalState.get(sessionId) || {
      queryType: classifyQuery(extractExchange(event.messages)?.question || ""),
      layersUsed: [],
      contextChars: 0,
    };
    const assistantChars = exchange?.response?.length || 0;
    const usedProcedureRetrieval = retrievalState.layersUsed.includes("procedures");
    const usedConstraintRetrieval = retrievalState.layersUsed.includes("constraints");
    const usedStableContext = retrievalState.layersUsed.includes("stable_context");
    const usedMemsearch = retrievalState.layersUsed.includes("memsearch");
    const usedConceptualRetrieval = retrievalState.layersUsed.includes("conceptual_models");
    const usedCognitiveRetrieval = retrievalState.layersUsed.includes("cognitive_patterns");
    const usedEmotionalRetrieval = retrievalState.layersUsed.includes("emotional_patterns");
    const usedTransferRetrieval = retrievalState.layersUsed.includes("transfer_hypotheses");
    const clarificationTurns = autoscale?.current?.clarification_turns || 0;
    const correctionTurns = autoscale?.current?.correction_turns || 0;
    const escalationTriggered = Boolean(autoscale?.current?.triggered);
    const resolvedCleanly = clarificationTurns === 0 && correctionTurns === 0 && !escalationTriggered;
    const likelySavedRediscovery = usedProcedureRetrieval && correctionTurns === 0;
    const likelySavedConstraintViolation = usedConstraintRetrieval && correctionTurns === 0;
    const resolutionScore = Math.max(
      0,
      Math.min(
        100,
        100
          - (clarificationTurns * 18)
          - (correctionTurns * 32)
          - (escalationTriggered ? 12 : 0)
          + (usedProcedureRetrieval ? 8 : 0)
          + (usedConstraintRetrieval ? 5 : 0)
          + (usedStableContext ? 4 : 0)
          + (usedConceptualRetrieval ? 4 : 0)
          + (usedCognitiveRetrieval ? 3 : 0)
          + (usedEmotionalRetrieval ? 2 : 0)
          + (usedTransferRetrieval ? 3 : 0)
      )
    );

    const higherOrderHits = retrievalState.higherOrderHits || {};
    if (resolvedCleanly) {
      const reinforcedConceptual = reinforceSpecializedEntries(
        join(MEMORY.sharedRoot, "conceptual-models.md"),
        "conceptual_model",
        higherOrderHits.conceptual_titles || [],
      );
      const reinforcedCognitive = reinforceSpecializedEntries(
        join(MEMORY.sharedRoot, "cognitive-patterns.md"),
        "cognitive_pattern",
        higherOrderHits.cognitive_titles || [],
      );
      const reinforcedEmotional = reinforceSpecializedEntries(
        join(MEMORY.sharedRoot, "emotional-patterns.md"),
        "emotional_pattern",
        higherOrderHits.emotional_titles || [],
      );
      const reinforcedTransfer = reinforceSpecializedEntries(
        join(MEMORY.sharedRoot, "transfer-hypotheses.md"),
        "transfer_hypothesis",
        higherOrderHits.transfer_titles || [],
      );

      if (
        reinforcedConceptual.length ||
        reinforcedCognitive.length ||
        reinforcedEmotional.length ||
        reinforcedTransfer.length
      ) {
        emitTelemetry("higher_order.reinforced", {
          session_id: sessionId,
          conceptual_count: reinforcedConceptual.length,
          cognitive_count: reinforcedCognitive.length,
          emotional_count: reinforcedEmotional.length,
          transfer_count: reinforcedTransfer.length,
        }).catch(() => {});
        for (const title of reinforcedConceptual) {
          emitTelemetry("conceptual.reinforced", { session_id: sessionId, title }).catch(() => {});
        }
        for (const title of reinforcedCognitive) {
          emitTelemetry("cognitive.reinforced", { session_id: sessionId, title }).catch(() => {});
        }
        for (const title of reinforcedEmotional) {
          emitTelemetry("emotional.reinforced", { session_id: sessionId, title }).catch(() => {});
        }
        for (const title of reinforcedTransfer) {
          emitTelemetry("transfer.reinforced", { session_id: sessionId, title }).catch(() => {});
        }
      }
    }

    emitTelemetry("task.resolution", {
      session_id: sessionId,
      query_type: retrievalState.queryType,
      model: event.model || null,
      assistant_chars: assistantChars,
      context_chars: retrievalState.contextChars || 0,
      clarification_turns: clarificationTurns,
      correction_turns: correctionTurns,
      escalation_triggered: escalationTriggered,
      used_procedure_retrieval: usedProcedureRetrieval,
      used_constraint_retrieval: usedConstraintRetrieval,
      used_stable_context: usedStableContext,
      used_memsearch: usedMemsearch,
      used_conceptual_retrieval: usedConceptualRetrieval,
      used_cognitive_retrieval: usedCognitiveRetrieval,
      used_emotional_retrieval: usedEmotionalRetrieval,
      used_transfer_retrieval: usedTransferRetrieval,
      likely_saved_rediscovery: likelySavedRediscovery,
      likely_saved_constraint_violation: likelySavedConstraintViolation,
      resolved_cleanly: resolvedCleanly,
      resolution_score: resolutionScore,
    }).catch(() => {});

    if (exchange?.response) {
      const constraintViolations = detectConstraintViolations(exchange.question || "", exchange.response, CONSTRAINTS_JSONL);
      if (constraintViolations.length > 0) {
        const changedConstraints = recordConstraintViolations(
          CONSTRAINTS_JSONL,
          CONSTRAINTS_MD,
          constraintViolations,
          exchange.response,
        );
        const referencedArtifactPaths = extractReferencedArtifactPaths(exchange.response || "");
        const changedConflictArtifacts = upsertConflictArtifacts(
          CONFLICT_ARTIFACTS_JSONL,
          referencedArtifactPaths.map(path => ({
            conflict_key: `artifact_conflict_${safeSlug(path, "artifact-conflict")}`,
            path,
            scope: inferScope(`${exchange.question || ""}\n${path}`),
            constraint_keys: constraintViolations.map(item => item.constraint_key),
            evidence: [summarizeLine(exchange.response, 220)],
            conflict_count: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            session_id: sessionId,
          }))
        );
        emitTelemetry("constraint.violated", {
          session_id: sessionId,
          count: constraintViolations.length,
          constraint_keys: constraintViolations.map(item => item.constraint_key),
          conflict_artifact_keys: changedConflictArtifacts,
        }).catch(() => {});
        emitTelemetry("verification.failed", {
          session_id: sessionId,
          type: "constraint_compliance",
          constraint_keys: changedConstraints,
          conflict_artifact_keys: changedConflictArtifacts,
        }).catch(() => {});
      } else {
        emitTelemetry("verification.passed", {
          session_id: sessionId,
          type: "constraint_compliance",
        }).catch(() => {});
      }
    }

    if (exchange?.response) {
      const { commitments, artifacts } = buildCommitmentsFromExchange(sessionId, exchange);
      if (commitments.length > 0) {
        const actionTruthState = sessionActionTruth.get(sessionId) || {
          verified_claims: 0,
          failed_claims: 0,
          unverified_claims: 0,
        };
        emitTelemetry("commitment.created", {
          session_id: sessionId,
          count: commitments.length,
        }).catch(() => {});
        const changedCommitments = upsertCommitments(COMMITMENTS_JSONL, commitments);
        const changedArtifacts = upsertArtifacts(ARTIFACTS_JSONL, artifacts);
        for (const commitment of commitments) {
          emitTelemetry("verification.started", {
            session_id: sessionId,
            commitment_key: commitment.commitment_key,
            intended_path: commitment.intended_path,
          }).catch(() => {});
          if (commitment.verification_status === "verified") {
            emitTelemetry("verification.passed", {
              session_id: sessionId,
              commitment_key: commitment.commitment_key,
              actual_path: commitment.actual_path,
            }).catch(() => {});
            emitTelemetry("commitment.verified", {
              session_id: sessionId,
              commitment_key: commitment.commitment_key,
            }).catch(() => {});
            actionTruthState.verified_claims += 1;
          } else if (commitment.verification_status === "unverified") {
            emitTelemetry("verification.skipped", {
              session_id: sessionId,
              commitment_key: commitment.commitment_key,
              reason: "no_explicit_path",
            }).catch(() => {});
            emitTelemetry("commitment.unverified", {
              session_id: sessionId,
              commitment_key: commitment.commitment_key,
              claim: commitment.claim,
            }).catch(() => {});
            actionTruthState.unverified_claims += 1;
          } else {
            emitTelemetry("verification.failed", {
              session_id: sessionId,
              commitment_key: commitment.commitment_key,
              intended_path: commitment.intended_path,
            }).catch(() => {});
            emitTelemetry("commitment.failed", {
              session_id: sessionId,
              commitment_key: commitment.commitment_key,
            }).catch(() => {});
            emitTelemetry("artifact.misplaced", {
              session_id: sessionId,
              artifact_key: commitment.target_artifact,
              intended_path: commitment.intended_path,
            }).catch(() => {});
            actionTruthState.failed_claims += 1;
          }
        }
        sessionActionTruth.set(sessionId, actionTruthState);
        emitTelemetry("action_truth.updated", {
          session_id: sessionId,
          verified_claims: actionTruthState.verified_claims,
          failed_claims: actionTruthState.failed_claims,
          unverified_claims: actionTruthState.unverified_claims,
        }).catch(() => {});
        if (changedArtifacts.length > 0) {
          emitTelemetry("artifact.created", {
            session_id: sessionId,
            artifact_keys: changedArtifacts,
            verified: artifacts.filter(item => item.verified_written).length,
          }).catch(() => {});
        }
      }

      const actionTruthState = sessionActionTruth.get(sessionId) || {
        verified_claims: 0,
        failed_claims: 0,
        unverified_claims: 0,
      };
      const constraintViolations = detectConstraintViolations(exchange.question || "", exchange.response, CONSTRAINTS_JSONL);
      const decisionContext = {
        success: resolvedCleanly,
        resolutionScore,
        correctionTurns,
        clarificationTurns,
        escalated: escalationTriggered,
        contradictions: failureTax ? 1 : 0,
        commitments: commitments.map((commitment) => commitment.commitment_key),
        constraintViolations: constraintViolations.map((item) => item.constraint_key),
        verifiedClaims: actionTruthState.verified_claims || 0,
        failedClaims: actionTruthState.failed_claims || 0,
        assistantChars: exchange.response.length,
        sourceRefs: [
          `session:${sessionId}`,
          ...commitments.map((commitment) => commitment.commitment_key),
        ],
      };

      const decisionRecord = buildDecisionLedgerRecord(sessionId, exchange, decisionContext);
      const outcomeRecord = buildOutcomeLedgerRecord(sessionId, exchange, decisionContext);
      writeDecisionRecord(WORKSPACE, decisionRecord);
      writeOutcomeRecord(WORKSPACE, outcomeRecord);
      emitTelemetry("decision.logged", {
        session_id: sessionId,
        decision_key: decisionRecord.decision_key,
        outcome_key: outcomeRecord.outcome_key,
        success: decisionContext.success,
      }).catch(() => {});
    }

    // Curation — immediate for sub-agents, debounced for main agent
    if (subagent && CURATE_SUBAGENTS) {
      curateNow(sessionId, event.messages || []);
    } else if (!subagent) {
      scheduleCuration(sessionId, event.messages || []);
    }

    // Selective coherence check — main agent only on higher-risk replies
    if (!exchange || exchange.response.length < MIN_CHARS) return;
    if (!shouldRunCoherenceCheck(exchange, subagent)) return;

    const activeContext = trimToChars(readIfExists(ACTIVE_MD), 500);
    const verdict = await runCoherenceCheck({
      question: exchange.question,
      response: exchange.response,
      activeContext,
    });
    if (!verdict) return;

    api.logger?.info(`[openbrain] coherence: ${verdict}`);
    emitTelemetry("coherence.checked", {
      session_id: sessionId,
      verdict,
      flagged: verdict.startsWith("FLAG") || verdict.startsWith("REVISE"),
    }).catch(() => {});

    if (verdict.startsWith("FLAG") || verdict.startsWith("REVISE")) {
      logToWorkings("coherence-check", verdict, exchange.question, exchange.response, activeContext);
    }
  });

  api.logger?.info(`[openbrain] loaded — workspace: ${WORKSPACE}, curator: ${CURATOR_PROVIDER}/${CURATOR_MODEL}, coherence: ${COHERENCE_PROVIDER}/${COHERENCE_MODEL}, debounce: ${DEBOUNCE_MS / 60000}m, activeMemory: ${ACTIVE_MEMORY_ENABLED ? "on" : "off"}, curateSubagents: ${CURATE_SUBAGENTS ? "on" : "off"}`);
}
