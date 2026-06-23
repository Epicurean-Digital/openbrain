#!/usr/bin/env node
/**
 * decay.js
 * Applies utility-aware confidence decay to MIND.md entries.
 *
 * For each non-permanent entry:
 *   new_confidence = confidence × 0.5^(days_since_last_decay / effective_half_life)
 *
 * Half-lives: slow=180d  medium=60d  fast=14d  permanent=∞
 *
 * Thresholds:
 *   confidence < 0.3  → trajectory: fading
 *   confidence < 0.05 → archived to memory/archive/MIND-archive.md + removed from MIND.md
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WORKSPACE  = process.env.OPENBRAIN_WORKSPACE
  || join(homedir(), ".openclaw/workspace");
const MIND_MD    = join(WORKSPACE, "memory/MIND.md");
const ARCHIVE_MD = join(WORKSPACE, "memory/archive/MIND-archive.md");
const TODAY      = new Date().toISOString().slice(0, 10);

const HALF_LIVES = { permanent: Infinity, slow: 180, medium: 60, fast: 14 };
const ARCHIVE_THRESHOLD = 0.05;
const FADING_THRESHOLD  = 0.3;

function readFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  try { return Math.max(0, (Date.now() - new Date(dateStr).getTime()) / 86400000); }
  catch { return 0; }
}

function getField(block, field) {
  const m = block.match(new RegExp(`^- ${field}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
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

function parseUtilityScore(block, reinforced, trajectory) {
  const raw = getField(block, "utility_score")
    || getField(block, "utility")
    || getField(block, "usefulness");

  if (raw) {
    const lowered = raw.toLowerCase();
    if (lowered === "high") return 0.9;
    if (lowered === "medium" || lowered === "med") return 0.65;
    if (lowered === "low") return 0.35;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return clamp01(numeric > 1 ? numeric / 100 : numeric);
  }

  const reinforcementSignal = Math.log1p(Math.max(0, reinforced)) / Math.log1p(8);
  const trajectoryBoost = /established/i.test(trajectory) ? 0.12 : /fading/i.test(trajectory) ? -0.12 : 0;
  return clamp01(reinforcementSignal + trajectoryBoost);
}

function parseConflictCount(block) {
  const raw = getField(block, "conflict_count")
    || getField(block, "contradiction_count")
    || getField(block, "contradictions")
    || getField(block, "violations");
  return parseCount(raw);
}

function adjustedHalfLife(baseHalfLife, utilityScore, conflictCount) {
  const utilityBoost = 1 + (clamp01(utilityScore) * 0.8);
  const conflictPenalty = 1 + (Math.max(0, conflictCount) * 0.45);
  return Math.max(3, (baseHalfLife * utilityBoost) / conflictPenalty);
}

function applyDecay(block) {
  const decay = getField(block, "decay") || "slow";
  if (decay === "permanent") return { block, archived: false, changed: false };

  const confidence     = parseFloat(getField(block, "confidence") || "0.5");
  const reinforced     = parseInt(getField(block, "reinforced") || getField(block, "reinforcement_count") || "1", 10);
  const trajectory     = getField(block, "trajectory") || "established";
  const lastReinforced = getField(block, "last_reinforced") || TODAY;
  const lastDecay      = getField(block, "last_decay_applied") || lastReinforced;
  const utilityScore   = parseUtilityScore(block, Number.isFinite(reinforced) ? reinforced : 1, trajectory);
  const conflictCount  = parseConflictCount(block);

  if (isNaN(confidence)) return { block, archived: false, changed: false };

  const days = daysSince(lastDecay);
  if (days < 1) return { block, archived: false, changed: false };

  const h       = HALF_LIVES[decay] || 60;
  const effectiveHalfLife = adjustedHalfLife(h, utilityScore, conflictCount);
  const newConf = parseFloat((confidence * Math.pow(0.5, days / effectiveHalfLife)).toFixed(3));

  if (newConf < ARCHIVE_THRESHOLD) {
    return { block, archived: true, changed: false };
  }

  let updated = block;

  updated = updated.replace(/^(- confidence:\s*)[\d.]+$/m, `$1${newConf}`);

  if ((newConf < FADING_THRESHOLD || (conflictCount > 0 && newConf < 0.45)) && trajectory !== "fading") {
    updated = updated.replace(/^(- trajectory:\s*)\w+$/m, "$1fading");
  }

  if (/^- last_decay_applied:/m.test(updated)) {
    updated = updated.replace(/^(- last_decay_applied:\s*).+$/m, `$1${TODAY}`);
  } else {
    updated = updated.replace(/^(- last_reinforced:\s*.+)$/m, `$1\n- last_decay_applied: ${TODAY}`);
  }

  return { block: updated, archived: false, changed: updated !== block };
}

function parseMindFile(content) {
  const firstEntry = content.indexOf("\n## [");
  const header  = firstEntry > -1 ? content.slice(0, firstEntry) : content;
  const body    = firstEntry > -1 ? content.slice(firstEntry + 1) : "";

  const sections = body
    .split(/\n---\n/)
    .map(s => s.trim())
    .filter(s => s.startsWith("## ["));

  return { header, sections };
}

function rebuildMindFile(header, sections) {
  if (sections.length === 0) return header.trimEnd() + "\n";
  return header.trimEnd() + "\n\n" + sections.join("\n\n---\n\n") + "\n\n---\n";
}

function main() {
  const content = readFile(MIND_MD);
  if (!content) {
    console.log("[decay] MIND.md not found — skipping");
    return;
  }

  const { header, sections } = parseMindFile(content);

  const kept     = [];
  const archived = [];
  let   decayed  = 0;

  for (const section of sections) {
    const result = applyDecay(section);
    if (result.archived) {
      archived.push(section);
    } else {
      kept.push(result.block);
      if (result.changed) decayed++;
    }
  }

  writeFileSync(MIND_MD, rebuildMindFile(header, kept), "utf8");

  if (archived.length > 0) {
    const archiveDir = join(WORKSPACE, "memory/archive");
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    const archiveBlock = `\n## Archived ${TODAY}\n\n${archived.join("\n\n---\n\n")}\n\n---\n`;
    appendFileSync(ARCHIVE_MD, archiveBlock, "utf8");
    console.log(`[decay] archived ${archived.length} expired entries`);
  }

  console.log(decayed > 0
    ? `[decay] applied decay to ${decayed} of ${sections.length} entries`
    : `[decay] no decay needed (${sections.length} entries checked)`);
}

main();
