#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

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

function loadOpenBrainConfig() {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return {};
  const config = safeJsonParse(readFileSync(configPath, "utf8"), {});
  return config?.plugins?.entries?.openbrain?.config || {};
}

function requireArg(args, key) {
  const value = args[key];
  if (!value) {
    console.error(`Missing required argument: --${key}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node scripts/log-eval.js --eval-id EVAL-SF-001 --kind stable_fact_recall --status pass [options]

Required:
  --eval-id        Eval identifier
  --kind           Eval kind
  --status         pass | soft_fail | fail

Optional:
  --model          Model used
  --session-id     Session identifier
  --turns          Number of turns taken
  --notes          Short notes
  --workspace      Override OpenBrain workspace path
  --webhook        Override telemetry webhook
`);
    return;
  }

  const config = loadOpenBrainConfig();
  const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE || config.workspace || join(homedir(), ".openclaw", "workspace");
  const telemetryEnabled = config.telemetry?.enabled !== false;
  const telemetryWriteJsonl = config.telemetry?.writeJsonl !== false;
  const telemetryWebhook = args.webhook || process.env.OPENBRAIN_TELEMETRY_WEBHOOK || config.telemetry?.webhook || null;

  if (!telemetryEnabled) {
    console.error("OpenBrain telemetry is disabled in config.");
    process.exit(1);
  }

  const event = {
    ts: new Date().toISOString(),
    source: "openbrain",
    event_type: "eval.result",
    payload: {
      eval_id: requireArg(args, "eval-id"),
      kind: requireArg(args, "kind"),
      status: requireArg(args, "status"),
      model: args.model || null,
      session_id: args["session-id"] || null,
      turns: args.turns ? Number(args.turns) || null : null,
      notes: args.notes || "",
    },
  };

  const telemetryDir = join(workspace, "memory", "telemetry");
  mkdirSync(telemetryDir, { recursive: true });

  if (telemetryWriteJsonl) {
    appendFileSync(join(telemetryDir, `${today()}.jsonl`), JSON.stringify(event) + "\n");
  }

  if (telemetryWebhook) {
    try {
      const response = await fetch(telemetryWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        console.error(`Telemetry webhook failed: ${response.status} ${response.statusText}`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Telemetry webhook failed: ${error.message}`);
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ ok: true, event_type: "eval.result", eval_id: event.payload.eval_id }));
}

main().catch(error => {
  console.error(error?.message || String(error));
  process.exit(1);
});
