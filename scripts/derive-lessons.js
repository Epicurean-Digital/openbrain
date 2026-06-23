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

function normalizeText(text, maxChars = 160) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 16)).trimEnd()}...`;
}

function outcomeKey(outcome) {
  return outcome?.outcome_key
    || outcome?.id
    || outcome?.decision_key
    || hashString(normalizeText(outcome?.summary || outcome?.title || outcome?.content || "", 180).toLowerCase());
}

function outcomeSuccess(outcome) {
  const nested = outcome?.outcome || {};
  if (typeof nested.success === "boolean") return nested.success;
  if (typeof outcome?.success === "boolean") return outcome.success;
  const score = Number(nested.resolution_score ?? outcome?.resolution_score);
  if (Number.isFinite(score)) return score >= 70;
  return false;
}

function lessonStatement(outcome) {
  const summary = normalizeText(outcome?.summary || outcome?.outcome?.summary || outcome?.content || outcome?.title || "", 120);
  if (outcomeSuccess(outcome)) {
    if (summary) return `Keep the pattern that produced this outcome: ${summary}`;
    return "Keep the pattern that produced the successful outcome.";
  }
  if (summary) return `Revise the pattern that produced this outcome: ${summary}`;
  return "Revise the pattern that produced the failed or partial outcome.";
}

function buildLessons(outcomes) {
  const lessons = [];
  const seen = new Set();

  for (const outcome of outcomes) {
    const key = outcomeKey(outcome);
    if (seen.has(key)) continue;
    seen.add(key);

    const summary = normalizeText(outcome?.summary || outcome?.outcome?.summary || outcome?.content || outcome?.title || "", 140);
    const success = outcomeSuccess(outcome);
    const confidence = success ? 0.72 : 0.62;
    const refs = [...new Set([
      outcome?.id,
      outcome?.outcome_key,
      outcome?.decision_key,
    ].filter(Boolean))];

    lessons.push(normalizeMemoryObject({
      type: "lesson",
      id: `lesson:${key}`,
      lesson_key: `lesson_${key}`,
      outcome_key: key,
      title: safeSlug(summary || key, "lesson"),
      statement: lessonStatement(outcome),
      summary,
      confidence,
      reinforcement_count: 1,
      trajectory: success ? "established" : "learning",
      decay_mode: "slow",
      source_refs: refs,
      support: {
        success,
        resolution_score: Number(outcome?.outcome?.resolution_score ?? outcome?.resolution_score ?? null),
      },
      visibility: "local",
    }, { type: "lesson" }));
  }

  return lessons.sort((a, b) => String(a.lesson_key || "").localeCompare(String(b.lesson_key || "")));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node scripts/derive-lessons.js [--workspace PATH] [--outcomes FILE] [--output FILE]
`);
    return;
  }

  const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE || join(homedir(), ".openclaw/workspace");
  const outcomesPath = args.outcomes || join(workspace, "memory/private/openbrain/outcomes.jsonl");
  const outputPath = args.output || join(workspace, "memory/private/openbrain/lessons.jsonl");

  const lessons = buildLessons(readJsonl(outcomesPath));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${lessons.map((lesson) => JSON.stringify(lesson)).join("\n")}${lessons.length ? "\n" : ""}`,
    "utf8",
  );

  console.log(JSON.stringify({
    ok: true,
    lessons: lessons.length,
    outcomes_source: outcomesPath,
    output: outputPath,
  }));
}

main();
