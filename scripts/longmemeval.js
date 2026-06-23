#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function info(message) {
  console.error(`[longmemeval] ${message}`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function safeSlug(text, fallback = "item") {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || fallback;
}

function loadDataset(path) {
  if (!existsSync(path)) die(`Dataset not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.examples)) return raw.examples;
  die(`Unsupported dataset shape in ${path}`);
}

function stringifyText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(stringifyText).filter(Boolean).join("\n").trim();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (Array.isArray(value.content)) return stringifyText(value.content);
    if (typeof value.message === "string") return value.message.trim();
  }
  return String(value).trim();
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase();
  if (["human", "user"].includes(value)) return "Human";
  if (["assistant", "ai", "agent"].includes(value)) return "Assistant";
  return null;
}

function extractTurns(session) {
  const possibleArrays = [
    session?.session,
    session?.messages,
    session?.conversation,
    session?.dialog,
    session?.turns,
  ].filter(Array.isArray);

  const turns = [];
  for (const arr of possibleArrays) {
    for (const item of arr) {
      if (Array.isArray(item) && item.length >= 2) {
        const role = normalizeRole(item[0]);
        const text = stringifyText(item[1]);
        if (role && text) turns.push({ role, text });
        continue;
      }
      if (typeof item === "object" && item) {
        const role = normalizeRole(item.role || item.speaker || item.from);
        const text = stringifyText(item.content || item.text || item.message || item.value);
        if (role && text) turns.push({ role, text });
      }
    }
    if (turns.length) return turns;
  }

  if (Array.isArray(session)) return extractTurns({ session });
  return [];
}

function sessionToTranscript(session, index) {
  const turns = extractTurns(session);
  if (!turns.length) {
    die(`Unable to parse turns from haystack session ${index + 1}`);
  }
  return turns.map(turn => `${turn.role}: ${turn.text}`).join("\n\n");
}

function getItemId(item, index) {
  return item.id || item.question_id || item.sample_id || item.uid || `item-${index + 1}`;
}

function getQuestion(item) {
  return stringifyText(item.question || item.query || item.prompt || item.user_query);
}

function getExpected(item) {
  return stringifyText(item.answer || item.expected_answer || item.gold || item.target);
}

function getHaystackSessions(item) {
  const sessions = item.haystack_sessions || item.sessions || item.history || item.context_sessions;
  if (!Array.isArray(sessions) || !sessions.length) {
    die(`Item ${getItemId(item, 0)} does not contain haystack sessions`);
  }
  return sessions;
}

function runCurator({ workspace, transcript }) {
  const script = "/home/cizambra/workspace/openbrain/scripts/curator.js";
  const env = {
    ...process.env,
    OPENBRAIN_WORKSPACE: workspace,
  };
  const result = spawnSync("node", [script], {
    input: transcript,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    die(`curator.js failed for workspace ${workspace}\n${output}`);
  }
}

function normalized(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function scoreAnswer(expected, actual) {
  const e = normalized(expected);
  const a = normalized(actual);
  if (!e || !a) return "fail";
  if (a === e) return "pass";
  if (a.includes(e) || e.includes(a)) return "soft_fail";
  return "fail";
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function usage() {
  console.log(`Usage:
  node scripts/longmemeval.js --dataset /path/to/longmemeval_s_cleaned.json --index 0

Options:
  --dataset      Path to LongMemEval json file (required)
  --index        Zero-based item index
  --id           Item id instead of --index
  --workspace    Workspace root for prepared items
  --clean        Remove prepared workspace before ingest
  --answer       Grade a provided answer after preparation
  --log          Also write OpenBrain eval telemetry after grading
  --help         Show this help

What it does:
  1. Creates an isolated OpenBrain workspace for one benchmark item
  2. Replays haystack sessions into curator.js in chronological order
  3. Writes a packet with the final benchmark question and expected answer
  4. Optionally grades a provided answer with exact/contains matching
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!args.dataset) die("Missing required argument: --dataset");
  const datasetPath = resolve(args.dataset);
  const items = loadDataset(datasetPath);

  let itemIndex = -1;
  if (args.id) {
    itemIndex = items.findIndex((item, idx) => String(getItemId(item, idx)) === String(args.id));
  } else if (args.index != null) {
    itemIndex = Number(args.index);
  }
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length) {
    die(`Could not resolve benchmark item. Use --index 0..${items.length - 1} or --id.`);
  }

  const item = items[itemIndex];
  const itemId = String(getItemId(item, itemIndex));
  const question = getQuestion(item);
  const expectedAnswer = getExpected(item);
  const sessions = getHaystackSessions(item);
  const workspaceRoot = resolve(args.workspace || join(homedir(), ".openclaw", "longmemeval"));
  const workspace = join(workspaceRoot, safeSlug(itemId, `item-${itemIndex + 1}`));

  if (args.clean && existsSync(workspace)) {
    info(`cleaning workspace ${workspace}`);
    rmSync(workspace, { recursive: true, force: true });
  }
  ensureDir(workspace);
  ensureDir(join(workspace, "memory"));

  info(`preparing ${itemId} from ${datasetPath}`);
  info(`workspace: ${workspace}`);
  info(`haystack sessions: ${sessions.length}`);

  sessions.forEach((session, idx) => {
    info(`ingesting session ${idx + 1}/${sessions.length}`);
    const transcript = sessionToTranscript(session, idx);
    writeFileSync(join(workspace, `session-${String(idx + 1).padStart(2, "0")}.txt`), transcript, "utf8");
    runCurator({ workspace, transcript });
  });

  const packet = {
    benchmark: "LongMemEval",
    dataset: datasetPath,
    item_id: itemId,
    item_index: itemIndex,
    workspace,
    haystack_sessions: sessions.length,
    question,
    expected_answer: expectedAnswer,
    notes: "Ask the question using OpenClaw with OpenBrain enabled and OPENBRAIN_WORKSPACE set to this workspace.",
  };
  writeJson(join(workspace, "benchmark-packet.json"), packet);
  info(`wrote benchmark packet to ${join(workspace, "benchmark-packet.json")}`);

  let grade = null;
  if (args.answer) {
    info(`grading provided answer for ${itemId}`);
    grade = scoreAnswer(expectedAnswer, args.answer);
    packet.provided_answer = args.answer;
    packet.grade = grade;
    writeJson(join(workspace, "benchmark-packet.json"), packet);

    if (args.log) {
      const logger = "/home/cizambra/workspace/openbrain/scripts/log-eval.js";
      const result = spawnSync("node", [
        logger,
        "--workspace", workspace,
        "--eval-id", `LME-${safeSlug(itemId, itemIndex.toString())}`,
        "--kind", safeSlug(dirname(datasetPath).split("/").pop() || "longmemeval") || "longmemeval",
        "--status", grade,
        "--session-id", itemId,
        "--notes", `LongMemEval graded from provided answer for ${itemId}`,
      ], {
        env: { ...process.env, OPENBRAIN_WORKSPACE: workspace },
        encoding: "utf8",
      });
      if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        die(`log-eval.js failed\n${output}`);
      }
      info(`logged eval for ${itemId} with status ${grade}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    benchmark: "LongMemEval",
    dataset: datasetPath,
    item_id: itemId,
    item_index: itemIndex,
    workspace,
    haystack_sessions: sessions.length,
    question,
    expected_answer: expectedAnswer,
    grade,
  }, null, 2));
}

main();
