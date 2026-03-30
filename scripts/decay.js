#!/usr/bin/env node
/**
 * decay.js
 * Applies time-based confidence decay to MIND.md entries.
 *
 * For each non-permanent entry:
 *   new_confidence = confidence × 0.5^(days_since_last_decay / half_life)
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

function applyDecay(block) {
  const decay = getField(block, "decay") || "slow";
  if (decay === "permanent") return { block, archived: false, changed: false };

  const confidence     = parseFloat(getField(block, "confidence") || "0.5");
  const trajectory     = getField(block, "trajectory") || "established";
  const lastReinforced = getField(block, "last_reinforced") || TODAY;
  const lastDecay      = getField(block, "last_decay_applied") || lastReinforced;

  if (isNaN(confidence)) return { block, archived: false, changed: false };

  const days = daysSince(lastDecay);
  if (days < 1) return { block, archived: false, changed: false };

  const h       = HALF_LIVES[decay] || 60;
  const newConf = parseFloat((confidence * Math.pow(0.5, days / h)).toFixed(3));

  if (newConf < ARCHIVE_THRESHOLD) {
    return { block, archived: true, changed: false };
  }

  let updated = block;

  updated = updated.replace(/^(- confidence:\s*)[\d.]+$/m, `$1${newConf}`);

  if (newConf < FADING_THRESHOLD && trajectory !== "fading") {
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
