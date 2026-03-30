#!/usr/bin/env node
/**
 * search-wrapper.js
 * Thin wrapper around memsearch that logs every retrieval for reinforcement tracking.
 *
 * Usage: identical to memsearch — replace the binary path in AGENTS.md.
 *   node search-wrapper.js search "<query>" --provider local
 *
 * Each search is appended to memory/search-log-YYYY-MM-DD.json.
 * curator.js reads that log and passes it to the curator model so it can
 * increment `reinforced` on retrieved entries during Step 2.
 */

import { appendFileSync } from "node:fs";
import { join }           from "node:path";
import { spawnSync }      from "node:child_process";

const HOME       = homedir();
const WORKSPACE  = process.env.OPENBRAIN_WORKSPACE || join(HOME, ".openclaw/workspace");
const MEMSEARCH  = join(HOME, ".memsearch-venv/bin/memsearch");
const TODAY      = new Date().toISOString().slice(0, 10);
const SEARCH_LOG = join(WORKSPACE, `memory/search-log-${TODAY}.json`);

const args   = process.argv.slice(2);
const result = spawnSync(MEMSEARCH, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });

if (args[0] === "search" && args[1]) {
  const titles = (result.stdout || "")
    .match(/^## .+$/gm)
    ?.slice(0, 5) ?? [];

  const entry = JSON.stringify({
    ts:         new Date().toISOString(),
    query:      args[1],
    top_titles: titles,
  }) + "\n";

  try { appendFileSync(SEARCH_LOG, entry); } catch { /* best-effort */ }
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 0);
