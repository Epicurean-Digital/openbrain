#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  formatTranscript,
  ingestMessages,
  recallForSource,
} from "../index.js";
import { parseCodexSession } from "./shared/codex-session.js";

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || "/home/cizambra", ".codex");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function usage() {
  console.log(`Codex adapter for OpenBrain

Usage:
  node scripts/codex-adapter.js recall --workspace <workspace> --query "<text>" [--json]
  node scripts/codex-adapter.js extract-session [--session-file <path> | --latest] [--json]
  node scripts/codex-adapter.js ingest-session --workspace <workspace> [--session-file <path> | --latest] [--json]
`);
}

function findSessionFiles(root) {
  const sessionsRoot = join(root, "sessions");
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  walk(sessionsRoot);
  return files;
}

function latestSessionFile(codexHome = DEFAULT_CODEX_HOME) {
  const files = findSessionFiles(codexHome);
  if (!files.length) throw new Error(`No Codex session files found under ${join(codexHome, "sessions")}`);
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}

function resolveSessionFile(args) {
  if (args["session-file"]) return resolve(args["session-file"]);
  if (args.latest || !args["session-file"]) return latestSessionFile(args["codex-home"] || DEFAULT_CODEX_HOME);
  throw new Error("Provide --session-file or --latest");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help) {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (command === "recall") {
    const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE;
    const query = args.query || "";
    if (!workspace || !query) throw new Error("recall requires --workspace and --query");
    const source = {
      platform: "codex",
      agent: "codex-tui",
      sessionId: args["session-id"] || "",
    };
    const result = recallForSource(workspace, query, source, {
      stableContextEnabled: true,
      activeMemoryEnabled: true,
      prostheticMemoryEnabled: true,
      totalMaxChars: Number(args["max-chars"] || 1800) || 1800,
      hotCacheMaxChars: 450,
      stableContextMaxChars: 450,
      handoffMaxChars: 500,
      sessionMaxChars: 600,
      mindMaxChars: 700,
      driftMaxChars: 400,
      compensationMaxChars: 400,
      memsearchEnabled: false,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(result.context || "");
    return;
  }

  if (command === "extract-session") {
    const sessionFile = resolveSessionFile(args);
    const parsed = parseCodexSession(sessionFile);
    if (args.json) {
      console.log(JSON.stringify(parsed, null, 2));
      return;
    }
    process.stdout.write(`${formatTranscript(parsed.messages)}\n`);
    return;
  }

  if (command === "ingest-session") {
    const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE;
    if (!workspace) throw new Error("ingest-session requires --workspace");
    const sessionFile = resolveSessionFile(args);
    const parsed = parseCodexSession(sessionFile);
    const source = {
      platform: "codex",
      agent: "codex-tui",
      sessionId: parsed.session_id,
    };
    const result = ingestMessages(workspace, parsed.session_id, parsed.messages, source);
    const output = {
      session_file: sessionFile,
      session_id: parsed.session_id,
      message_count: parsed.messages.length,
      ...result,
    };
    if (args.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`Ingested Codex session ${parsed.session_id} (${parsed.messages.length} messages)`);
    if (result.candidateFile) console.log(result.candidateFile);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[openbrain-codex] ${error.message}`);
  process.exit(1);
});
