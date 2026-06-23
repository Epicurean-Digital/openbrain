#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { recallForSource } from "../index.js";
import { parseCodexSession } from "./shared/codex-session.js";
import { ingestMessages } from "../index.js";

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex");
const DEFAULT_WORKSPACE = process.env.OPENBRAIN_WORKSPACE || join(process.env.HOME || homedir(), ".openclaw/workspace");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      args.afterDash = argv.slice(i + 1);
      break;
    }
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
  console.log(`Hard-ambient Codex launcher for OpenBrain

Usage:
  node scripts/codex-with-openbrain.js --prompt "Fix the routing bug"
  node scripts/codex-with-openbrain.js --resume-last --prompt "Continue the refactor"
  node scripts/codex-with-openbrain.js --query "current project context" --no-curate

Options:
  --workspace <path>     OpenBrain workspace (private runtime memory + explicit shared artifacts)
  --codex-home <path>    Codex home directory (default: ~/.codex)
  --prompt <text>        User prompt to start Codex with
  --query <text>         Query used for memory recall; defaults to --prompt
  --resume-last          Launch via \`codex resume --last\`
  --no-curate            Skip running curator.js --candidates after ingest
  --max-chars <n>        Ambient memory character budget (default 2200)
  --                    Remaining args after -- are passed through to Codex
`);
}

function findSessionFiles(root) {
  const sessionsRoot = join(root, "sessions");
  if (!existsSync(sessionsRoot)) return [];
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

function latestSessionAfter(codexHome, startMs) {
  const files = findSessionFiles(codexHome)
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .filter((entry) => entry.mtimeMs >= startMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.file || null;
}

function buildAmbientPrompt({ prompt, query, retrieval, cwd }) {
  const context = (retrieval?.context || "").trim();
  const userPrompt = String(prompt || "").trim();
  const effectiveQuery = String(query || userPrompt || `current context for work in ${cwd}`).trim();

  if (!context) {
    if (userPrompt) return userPrompt;
    return `You are starting work in ${cwd}. No prior OpenBrain context was retrieved. Wait for my next message and use normal judgment.`;
  }

  const memoryBlock = [
    "OpenBrain ambient memory preload.",
    "Treat this as background context from prior sessions.",
    "Use it when relevant, but do not quote or restate it unless it materially helps the user.",
    "",
    context,
    "",
  ].join("\n");

  if (userPrompt) {
    return [
      memoryBlock,
      "Current user request:",
      userPrompt,
    ].join("\n");
  }

  return [
    memoryBlock,
    `Session intent: ${effectiveQuery}`,
    "Absorb this context and wait for the next user message.",
  ].join("\n");
}

function runCodex(args, prompt) {
  return new Promise((resolveExit) => {
    const baseArgs = [];
    if (args["resume-last"]) {
      baseArgs.push("resume", "--last");
    }
    if (Array.isArray(args.afterDash) && args.afterDash.length > 0) {
      baseArgs.push(...args.afterDash);
    }
    if (prompt) baseArgs.push(prompt);

    const child = spawn("codex", baseArgs, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code, signal) => resolveExit({ code: code ?? 0, signal: signal || null }));
    child.on("error", (error) => {
      console.error(`[openbrain-codex] failed to launch codex: ${error.message}`);
      resolveExit({ code: 1, signal: null });
    });
  });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const workspace = resolve(args.workspace || DEFAULT_WORKSPACE);
  const codexHome = resolve(args["codex-home"] || DEFAULT_CODEX_HOME);
  const cwd = process.cwd();
  const prompt = args.prompt || args._.join(" ").trim();
  const query = (args.query || prompt || `current context, constraints, and open loops for work in ${cwd}`).trim();

  const retrieval = recallForSource(workspace, query, {
    platform: "codex",
    agent: "codex-tui",
    sessionId: "",
  }, {
    stableContextEnabled: true,
    activeMemoryEnabled: true,
    prostheticMemoryEnabled: true,
    totalMaxChars: Number(args["max-chars"] || 1500) || 1500,
    hotCacheMaxChars: 450,
    stableContextMaxChars: 400,
    handoffMaxChars: 450,
    sessionMaxChars: 500,
    mindMaxChars: 650,
    driftMaxChars: 350,
    compensationMaxChars: 350,
    memsearchEnabled: false,
  });

  const ambientPrompt = buildAmbientPrompt({
    prompt,
    query,
    retrieval,
    cwd,
  });

  const startMs = Date.now();
  console.error(`[openbrain-codex] launching Codex with private-first ambient memory (${(retrieval?.layersUsed || []).join(", ") || "no memory hit"})`);
  const exit = await runCodex(args, ambientPrompt);

  const latestSession = latestSessionAfter(codexHome, startMs - 2000);
  if (!latestSession) {
    console.error("[openbrain-codex] no new Codex session file found after exit; skipping ingest");
    process.exit(exit.code);
    return;
  }

  const parsed = parseCodexSession(latestSession);
  const result = ingestMessages(workspace, parsed.session_id, parsed.messages, {
    platform: "codex",
    agent: "codex-tui",
    sessionId: parsed.session_id,
  });

  console.error(`[openbrain-codex] ingested session ${parsed.session_id} (${parsed.messages.length} messages, ${result.candidateCount} candidates)`);

  if (!args["no-curate"]) {
    console.error("[openbrain-codex] running candidate curation");
    const code = await runCurator(workspace);
    if (code !== 0) {
      console.error(`[openbrain-codex] curator exited with ${code}`);
    }
  }

  process.exit(exit.code);
}

main().catch((error) => {
  console.error(`[openbrain-codex] ${error.message}`);
  process.exit(1);
});
