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

function parseNumberList(value = "") {
  return value.split(",").map(item => Number(item.trim())).filter(Number.isFinite);
}

function average(values = []) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node scripts/log-coherence.js --eval-id EVAL-CC-001 --overall-score 25 [options]

Required:
  --eval-id         Eval identifier
  --overall-score   Overall coherence score (0-100)

Optional:
  --model           Model used
  --session-id      Session identifier
  --notes           Short notes
  --direction       Comma-separated 0-5 scores
  --constraint      Comma-separated 0-5 scores
  --detection       Comma-separated 0-5 scores
  --regulation      Comma-separated 0-5 scores
  --return-score    Comma-separated 0-5 scores
  --reintegration   Comma-separated 0-5 scores
  --action-truth    Comma-separated 0-5 scores
  --hard-fails      Comma-separated hard fail keys
  --diagnostics     Comma-separated diagnostic branch ids
  --workspace       Override OpenBrain workspace path
  --webhook         Override telemetry webhook
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

  const hardFailKeys = (args["hard-fails"] || "").split(",").map(item => item.trim()).filter(Boolean);
  const diagnosticsTriggered = (args.diagnostics || "").split(",").map(item => item.trim()).filter(Boolean);

  const event = {
    ts: new Date().toISOString(),
    source: "openbrain",
    event_type: "coherence.rated",
    payload: {
      eval_id: requireArg(args, "eval-id"),
      model: args.model || null,
      session_id: args["session-id"] || null,
      scores: {
        direction: average(parseNumberList(args.direction || "")),
        constraint_integrity: average(parseNumberList(args.constraint || "")),
        detection: average(parseNumberList(args.detection || "")),
        regulation: average(parseNumberList(args.regulation || "")),
        return: average(parseNumberList(args["return-score"] || "")),
        reintegration: average(parseNumberList(args.reintegration || "")),
        action_truth: average(parseNumberList(args["action-truth"] || "")),
      },
      hard_fails: {
        constraint_violated: hardFailKeys.includes("constraint_violated"),
        stable_fact_ignored: hardFailKeys.includes("stable_fact_ignored"),
        superseded_procedure_reused: hardFailKeys.includes("superseded_procedure_reused"),
        unverified_side_effect_claim: hardFailKeys.includes("unverified_side_effect_claim"),
        environment_contradiction: hardFailKeys.includes("environment_contradiction"),
        bad_artifact_repeated: hardFailKeys.includes("bad_artifact_repeated"),
        high_trust_memory_ignored: hardFailKeys.includes("high_trust_memory_ignored"),
      },
      overall_score: Number(requireArg(args, "overall-score")),
      diagnostics_triggered: diagnosticsTriggered,
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

  console.log(JSON.stringify({ ok: true, event_type: "coherence.rated", eval_id: event.payload.eval_id }));
}

main().catch(error => {
  console.error(error?.message || String(error));
  process.exit(1);
});
