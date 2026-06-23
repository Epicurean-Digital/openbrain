#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { normalizeMemoryObject } from "./shared/memory-schema.js";

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

function readJsonl(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function safeSlug(text, fallback = "item") {
  const slug = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeText(text, maxChars = 140) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 16)).trimEnd()}...`;
}

function decisionSignature(decision) {
  return decision?.decision_signature
    || hashString(normalizeText(decision?.what || decision?.title || decision?.content || decision?.summary || "", 180).toLowerCase());
}

function outcomeSignature(outcome) {
  return outcome?.decision_signature
    || outcome?.outcome_signature
    || outcome?.decision_key
    || hashString(normalizeText(outcome?.summary || outcome?.title || outcome?.content || "", 180).toLowerCase());
}

function outcomeScore(outcome) {
  const nested = outcome?.outcome || {};
  if (typeof nested.success === "boolean") return nested.success ? 1 : -1;
  if (typeof outcome?.success === "boolean") return outcome.success ? 1 : -1;
  const score = Number(nested.resolution_score ?? outcome?.resolution_score);
  if (Number.isFinite(score)) return (score - 50) / 50;
  return 0;
}

function renderBeliefStatement(what) {
  const text = normalizeText(what, 90).replace(/[.]+$/, "");
  if (!text) return "Repeated choices with positive outcomes can become a belief.";
  if (/^(use|keep|choose|prefer|avoid|narrow|delay|restate|move|create|remove|add|start|finish|review|check)\b/i.test(text)) {
    return `Choosing to ${text} tends to improve outcomes.`;
  }
  return `Choosing ${text} tends to improve outcomes.`;
}

function buildBeliefs(decisions, outcomes) {
  const decisionGroups = new Map();
  for (const decision of decisions) {
    const key = decisionSignature(decision);
    if (!decisionGroups.has(key)) decisionGroups.set(key, []);
    decisionGroups.get(key).push(decision);
  }

  const outcomeGroups = new Map();
  for (const outcome of outcomes) {
    const key = outcomeSignature(outcome);
    if (!outcomeGroups.has(key)) outcomeGroups.set(key, []);
    outcomeGroups.get(key).push(outcome);
  }

  const beliefs = [];
  for (const [signature, group] of decisionGroups.entries()) {
    const matchedOutcomes = outcomeGroups.get(signature) || [];
    if (group.length < 2 || matchedOutcomes.length === 0) continue;

    const scores = matchedOutcomes.map(outcomeScore);
    const averageScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const positiveCount = scores.filter((score) => score > 0).length;
    const positiveRate = positiveCount / scores.length;
    if (averageScore <= 0 || positiveRate < 0.5) continue;

    const exemplar = group[0];
    const what = normalizeText(exemplar?.what || exemplar?.title || exemplar?.content || exemplar?.summary || "", 120);
    const sourceRefs = [...new Set([
      ...group.map((item) => item.id || item.decision_key).filter(Boolean),
      ...matchedOutcomes.map((item) => item.id || item.outcome_key).filter(Boolean),
    ])];
    const confidence = Math.min(0.95, Number((0.55 + Math.min(group.length, 5) * 0.07 + Math.max(0, averageScore) * 0.18).toFixed(2)));

    beliefs.push(normalizeMemoryObject({
      type: "belief",
      id: `belief:${signature}`,
      belief_key: `belief_${signature}`,
      decision_signature: signature,
      title: safeSlug(what || signature, "belief"),
      statement: renderBeliefStatement(what),
      confidence,
      reinforcement_count: group.length,
      trajectory: confidence >= 0.75 ? "established" : "learning",
      decay_mode: "slow",
      source_refs: sourceRefs,
      support: {
        decision_count: group.length,
        outcome_count: matchedOutcomes.length,
        positive_rate: Number(positiveRate.toFixed(2)),
        average_score: Number(averageScore.toFixed(2)),
      },
      visibility: "local",
    }, { type: "belief" }));
  }

  return beliefs.sort((a, b) => (b.confidence - a.confidence) || String(a.belief_key || "").localeCompare(String(b.belief_key || "")));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node scripts/derive-beliefs.js [--workspace PATH] [--decisions FILE] [--outcomes FILE] [--output FILE]
`);
    return;
  }

  const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE || join(homedir(), ".openclaw/workspace");
  const decisionsPath = args.decisions || join(workspace, "memory/private/openbrain/decisions.jsonl");
  const outcomesPath = args.outcomes || join(workspace, "memory/private/openbrain/outcomes.jsonl");
  const outputPath = args.output || join(workspace, "memory/private/openbrain/beliefs.jsonl");

  const beliefs = buildBeliefs(readJsonl(decisionsPath), readJsonl(outcomesPath));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${beliefs.map((belief) => JSON.stringify(belief)).join("\n")}${beliefs.length ? "\n" : ""}`,
    "utf8",
  );

  console.log(JSON.stringify({
    ok: true,
    beliefs: beliefs.length,
    decisions_source: decisionsPath,
    outcomes_source: outcomesPath,
    output: outputPath,
  }));
}

main();
