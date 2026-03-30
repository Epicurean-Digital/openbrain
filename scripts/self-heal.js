#!/usr/bin/env node
/**
 * self-heal.js
 * Checks and rebuilds the three pillars of the memory system.
 * Called by curator.js after every curation run.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join }     from "node:path";

const WORKSPACE  = process.env.OPENBRAIN_WORKSPACE
  || join(homedir(), ".openclaw/workspace");
const MEMORY_MD  = join(WORKSPACE, "MEMORY.md");
const AGENTS_MD  = join(WORKSPACE, "AGENTS.md");
const MIND_MD    = join(WORKSPACE, "memory/MIND.md");
const HOT_CACHE  = join(WORKSPACE, "memory/HOT_CACHE.md");
const MEMSEARCH  = join(homedir(), ".memsearch-venv/bin/memsearch");
const LAST_INDEXED = join(homedir(), ".memsearch-venv/last-indexed");
const SEARCH_ALIAS = `node ${join(import.meta.dirname, "search-wrapper.js")}`;
const NOW = new Date().toISOString();

const heals = [];

// ── 1. MEMORY.md permanent pointer ────────────────────────────────────────────
const POINTER = `<!-- permanent -->\nLong-term memory lives in MIND.md — query via memsearch when topics feel like they have history.`;

if (existsSync(MEMORY_MD)) {
  const content = readFileSync(MEMORY_MD, "utf8");
  if (!content.includes("Long-term memory lives in MIND.md")) {
    appendFileSync(MEMORY_MD, `\n\n${POINTER}\n`);
    heals.push("MEMORY.md permanent pointer rebuilt");
  }
} else {
  writeFileSync(MEMORY_MD, `# MEMORY.md\n\n${POINTER}\n`);
  heals.push("MEMORY.md created and permanent pointer added");
}

// ── 2. AGENTS.md discipline rule ──────────────────────────────────────────────
const DISCIPLINE_RULE = `
## Long-Term Memory
When a topic arises that feels like it has history — projects, people, decisions, patterns — query MIND.md via memsearch before responding:
\`\`\`
${MEMSEARCH} search "<topic>" --provider local
\`\`\`
`;

if (existsSync(AGENTS_MD)) {
  const content = readFileSync(AGENTS_MD, "utf8");
  if (!content.includes("query MIND.md")) {
    appendFileSync(AGENTS_MD, DISCIPLINE_RULE);
    heals.push("AGENTS.md discipline rule re-injected");
  }
} else {
  writeFileSync(AGENTS_MD, `# AGENTS.md\n${DISCIPLINE_RULE}`);
  heals.push("AGENTS.md created with discipline rule");
}

// ── 2b. AGENTS.md memsearch wrapper ───────────────────────────────────────────
const SEARCH_RULE = `
## Memory Search
When querying long-term memory, use the instrumented wrapper (logs retrievals for reinforcement):
\`\`\`
${SEARCH_ALIAS} search "<topic>" --provider local
\`\`\`
`;

if (existsSync(AGENTS_MD)) {
  const content = readFileSync(AGENTS_MD, "utf8");
  if (!content.includes("search-wrapper.js")) {
    appendFileSync(AGENTS_MD, SEARCH_RULE);
    heals.push("AGENTS.md memory-search wrapper added");
  }
}

// ── 2c. AGENTS.md hot cache directive ─────────────────────────────────────────
const HOT_CACHE_DIRECTIVE = `
## Hot Cache (L0 Context)
At the start of each session, read memory/HOT_CACHE.md — it contains your most relevant long-term knowledge, pre-ranked by confidence and recency. This is your baseline context before any query.
`;

if (existsSync(AGENTS_MD)) {
  const content = readFileSync(AGENTS_MD, "utf8");
  if (!content.includes("HOT_CACHE.md")) {
    appendFileSync(AGENTS_MD, HOT_CACHE_DIRECTIVE);
    heals.push("AGENTS.md HOT_CACHE directive added");
  }
}

// ── 2d. HOT_CACHE.md existence ────────────────────────────────────────────────
if (!existsSync(HOT_CACHE)) {
  writeFileSync(HOT_CACHE, `# HOT CACHE\n<!-- will be populated after first curation run -->\n`);
  heals.push("HOT_CACHE.md scaffolded");
}

// ── 3. MIND.md existence ──────────────────────────────────────────────────────
if (!existsSync(MIND_MD)) {
  writeFileSync(MIND_MD, `# MIND.md — Long-Term Memory

> Auto-generated. Human-readable mirror of the agent's long-term memory.
> Source of truth for cross-session knowledge. Queried on demand via memsearch.
> Do not delete — rebuilt automatically if missing.

<!-- self-heal: scaffolded ${NOW} -->
`);
  heals.push("MIND.md scaffolded");
}

// ── 4. memsearch index ────────────────────────────────────────────────────────
if (existsSync(MEMSEARCH)) {
  try {
    let lastIndexed = 0;
    if (existsSync(LAST_INDEXED)) {
      lastIndexed = parseInt(readFileSync(LAST_INDEXED, "utf8").trim(), 10) || 0;
    }

    const mindMtime = parseInt(
      execSync(`stat -c %Y "${MIND_MD}"`).toString().trim(), 10
    ) * 1000;

    if (mindMtime > lastIndexed) {
      try { execSync("systemctl --user stop memsearch-watcher", { stdio: "pipe" }); } catch {}
      try {
        execSync(`"${MEMSEARCH}" index "${WORKSPACE}/memory" --provider local`, { stdio: "pipe" });
        writeFileSync(LAST_INDEXED, Date.now().toString());
        heals.push("memsearch re-indexed MIND.md");
      } finally {
        try { execSync("systemctl --user start memsearch-watcher", { stdio: "pipe" }); } catch {}
      }
    }
  } catch {
    console.log("[self-heal] memsearch index skipped (watcher will sync)");
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (heals.length > 0) {
  const report = heals.map(h => `<!-- self-heal: ${h} ${NOW} -->`).join("\n");
  appendFileSync(MIND_MD, `\n${report}\n`);
  console.log("[self-heal]", heals.join("; "));
} else {
  console.log("[self-heal] all checks passed");
}
