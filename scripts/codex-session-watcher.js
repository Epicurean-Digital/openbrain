#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { ingestMessages } from "../index.js";
import { parseCodexSession } from "./shared/codex-session.js";

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex");
const DEFAULT_WORKSPACE = process.env.OPENBRAIN_WORKSPACE || join(process.env.HOME || homedir(), ".openclaw/workspace");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Codex session watcher for OpenBrain

Usage:
  node scripts/codex-session-watcher.js

Options:
  --workspace <path>          Shared OpenBrain workspace
  --codex-home <path>         Codex home directory
  --interval-seconds <n>      Poll interval (default 20)
  --curate-minutes <n>        Minimum minutes between curator runs (default 10)
  --once                      Run one scan and exit
  --no-curate                 Skip curator runs
`);
}

function findSessionFiles(root) {
  const sessionsRoot = join(root, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".jsonl")) files.push(full);
    }
  }

  walk(sessionsRoot);
  return files;
}

function runCurator(workspace) {
  return new Promise((resolveDone) => {
    const child = spawn("node", [join(import.meta.dirname, "curator.js"), "--candidates"], {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENBRAIN_WORKSPACE: workspace,
      },
    });
    child.on("exit", (code) => resolveDone(code ?? 0));
    child.on("error", () => resolveDone(1));
  });
}

async function scanOnce(state, options) {
  const files = findSessionFiles(options.codexHome)
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let changed = false;

  for (const entry of files) {
    const knownMtime = state.seen.get(entry.file) || 0;
    if (entry.mtimeMs <= knownMtime) continue;

    try {
      const parsed = parseCodexSession(entry.file);
      if (!parsed.messages.length) {
        state.seen.set(entry.file, entry.mtimeMs);
        continue;
      }

      const result = ingestMessages(options.workspace, parsed.session_id, parsed.messages, {
        platform: "codex",
        agent: "codex-tui",
        sessionId: parsed.session_id,
      });
      state.seen.set(entry.file, entry.mtimeMs);
      changed = true;
      console.error(
        `[openbrain-codex] synced ${parsed.session_id} from ${entry.file} (${parsed.messages.length} messages, ${result.candidateCount} candidates)`
      );
    } catch (error) {
      console.error(`[openbrain-codex] failed to ingest ${entry.file}: ${error.message}`);
    }
  }

  if (!changed || options.noCurate) return;

  const now = Date.now();
  if (now - state.lastCuratedAt < options.curateMs) return;

  state.lastCuratedAt = now;
  console.error("[openbrain-codex] running periodic candidate curation");
  const code = await runCurator(options.workspace);
  if (code !== 0) {
    console.error(`[openbrain-codex] curator exited with ${code}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const options = {
    workspace: args.workspace || DEFAULT_WORKSPACE,
    codexHome: args["codex-home"] || DEFAULT_CODEX_HOME,
    intervalMs: (Number(args["interval-seconds"] || 20) || 20) * 1000,
    curateMs: (Number(args["curate-minutes"] || 10) || 10) * 60 * 1000,
    noCurate: Boolean(args["no-curate"]),
  };

  const state = {
    seen: new Map(),
    lastCuratedAt: 0,
  };

  await scanOnce(state, options);
  if (args.once) return;

  console.error(
    `[openbrain-codex] watching ${join(options.codexHome, "sessions")} every ${Math.round(options.intervalMs / 1000)}s`
  );
  setInterval(() => {
    scanOnce(state, options).catch((error) => {
      console.error(`[openbrain-codex] watcher error: ${error.message}`);
    });
  }, options.intervalMs);
}

main().catch((error) => {
  console.error(`[openbrain-codex] ${error.message}`);
  process.exit(1);
});
