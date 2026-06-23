#!/usr/bin/env node
/**
 * coherence-check.js
 * Selective post-response check focused on frame coherence rather than generic quality.
 *
 * Usage:
 *   echo '{"question":"...","response":"...","activeContext":"..."}' | node scripts/coherence-check.js
 *
 * Exit codes:
 *   0 — PASS
 *   1 — FLAG or REVISE
 *   2 — error
 */

import { readFileSync }    from "node:fs";
import { join }            from "node:path";
import { createInterface } from "node:readline";
import { homedir }         from "node:os";

function readPluginConfig() {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "../config.json"), "utf8"));
  } catch { return {}; }
}

function readApiKey(provider) {
  if (provider === "deepseek") {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".openclaw/openclaw.json"), "utf8"));
      return cfg?.models?.providers?.deepseek?.apiKey || null;
    } catch { return null; }
  }

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
const PROVIDER = pluginConfig.coherence_provider || pluginConfig.eval_provider || "anthropic";
const MODEL = pluginConfig.coherence_model || pluginConfig.eval_model || "claude-haiku-4-5-20251001";
const API_KEY = readApiKey(PROVIDER);

const COHERENCE_PROMPT = `You are a fast coherence checker for a cognitive assistant. You receive:
- QUESTION
- DRAFT RESPONSE
- ACTIVE CONTEXT

Check only these axes:
1. OBJECTIVE FIT — does the response serve the apparent task?
2. CONSTRAINT FIT — does it conflict with the active context or visible constraints?
3. TASK MUTATION — did the response quietly change the problem being solved?
4. CONTRADICTION RISK — does it appear to contradict prior active context?

Output EXACTLY one of:

PASS
(one sentence confirming coherence)

FLAG: <axis> — <one sentence describing a limited coherence risk>

REVISE: <axis> — <one sentence describing a significant coherence failure>

Use PASS when unsure. Do not moralize. Do not critique style unless it causes one of the four failures above.`;

async function callModel(question, response, activeContext) {
  const userMessage = `QUESTION:\n${question}\n\nACTIVE CONTEXT:\n${activeContext || "(none)"}\n\nDRAFT RESPONSE:\n${response}`;

  if (PROVIDER === "deepseek") {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        messages: [
          { role: "system", content: COHERENCE_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
  }

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
      system: COHERENCE_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

async function main() {
  if (!API_KEY) {
    console.error("[coherence-check] API key not set");
    process.exit(2);
  }

  let raw = "";
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    const lines = [];
    for await (const line of rl) lines.push(line);
    raw = lines.join("\n").trim();
  }

  if (!raw) {
    console.error("[coherence-check] no payload provided");
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error("[coherence-check] invalid JSON payload:", e.message);
    process.exit(2);
  }

  const question = payload.question || "(no question provided)";
  const response = payload.response || "";
  const activeContext = payload.activeContext || "";
  if (!response) {
    console.error("[coherence-check] no response provided");
    process.exit(2);
  }

  let verdict;
  try {
    verdict = await callModel(question, response, activeContext);
  } catch (e) {
    console.error("[coherence-check] failed:", e.message);
    process.exit(2);
  }

  console.log(verdict);
  if (verdict.startsWith("FLAG") || verdict.startsWith("REVISE")) process.exit(1);
  process.exit(0);
}

main().catch(e => {
  console.error("[coherence-check] fatal:", e);
  process.exit(2);
});
