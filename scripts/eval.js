#!/usr/bin/env node
/**
 * eval.js
 * Lightweight self-evaluation pass before delivering a significant response.
 * Uses a fast model to check for drift, incompleteness, and obvious errors.
 *
 * Usage:
 *   echo "question|||response" | node eval.js
 *   node eval.js --question "..." --response "..."
 *   node eval.js --question "..." --response-file /tmp/draft.txt
 *
 * Exit codes:
 *   0 — PASS
 *   1 — FLAG or REVISE (issue found)
 *   2 — error (API failure, bad input)
 *
 * Config: reads model/provider from ../config.json (written by plugin on load)
 */

import { readFileSync, existsSync } from "node:fs";
import { join }                     from "node:path";
import { createInterface }          from "node:readline";

function readPluginConfig() {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "../config.json"), "utf8"));
  } catch { return {}; }
}

function readApiKey(provider) {
  if (provider === "deepseek") {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    try {
      const cfg = JSON.parse(readFileSync(
        join(homedir(), ".openclaw/openclaw.json"), "utf8"
      ));
      return cfg?.models?.providers?.deepseek?.apiKey || null;
    } catch { return null; }
  }
  // anthropic (default)
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const profiles = JSON.parse(readFileSync(
      join(homedir(), ".openclaw/agents/main/agent/auth-profiles.json"),
      "utf8"
    ));
    return profiles?.profiles?.["anthropic:default"]?.key || null;
  } catch { return null; }
}

const pluginConfig = readPluginConfig();
const PROVIDER = pluginConfig.eval_provider || pluginConfig.provider || "anthropic";
const MODEL    = pluginConfig.eval_model    || pluginConfig.model    || "claude-haiku-4-5-20251001";
const API_KEY  = readApiKey(PROVIDER);

const EVAL_PROMPT = `You are a fast quality checker. You receive a QUESTION and a DRAFT RESPONSE from a memory-aware AI assistant. The assistant has access to persistent memory and prior context that is NOT visible to you — so references to projects, people, tasks, or decisions not mentioned in the question are expected and normal, not alignment failures.

Evaluate on exactly three axes:
1. ALIGNMENT — does the response address what was asked? Only flag if the response is clearly off-topic or substitutes a different question entirely.
2. COMPLETENESS — is anything structurally missing that makes the response unusable?
3. ERRORS — any obvious factual, logical, or technical mistake visible from the response itself?

Output EXACTLY one of:

PASS
(one sentence confirming it looks good)

FLAG: <axis> — <one sentence describing the issue>

REVISE: <axis> — <one sentence describing the significant problem>

Use PASS when all three axes are fine. Default to PASS when unsure — false positives are more harmful than missed flags.
Use FLAG for a minor issue that doesn't break the response.
Use REVISE only when the response fundamentally misses the question or contains a clear error.

No preamble. No explanation beyond the format above.`;

async function callEvalModel(question, response) {
  const userMessage = `QUESTION:\n${question}\n\nDRAFT RESPONSE:\n${response}`;

  if (PROVIDER === "deepseek") {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        messages: [
          { role: "system", content: EVAL_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
  }

  // anthropic (default)
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 150,
      system: EVAL_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

async function main() {
  if (!API_KEY) {
    console.error("[eval] API key not set");
    process.exit(2);
  }

  const args = process.argv.slice(2);
  let question = "";
  let response = "";

  const qIdx  = args.indexOf("--question");
  const rIdx  = args.indexOf("--response");
  const rfIdx = args.indexOf("--response-file");

  if (qIdx  !== -1) question = args[qIdx + 1]  || "";
  if (rIdx  !== -1) response = args[rIdx + 1]  || "";
  if (rfIdx !== -1) {
    const path = args[rfIdx + 1];
    if (path && existsSync(path)) response = readFileSync(path, "utf8");
  }

  if (!question && !response && !process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    const lines = [];
    for await (const line of rl) lines.push(line);
    const raw    = lines.join("\n");
    const sepIdx = raw.indexOf("|||");
    if (sepIdx !== -1) {
      question = raw.slice(0, sepIdx).trim();
      response = raw.slice(sepIdx + 3).trim();
    } else {
      response = raw.trim();
      question = "(no question provided — evaluate response for general quality)";
    }
  }

  if (!response) {
    console.error("[eval] no response to evaluate — pipe in or use --response");
    process.exit(2);
  }

  if (!question) {
    question = "(no question provided — evaluate response for general quality)";
  }

  let verdict;
  try {
    verdict = await callEvalModel(question, response);
  } catch (e) {
    console.error("[eval] evaluation failed:", e.message);
    process.exit(2);
  }

  console.log(verdict);

  if (verdict.startsWith("FLAG") || verdict.startsWith("REVISE")) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch(e => {
  console.error("[eval] fatal:", e);
  process.exit(2);
});
