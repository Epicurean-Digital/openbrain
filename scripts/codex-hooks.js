#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestMessages, recallForSource } from "../index.js";
import { parseCodexSession } from "./shared/codex-session.js";

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || "/home/cizambra", ".codex");
const DEFAULT_WORKSPACE = process.env.OPENBRAIN_WORKSPACE || "/home/cizambra/.openclaw/workspace";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PRIVATE_RUNTIME_AGENT = "codex-tui";

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

function extractPromptText(payload = {}) {
  const direct = [
    payload.prompt,
    payload.userPrompt,
    payload.user_prompt,
    payload.text,
    payload.input,
    payload.message,
    payload.query,
    payload.additionalContext,
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
    if (node.type === "input_text" && typeof node.text === "string") textParts.push(node.text);
    if (node.type === "message" && typeof node.content === "string") textParts.push(node.content);

    for (const [key, value] of Object.entries(node)) {
      walk(value, key);
    }
  }

  walk(payload);
  return uniqueStrings([...direct, ...textParts]).join("\n").trim();
}

function extractSessionId(payload = {}) {
  return (
    payload.session_id ||
    payload.sessionId ||
    payload.thread_id ||
    payload.threadId ||
    payload.conversation_id ||
    payload.conversationId ||
    process.env.CODEX_THREAD_ID ||
    ""
  );
}

function extractCwd(payload = {}) {
  return payload.cwd || payload.working_directory || payload.workingDirectory || process.cwd();
}

function findSessionFiles(codexHome) {
  const sessionsRoot = join(codexHome, "sessions");
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
  if (!files.length) return null;
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}

function sessionIdFromFile(file) {
  try {
    const raw = readFileSync(file, "utf8");
    const firstMetaLine = raw.split("\n").find((line) => line.includes("\"type\":\"session_meta\""));
    if (!firstMetaLine) return "";
    const parsed = JSON.parse(firstMetaLine);
    return parsed?.payload?.id || "";
  } catch {
    return "";
  }
}

function findSessionFileBySessionId(codexHome, sessionId) {
  if (!sessionId) return latestSessionFile(codexHome);
  const files = findSessionFiles(codexHome);
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files) {
    if (sessionIdFromFile(file) === sessionId) return file;
  }
  return files[0] || null;
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function codexStateDir(workspace) {
  return join(workspace, "memory", "private", "codex", PRIVATE_RUNTIME_AGENT);
}

function legacyCodexStateDir(workspace) {
  return join(workspace, "memory", "hosts", "codex");
}

function hookStatePath(workspace) {
  return join(codexStateDir(workspace), "hook-state.json");
}

function legacyHookStatePath(workspace) {
  return join(legacyCodexStateDir(workspace), "hook-state.json");
}

function readHookState(workspace) {
  const file = existsSync(hookStatePath(workspace))
    ? hookStatePath(workspace)
    : legacyHookStatePath(workspace);
  if (!existsSync(file)) return {};
  return parseJson(readFileSync(file, "utf8"), {});
}

function writeHookState(workspace, state) {
  const dir = codexStateDir(workspace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(hookStatePath(workspace), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function ingestLatestSession(workspace, codexHome, sessionId, options = {}) {
  const sessionFile = findSessionFileBySessionId(codexHome, sessionId);
  if (!sessionFile) return { skipped: "missing-session-file" };

  const mtimeMs = statSync(sessionFile).mtimeMs;
  const state = readHookState(workspace);
  const key = sessionId || "__latest__";
  const previous = state[key];
  if (!options.force && previous?.sessionFile === sessionFile && previous?.mtimeMs === mtimeMs) {
    return { skipped: "unchanged-session-file", sessionFile, mtimeMs };
  }

  const parsed = parseCodexSession(resolve(sessionFile));
  const result = ingestMessages(workspace, parsed.session_id, parsed.messages, {
    platform: "codex",
    agent: PRIVATE_RUNTIME_AGENT,
    sessionId: parsed.session_id,
  });

  state[key] = {
    sessionFile,
    sessionId: parsed.session_id,
    mtimeMs,
    ingestedAt: new Date().toISOString(),
  };
  writeHookState(workspace, state);

  return {
    sessionFile,
    sessionId: parsed.session_id,
    mtimeMs,
    ...result,
  };
}

async function runUserPromptSubmit(args) {
  const payload = parseJson(await readStdin(), {});
  const workspace = args.workspace || DEFAULT_WORKSPACE;
  const sessionId = extractSessionId(payload);
  const cwd = extractCwd(payload);
  const promptText = extractPromptText(payload);
  const query = promptText || `current project context for ${cwd}`;

  const result = recallForSource(workspace, query, {
    platform: "codex",
    agent: PRIVATE_RUNTIME_AGENT,
    sessionId,
  }, {
    stableContextEnabled: true,
    activeMemoryEnabled: true,
    prostheticMemoryEnabled: true,
    totalMaxChars: Number(args["max-chars"] || 2100) || 2100,
    hotCacheMaxChars: 450,
    stableContextMaxChars: 450,
    handoffMaxChars: 550,
    sessionMaxChars: 700,
    mindMaxChars: 850,
    driftMaxChars: 450,
    compensationMaxChars: 450,
    memsearchEnabled: false,
  });

  const context = (result?.context || "").trim();
  if (!context) return;

  outputJson({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}

async function runStop(args) {
  const payload = parseJson(await readStdin(), {});
  const workspace = args.workspace || DEFAULT_WORKSPACE;
  const codexHome = args["codex-home"] || DEFAULT_CODEX_HOME;
  const sessionId = extractSessionId(payload);

  try {
    ingestLatestSession(workspace, codexHome, sessionId, { force: true });
  } catch (error) {
    console.error(`[openbrain-hooks] failed to ingest Codex session: ${error.message}`);
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
    console.error(`[openbrain-hooks] failed to start curator: ${error.message}`);
  }
}

async function runPostToolUse(args) {
  const payload = parseJson(await readStdin(), {});
  const workspace = args.workspace || DEFAULT_WORKSPACE;
  const codexHome = args["codex-home"] || DEFAULT_CODEX_HOME;
  const sessionId = extractSessionId(payload);

  try {
    ingestLatestSession(workspace, codexHome, sessionId, { force: false });
  } catch (error) {
    console.error(`[openbrain-hooks] failed to ingest PostToolUse session state: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === "userpromptsubmit") {
    await runUserPromptSubmit(args);
    return;
  }

  if (command === "stop") {
    await runStop(args);
    return;
  }

  if (command === "posttooluse") {
    await runPostToolUse(args);
    return;
  }

  console.error("Usage: node scripts/codex-hooks.js <userpromptsubmit|posttooluse|stop> [--workspace <path>] [--codex-home <path>]");
  process.exit(1);
}

main().catch((error) => {
  console.error(`[openbrain-hooks] ${error.message}`);
  process.exit(1);
});
