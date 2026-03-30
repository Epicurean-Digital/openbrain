#!/usr/bin/env node
/**
 * hot-cache.js
 * Ranks all MIND.md entries by relevance score and writes top-N to HOT_CACHE.md.
 *
 *   score = confidence × log(1 + reinforced) × recency(60d half-life) × decay_factor
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

    entries.push({
      raw:            trimmed,
      title:          (trimmed.match(/^## (.+)$/m) || [])[1] || "Unknown",
      type:           get("type") || "semantic",
      confidence:     parseFloat(get("confidence") || "0.5"),
      reinforced:     parseInt(get("reinforced") || "1", 10),
      decay:          get("decay") || "slow",
      lastReinforced: get("last_reinforced") || get("last-reinforced") || TODAY,
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
  const days       = daysSince(entry.lastReinforced);

  const recency = Math.exp(-days / 60);

  const halfLives   = { permanent: Infinity, slow: 180, medium: 60, fast: 14 };
  const h           = halfLives[entry.decay] || 60;
  const decayFactor = h === Infinity ? 1.0 : Math.pow(0.5, days / h);

  return confidence * Math.log(1 + reinforced) * recency * decayFactor;
}

function buildHotCache(entries) {
  const scored = entries
    .map(e => ({ ...e, score: scoreEntry(e) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  const lines = [
    `# HOT CACHE — Top ${scored.length} memories by relevance`,
    `<!-- auto-generated ${TODAY} · score = confidence × log(1+reinforced) × recency × decay -->`,
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
