#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function normalize(text) {
  return String(text || "")
    .replace(/\n\.\.\.\[truncated\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(text) {
  return new Set(
    normalize(text)
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
}

function overlapRatio(source, target) {
  const src = tokenize(source);
  const dst = tokenize(target);
  if (src.size === 0) return 1;
  let hits = 0;
  for (const token of src) {
    if (dst.has(token)) hits += 1;
  }
  return hits / src.size;
}

function parseHandoffSections(markdown) {
  const sections = {};
  let current = "";
  for (const line of String(markdown || "").split("\n")) {
    const header = line.match(/^##\s+(.*)$/);
    if (header) {
      current = header[1].trim().toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  const clean = {};
  for (const [key, lines] of Object.entries(sections)) {
    clean[key] = lines.join("\n").trim();
  }
  return clean;
}

function parseBulletSection(sectionText) {
  return String(sectionText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function metric(name, pass, detail, extra = {}) {
  return { name, pass, detail, ...extra };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE || join(process.env.HOME || "/home/cizambra", ".openclaw/workspace");
  const platform = args.platform || "";
  const hostRoot = platform ? join(workspace, "memory", "hosts", platform) : join(workspace, "memory");
  const handoffPath = args.handoff || join(hostRoot, "HANDOFF.md");
  const statePath = args.state || join(hostRoot, "state-transfer.json");

  if (!existsSync(handoffPath)) {
    console.error(JSON.stringify({ ok: false, error: "missing_handoff", handoffPath }));
    process.exit(2);
  }
  if (!existsSync(statePath)) {
    console.error(JSON.stringify({ ok: false, error: "missing_state_transfer", statePath }));
    process.exit(2);
  }

  const handoff = readFileSync(handoffPath, "utf8");
  const state = readJson(statePath);
  if (!state) {
    console.error(JSON.stringify({ ok: false, error: "invalid_state_transfer", statePath }));
    process.exit(2);
  }

  const sections = parseHandoffSections(handoff);
  const focus = sections["focus"] || "";
  const nextStep = sections["next step"] || "";
  const constraints = parseBulletSection(sections["constraints"]);
  const openLoops = parseBulletSection(sections["open loops"]);
  const decisions = parseBulletSection(sections["decisions in force"]);

  const handoffBytes = statSync(handoffPath).size;
  const stateBytes = statSync(statePath).size;

  const focusRatio = overlapRatio(state.objective, focus);
  const nextStepRatio = overlapRatio(state.next_step, nextStep);
  const constraintsRatio = state.constraints?.length
    ? state.constraints.reduce((sum, item) => sum + Math.max(...constraints.map((candidate) => overlapRatio(item, candidate)), 0), 0) / state.constraints.length
    : 1;
  const openLoopsRatio = state.open_loops?.length
    ? state.open_loops.reduce((sum, item) => sum + Math.max(...openLoops.map((candidate) => overlapRatio(item, candidate)), 0), 0) / state.open_loops.length
    : 1;
  const decisionsRatio = state.decisions?.length
    ? state.decisions.reduce((sum, item) => sum + Math.max(...decisions.map((candidate) => overlapRatio(item, candidate)), 0), 0) / state.decisions.length
    : 1;

  const metrics = [
    metric("focus_preserved", focusRatio >= 0.45, `focus overlap ${focusRatio.toFixed(2)}`, { ratio: focusRatio }),
    metric("next_step_preserved", nextStepRatio >= 0.45, `next-step overlap ${nextStepRatio.toFixed(2)}`, { ratio: nextStepRatio }),
    metric("constraints_preserved", constraintsRatio >= 0.35, `constraints overlap ${constraintsRatio.toFixed(2)}`, { ratio: constraintsRatio }),
    metric("open_loops_preserved", openLoopsRatio >= 0.35, `open-loops overlap ${openLoopsRatio.toFixed(2)}`, { ratio: openLoopsRatio }),
    metric("decisions_preserved", decisionsRatio >= 0.35, `decisions overlap ${decisionsRatio.toFixed(2)}`, { ratio: decisionsRatio }),
    metric("handoff_compact", handoffBytes <= Math.max(700, Math.round(stateBytes * 0.8)), `handoff ${handoffBytes} bytes vs state ${stateBytes} bytes`, { handoffBytes, stateBytes }),
  ];

  const ok = metrics.every((item) => item.pass);
  const summary = {
    ok,
    workspace,
    platform: platform || "shared",
    handoffPath,
    statePath,
    handoffBytes,
    stateBytes,
    metrics,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
