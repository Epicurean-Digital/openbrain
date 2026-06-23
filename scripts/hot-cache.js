#!/usr/bin/env node
/**
 * hot-cache.js
 * Ranks all MIND.md entries by relevance score and writes top-N to HOT_CACHE.md.
 *
 *   score = confidence × log(1 + reinforced) × recency(60d half-life) × decay_factor
 *           × utility_factor × contradiction_factor
 *
 * HOT_CACHE.md is the L0 context — always loaded at session start.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WORKSPACE = process.env.OPENBRAIN_WORKSPACE
  || join(homedir(), ".openclaw/workspace");
const MIND_MD   = join(WORKSPACE, "memory/MIND.md");
const HOT_CACHE = join(WORKSPACE, "memory/HOT_CACHE.md");
const TOP_N     = parseInt(process.env.OPENBRAIN_HOT_CACHE_SIZE || "25", 10);
const TODAY     = new Date().toISOString().slice(0, 10);

function readFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseCount(raw) {
  if (raw == null) return 0;
  const text = String(raw).trim();
  if (!text || text === "[]" || text === "none") return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return Math.max(0, numeric);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return 0;
    return inner.split(",").map(item => item.trim()).filter(Boolean).length;
  }
  return 1;
}

function parseUtilityScore(rawUtility, reinforced, trajectory) {
  if (rawUtility) {
    const lowered = rawUtility.toLowerCase();
    if (lowered === "high") return 0.9;
    if (lowered === "medium" || lowered === "med") return 0.65;
    if (lowered === "low") return 0.35;
    const numeric = Number(rawUtility);
    if (Number.isFinite(numeric)) return clamp01(numeric > 1 ? numeric / 100 : numeric);
  }

  const reinforcementSignal = Math.log1p(Math.max(0, reinforced)) / Math.log1p(8);
  const trajectoryBoost = /established/i.test(trajectory) ? 0.12 : /fading/i.test(trajectory) ? -0.12 : 0;
  return clamp01(reinforcementSignal + trajectoryBoost);
}

function parseMindEntries(content) {
  const entries = [];
  const blocks  = content.split(/\n---+\n/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("## [")) continue;

    const get = (field) => {
      const m = trimmed.match(new RegExp(`^- ${field}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : null;
    };

    const reinforced = parseInt(get("reinforced") || get("reinforcement_count") || "1", 10);
    const trajectory = get("trajectory") || "established";
    const utilityScore = parseUtilityScore(get("utility_score") || get("utility") || get("usefulness"), Number.isFinite(reinforced) ? reinforced : 1, trajectory);
    const conflictCount = parseCount(get("conflict_count") || get("contradiction_count") || get("contradictions") || get("violations"));

    entries.push({
      raw:            trimmed,
      title:          (trimmed.match(/^## (.+)$/m) || [])[1] || "Unknown",
      type:           get("type") || "semantic",
      confidence:     parseFloat(get("confidence") || "0.5"),
      reinforced,
      decay:          get("decay") || "slow",
      lastReinforced: get("last_reinforced") || get("last-reinforced") || TODAY,
      utilityScore,
      conflictCount,
    });
  }

  return entries;
}

function daysSince(dateStr) {
  try { return Math.max(0, (Date.now() - new Date(dateStr).getTime()) / 86400000); }
  catch { return 30; }
}

function scoreEntry(entry) {
  const confidence = isNaN(entry.confidence) ? 0.5 : entry.confidence;
  const reinforced = isNaN(entry.reinforced) ? 1   : entry.reinforced;
  const utilityScore = Number.isFinite(entry.utilityScore) ? entry.utilityScore : 0;
  const conflictCount = Number.isFinite(entry.conflictCount) ? entry.conflictCount : 0;
  const days       = daysSince(entry.lastReinforced);

  const recency = Math.exp(-days / 60);

  const halfLives   = { permanent: Infinity, slow: 180, medium: 60, fast: 14 };
  const h           = halfLives[entry.decay] || 60;
  const decayFactor = h === Infinity ? 1.0 : Math.pow(0.5, days / h);
  const utilityFactor = 1 + (utilityScore * 0.8);
  const contradictionFactor = 1 / (1 + (conflictCount * 0.6));

  return confidence * Math.log(1 + reinforced) * recency * decayFactor * utilityFactor * contradictionFactor;
}

function buildHotCache(entries) {
  const scored = entries
    .map(e => ({ ...e, score: scoreEntry(e) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  const lines = [
    `# HOT CACHE — Top ${scored.length} memories by relevance`,
    `<!-- auto-generated ${TODAY} · score = confidence × log(1+reinforced) × recency × decay × utility × contradiction -->`,
    `<!-- this file is L0 context — read at session start before any query -->`,
    ``,
  ];

  for (const entry of scored) {
    lines.push(entry.raw);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  const content = readFile(MIND_MD);
  if (!content) {
    console.log("[hot-cache] MIND.md not found — skipping");
    return;
  }

  const entries = parseMindEntries(content);
  if (entries.length === 0) {
    console.log("[hot-cache] no entries found in MIND.md — skipping");
    return;
  }

  const hotCache = buildHotCache(entries);
  writeFileSync(HOT_CACHE, hotCache, "utf8");
  console.log(`[hot-cache] wrote top ${Math.min(entries.length, TOP_N)} of ${entries.length} entries → HOT_CACHE.md`);
}

main();
