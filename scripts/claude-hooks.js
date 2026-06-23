#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestMessages, recallForSource } from "../index.js";
import { parseClaudeSession } from "./shared/claude-session.js";

const DEFAULT_WORKSPACE = process.env.OPENBRAIN_WORKSPACE || "/home/cizambra/.openclaw/workspace";
const DEFAULT_CLAUDE_HOME = process.env.CLAUDE_HOME || join(process.env.HOME || "/home/cizambra", ".claude");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PRIVATE_RUNTIME_AGENT = "claude-code";

function readStdin() {
  return new Promise((resolveStdin) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolveStdin(data));
    process.stdin.on("error", () => resolveStdin(""));
  });
}

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

function parseJson(text, fallback = {}) {
  if (!text || !String(text).trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function extractSessionId(payload = {}) {
  return (
    payload.session_id ||
    payload.sessionId ||
    payload.conversation_id ||
    payload.conversationId ||
    payload.transcript_id ||
    payload.transcriptId ||
    process.env.CLAUDE_SESSION_ID ||
    ""
  );
}

function extractCwd(payload = {}) {
  return (
    payload.cwd ||
    payload.working_directory ||
    payload.workingDirectory ||
    payload.workspace?.current_dir ||
    process.cwd()
  );
}

function extractPromptText(payload = {}) {
  const direct = [
    payload.prompt,
    payload.userPrompt,
    payload.user_prompt,
    payload.text,
    payload.input,
    payload.message,
    payload.query,
  ];

  const textParts = [];
  const seen = new WeakSet();

  function walk(node, keyHint = "") {
    if (!node) return;
    if (typeof node === "string") {
      if (["text", "prompt", "message", "query", "content", "input", "user_prompt", "userPrompt"].includes(keyHint)) {
        textParts.push(node);
      }
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint);
      return;
    }

    if (node.type === "text" && typeof node.text === "string") textParts.push(node.text);

    for (const [key, value] of Object.entries(node)) {
      walk(value, key);
    }
  }

  walk(payload);
  return uniqueStrings([...direct, ...textParts]).join("\n").trim();
}

function extractTranscriptPath(payload = {}, claudeHome = DEFAULT_CLAUDE_HOME) {
  const value = payload.transcript_path || payload.transcriptPath || payload.session_path || payload.sessionPath || "";
  if (value) return resolve(value);

  const sessionId = extractSessionId(payload);
  if (sessionId) {
    const direct = join(claudeHome, "projects", `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }

  return "";
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function claudeStateDir(workspace) {
  return join(workspace, "memory", "private", "claude", PRIVATE_RUNTIME_AGENT);
}

function legacyClaudeStateDir(workspace) {
  return join(workspace, "memory", "hosts", "claude");
}

function hookStatePath(workspace) {
  return join(claudeStateDir(workspace), "hook-state.json");
}

function legacyHookStatePath(workspace) {
  return join(legacyClaudeStateDir(workspace), "hook-state.json");
}

function readHookState(workspace) {
  const file = existsSync(hookStatePath(workspace))
    ? hookStatePath(workspace)
    : legacyHookStatePath(workspace);
  if (!existsSync(file)) return {};
  return parseJson(readFileSync(file, "utf8"), {});
}

function writeHookState(workspace, state) {
  const dir = claudeStateDir(workspace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(hookStatePath(workspace), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function ingestTranscript(workspace, transcriptPath, sessionId, options = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { skipped: "missing-transcript-path" };

  const mtimeMs = statSync(transcriptPath).mtimeMs;
  const state = readHookState(workspace);
  const key = sessionId || transcriptPath;
  const previous = state[key];
  if (!options.force && previous?.transcriptPath === transcriptPath && previous?.mtimeMs === mtimeMs) {
    return { skipped: "unchanged-transcript", transcriptPath, mtimeMs };
  }

  const parsed = parseClaudeSession(transcriptPath);
  const result = ingestMessages(workspace, parsed.session_id, parsed.messages, {
    platform: "claude",
    agent: PRIVATE_RUNTIME_AGENT,
    sessionId: parsed.session_id,
  });

  state[key] = {
    transcriptPath,
    sessionId: parsed.session_id,
    mtimeMs,
    ingestedAt: new Date().toISOString(),
  };
  writeHookState(workspace, state);

  return {
    transcriptPath,
    sessionId: parsed.session_id,
    mtimeMs,
    ...result,
  };
}

function recallContext(workspace, query, sessionId, totalMaxChars) {
  return recallForSource(workspace, query, {
    platform: "claude",
    agent: PRIVATE_RUNTIME_AGENT,
    sessionId,
  }, {
    stableContextEnabled: true,
    activeMemoryEnabled: true,
    prostheticMemoryEnabled: true,
    totalMaxChars,
    hotCacheMaxChars: 450,
    stableContextMaxChars: 450,
    handoffMaxChars: 550,
    sessionMaxChars: 700,
    mindMaxChars: 850,
    driftMaxChars: 450,
    compensationMaxChars: 450,
    memsearchEnabled: false,
  });
}

async function runSessionStart(args) {
  const payload = parseJson(await readStdin(), {});
  const workspace = args.workspace || DEFAULT_WORKSPACE;
  const sessionId = extractSessionId(payload);
  const cwd = extractCwd(payload);
  const query = `project memory and working context for ${cwd}`;
  const result = recallContext(workspace, query, sessionId, Number(args["max-chars"] || 1500) || 1500);
  const context = (result?.context || "").trim();
  if (!context) return;

  outputJson({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

async function runUserPromptSubmit(args) {
  const payload = parseJson(await readStdin(), {});
  const workspace = args.workspace || DEFAULT_WORKSPACE;
  const sessionId = extractSessionId(payload);
  const cwd = extractCwd(payload);
  const promptText = extractPromptText(payload);
  const query = promptText || `project memory and working context for ${cwd}`;
  const result = recallContext(workspace, query, sessionId, Number(args["max-chars"] || 2100) || 2100);
  const context = (result?.context || "").trim();
  if (!context) return;

  outputJson({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}

async function runPostToolBatch(args) {
  const payload = parseJson(await readStdin(), {});
  const workspace = args.workspace || DEFAULT_WORKSPACE;
  const claudeHome = args["claude-home"] || DEFAULT_CLAUDE_HOME;
  const sessionId = extractSessionId(payload);
  const transcriptPath = extractTranscriptPath(payload, claudeHome);

  try {
    ingestTranscript(workspace, transcriptPath, sessionId, { force: false });
  } catch (error) {
    console.error(`[openbrain-claude] failed to ingest PostToolBatch transcript: ${error.message}`);
  }
}

async function runStop(args) {
  const payload = parseJson(await readStdin(), {});
  const workspace = args.workspace || DEFAULT_WORKSPACE;
  const claudeHome = args["claude-home"] || DEFAULT_CLAUDE_HOME;
  const sessionId = extractSessionId(payload);
  const transcriptPath = extractTranscriptPath(payload, claudeHome);

  try {
    ingestTranscript(workspace, transcriptPath, sessionId, { force: true });
  } catch (error) {
    console.error(`[openbrain-claude] failed to ingest Claude transcript: ${error.message}`);
    return;
  }

  if (args["no-curate"]) return;

  try {
    const curator = spawn("node", [join(PROJECT_ROOT, "scripts", "curator.js"), "--candidates"], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OPENBRAIN_WORKSPACE: workspace,
      },
    });
    curator.unref();
  } catch (error) {
    console.error(`[openbrain-claude] failed to start curator: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === "sessionstart") {
    await runSessionStart(args);
    return;
  }

  if (command === "userpromptsubmit") {
    await runUserPromptSubmit(args);
    return;
  }

  if (command === "posttoolbatch") {
    await runPostToolBatch(args);
    return;
  }

  if (command === "stop") {
    await runStop(args);
    return;
  }

  console.error("Usage: node scripts/claude-hooks.js <sessionstart|userpromptsubmit|posttoolbatch|stop> [--workspace <path>] [--claude-home <path>]");
  process.exit(1);
}

main().catch((error) => {
  console.error(`[openbrain-claude] ${error.message}`);
  process.exit(1);
});
