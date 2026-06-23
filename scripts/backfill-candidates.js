#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { buildCandidatePayload } from "../index.js";

const HOME = process.env.HOME || homedir();
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || join(HOME, ".openclaw");
const WORKSPACE = process.env.OPENBRAIN_WORKSPACE || join(OPENCLAW_ROOT, "workspace");
const CANDIDATES_DIR = join(WORKSPACE, "memory/candidates");
const AGENTS_DIR = join(OPENCLAW_ROOT, "agents");

function safeSlug(text, fallback = "item") {
  const slug = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function sourceSlug(path, fallback = "source") {
  const parts = String(path || "")
    .split("/")
    .filter(Boolean)
    .slice(-3)
    .join("-");
  return safeSlug(parts || basename(path || "") || "", fallback);
}

function parseArgs(argv) {
  const args = { days: 14, limit: 50, mode: "sessions" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") args.days = Number(argv[++i] || 14) || 14;
    else if (arg === "--limit") args.limit = Number(argv[++i] || 50) || 50;
    else if (arg === "--agent") args.agent = argv[++i] || "";
    else if (arg === "--mode") args.mode = argv[++i] || "sessions";
  }
  return args;
}

function artifactRootCandidates() {
  return [
    join(WORKSPACE, "obsidian"),
    join(WORKSPACE, "return-store"),
    join(WORKSPACE, "reasoner"),
    join(WORKSPACE, "brain-architecture"),
    "/mnt/c/Users/cizam/Documents/Epicurean Digital/Epicurean Digital/OpenClaw",
    "/mnt/c/Users/cizam/Documents/Epicurean Digital/Epicurean Digital/Forge/brain-architecture",
  ];
}

function priorityArtifactFiles() {
  return [
    "/mnt/c/Users/cizam/Documents/Epicurean Digital/Epicurean Digital/Forge/brain-architecture/long-term-memory-design.md",
    "/mnt/c/Users/cizam/Documents/Epicurean Digital/Epicurean Digital/Forge/brain-architecture/prompts/memory-curator.md",
    "/mnt/c/Users/cizam/Documents/Epicurean Digital/Epicurean Digital/OpenClaw/OpenBrain_Compounding_Intelligence_Model_2026-04-03.md",
  ];
}

function collectArtifactFiles({ days, limit }) {
  const cutoff = Date.now() - days * 86400000;
  const files = [];
  const seen = new Set();

  for (const path of priorityArtifactFiles()) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    files.push({ path, mtime: stat.mtimeMs, root: "priority" });
    seen.add(path);
  }

  for (const root of artifactRootCandidates()) {
    if (!existsSync(root)) continue;
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (!/\.(md|txt|yml|yaml|json)$/i.test(entry.name)) continue;
      const path = join(root, entry.name);
      if (seen.has(path)) continue;
      const stat = statSync(path);
      if (stat.mtimeMs < cutoff) continue;
      files.push({ path, mtime: stat.mtimeMs, root });
    }
  }
  const priority = files.filter(file => file.root === "priority");
  const recent = files
    .filter(file => file.root !== "priority")
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(0, limit - priority.length));
  return [...priority, ...recent];
}

function collectSessionFiles({ days, limit, agent }) {
  if (!existsSync(AGENTS_DIR)) return [];
  const cutoff = Date.now() - days * 86400000;
  const files = [];

  for (const agentName of readdirSync(AGENTS_DIR)) {
    if (agent && agentName !== agent) continue;
    const sessionsDir = join(AGENTS_DIR, agentName, "sessions");
    if (!existsSync(sessionsDir)) continue;
    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, file);
      const mtime = statSync(path).mtimeMs;
      if (mtime < cutoff) continue;
      files.push({ path, mtime, agentName });
    }
  }

  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function normalizeMessage(record) {
  if (record?.type !== "message" || !record.message?.role) return null;
  return {
    role: record.message.role,
    content: record.message.content || [],
    toolName: record.message.toolName,
    model: record.message.model,
    usage: record.message.usage,
    errorMessage: record.message.errorMessage || "",
    stopReason: record.message.stopReason || "",
  };
}

function parseSessionMessages(path) {
  const raw = readFileSync(path, "utf8");
  const records = raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
  return records.map(normalizeMessage).filter(Boolean);
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => typeof part === "string" ? part : part?.type === "text" ? (part.text || "") : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isSubstantiveSession(messages) {
  const userTexts = messages.filter(m => m.role === "user").map(m => contentToText(m.content)).filter(Boolean);
  const assistantTexts = messages
    .filter(m => m.role === "assistant")
    .map(m => contentToText(m.content))
    .filter(Boolean);
  const latestUser = userTexts.at(-1)?.trim() || "";
  const latestAssistant = assistantTexts.at(-1)?.trim() || "";

  const hasMeaningfulAssistant = assistantTexts.some(text => text.replace(/\s+/g, " ").trim().length >= 80);
  const hasFatalError = messages.some(m => /connection error|fetch failed|timed out|unable to connect/i.test(m.errorMessage || ""));
  const isCronOnly = userTexts.every(text => /^\[cron:/i.test(text.trim()));
  const isTransportOnly = userTexts.every(text =>
    /Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)/i.test(text)
  );
  const isSubagentOnly = userTexts.every(text =>
    /\[Subagent Context\]|\[Subagent Task\]/i.test(text)
  );
  const isControlPlaneOnly = userTexts.every(text =>
    /openclaw-control-ui|repeat the word dispatched|openclaw runtime context|internal task completion event/i.test(text)
  );
  const hasWrapperAssistant = assistantTexts.every(text =>
    /\[\[reply_to_current\]\]|^DISPATCHED$|Understood.? ?we.?ll pause here|Done\. Saved to/i.test(text.trim())
  );
  const isAckOnlyTail = /^(just write it to my obsidian vault|actually no\.? i'll wait|testing|are you there\??)$/i.test(latestUser)
    || /openclaw runtime context \(internal\)|internal task completion event/i.test(latestUser)
    || /^(done\. saved to|understood.? ?we.?ll pause here|dispatched\b|eli's back with a solid proposal)/i.test(latestAssistant);

  return hasMeaningfulAssistant
    && !hasFatalError
    && !isCronOnly
    && !isTransportOnly
    && !isSubagentOnly
    && !isControlPlaneOnly
    && !hasWrapperAssistant
    && !isAckOnlyTail;
}

function writeCandidatePayload(fileInfo, payload) {
  mkdirSync(CANDIDATES_DIR, { recursive: true });
  const ts = new Date(fileInfo.mtime).toISOString().replace(/[:.]/g, "-");
  const source = sourceSlug(fileInfo.path, "source");
  const file = join(
    CANDIDATES_DIR,
    `${ts}-${safeSlug(payload.session_id || fileInfo.agentName, "session")}-${source}-backfill.json`
  );
  writeFileSync(file, JSON.stringify({
    ...payload,
    backfill: true,
    source_file: fileInfo.path,
    source_agent: fileInfo.agentName,
  }, null, 2), "utf8");
  return file;
}

function sanitizeArtifactText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeTitleFromLine(line, fallback = "artifact memory") {
  const cleaned = (line || "")
    .replace(/^[-#*\s]+/, "")
    .replace(/`/g, "")
    .trim();
  return safeSlug(cleaned, fallback);
}

function maybePushCandidate(candidates, candidate) {
  if (!candidate?.content) return;
  const content = candidate.content.trim();
  if (content.length < 60) return;
  if (/^(next steps|goal|purpose|layout|how to use|design goals|voice rules|site architecture|current baseline|target runtime)$/i.test(candidate.rawLabel || "")) return;
  candidates.push({
    id: `${Date.now()}-${candidate.type}-${safeTitleFromLine(candidate.title || candidate.rawLabel || content, candidate.type)}`,
    type: candidate.type,
    title: safeTitleFromLine(candidate.title || candidate.rawLabel || content, candidate.type),
    content,
    source_session: candidate.source_session,
    evidence: candidate.evidence || {},
    confidence: candidate.confidence,
    reuse_likelihood: candidate.reuse_likelihood,
    promotion_state: candidate.promotion_state || "candidate",
    cost_to_create: 0,
    estimated_value: candidate.estimated_value || "artifact_seed",
  });
}

function looksLikeTaxonomyList(text) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/);
  const separators = (cleaned.match(/\s-\s|,\s/g) || []).length;
  const sentenceCount = (cleaned.match(/[.!?]/g) || []).length;
  return words.length >= 8 && separators >= 4 && sentenceCount === 0;
}

function candidatePriority(candidate) {
  const byType = {
    cognitive_pattern: 100,
    conceptual_model: 95,
    emotional_pattern: 90,
    transfer_hypothesis: 88,
    discovered_pattern: 84,
    decision: 78,
    procedure: 74,
    semantic: 60,
  };
  const evidenceBonus = /targeted-/i.test(String(candidate?.evidence?.kind || "")) ? 12 : 0;
  return (byType[candidate?.type] || 50) + evidenceBonus + Math.round((candidate?.confidence || 0) * 10);
}

function extractTargetedCognitiveCandidates(fileInfo, text, sessionId, relPath, candidates) {
  const lowerPath = fileInfo.path.toLowerCase();

  if (lowerPath.endsWith("long-term-memory-design.md")) {
    const headingMatch = text.match(/##\s+\[cognitive\]\s+([^\n]+)\n([\s\S]*?)(?:\n---|\n## |\s*$)/i);
    if (headingMatch) {
      const title = headingMatch[1].trim();
      const body = headingMatch[2]
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("- "))
        .join(" ")
        .trim();
      if (body.length >= 80) {
        maybePushCandidate(candidates, {
          type: "cognitive_pattern",
          title,
          rawLabel: title,
          content: body,
          source_session: sessionId,
          evidence: { artifact: relPath, kind: "targeted-cognitive-entry" },
          confidence: 0.82,
          reuse_likelihood: 0.9,
          estimated_value: "cognitive_regulation",
        });
      }
    }
  }

  if (lowerPath.endsWith("memory-curator.md")) {
    const exampleMatch = text.match(/\*\*cognitive\*\*[\s\S]*?Example:\s*"([^"]+)"/i);
    if (exampleMatch) {
      const content = exampleMatch[1].trim();
      maybePushCandidate(candidates, {
        type: "cognitive_pattern",
        title: content.split(/[—-]/)[0].trim(),
        rawLabel: "cognitive example",
        content,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "targeted-cognitive-example" },
        confidence: 0.78,
        reuse_likelihood: 0.88,
        estimated_value: "cognitive_regulation",
      });
    }
  }
}

function extractTargetedEmotionalCandidates(fileInfo, text, sessionId, relPath, candidates) {
  const lowerPath = fileInfo.path.toLowerCase();

  if (lowerPath.endsWith("memory-curator.md")) {
    const exampleMatch = text.match(/\*\*emotional\*\*[\s\S]*?Example:\s*"([^"]+)"/i);
    if (exampleMatch) {
      const content = exampleMatch[1].trim();
      maybePushCandidate(candidates, {
        type: "emotional_pattern",
        title: content.split(/[—-]/)[0].trim(),
        rawLabel: "emotional example",
        content,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "targeted-emotional-example" },
        confidence: 0.78,
        reuse_likelihood: 0.88,
        estimated_value: "regulation_support",
      });
    }

    const blockMatch = text.match(/##\s+\[emotional\]\s+([^\n]+)\n([\s\S]*?)(?:\n---|\n## |\s*$)/i);
    if (blockMatch) {
      const title = blockMatch[1].trim();
      const body = blockMatch[2]
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("- "))
        .join(" ")
        .trim();
      if (body.length >= 90) {
        maybePushCandidate(candidates, {
          type: "emotional_pattern",
          title,
          rawLabel: title,
          content: body,
          source_session: sessionId,
          evidence: { artifact: relPath, kind: "targeted-emotional-entry" },
          confidence: 0.82,
          reuse_likelihood: 0.9,
          estimated_value: "regulation_support",
        });
      }
    }
  }
}

function extractTargetedTransferCandidates(fileInfo, text, sessionId, relPath, candidates) {
  const lowerPath = fileInfo.path.toLowerCase();

  if (lowerPath.endsWith("openbrain_compounding_intelligence_model_2026-04-03.md")
    || lowerPath.endsWith("openbrain-compounding-intelligence-model-2026-04-03.md")) {
    const sentenceMatch = text.match(/Compaction and session transitions are not separate problems\.[\s\S]*?They are both continuity-transfer problems\./i);
    if (sentenceMatch) {
      const content = sentenceMatch[0].replace(/\s+/g, " ").trim();
      maybePushCandidate(candidates, {
        type: "transfer_hypothesis",
        title: "Compaction and session transitions share continuity-transfer structure",
        rawLabel: "continuity transfer hypothesis",
        content,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "targeted-transfer-entry" },
        confidence: 0.8,
        reuse_likelihood: 0.9,
        estimated_value: "cross_domain_transfer",
      });
    }
  }
}

function extractArtifactCandidates(fileInfo, raw) {
  const text = sanitizeArtifactText(raw);
  if (!text) return null;

  const sessionId = `artifact-${sourceSlug(fileInfo.path, "artifact")}`;
  const relPath = fileInfo.path.replace(`${WORKSPACE}/`, "");
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  const candidates = [];

  const paragraphs = text
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(block => block.length >= 80);

  const headings = lines.filter(line => /^#{1,3}\s+/.test(line));
  for (const heading of headings.slice(0, 8)) {
    const label = heading.replace(/^#{1,3}\s+/, "").trim();
    const idx = lines.indexOf(heading);
    const following = lines.slice(idx + 1, idx + 5).filter(line => !/^#{1,3}\s+/.test(line));
    const content = following.join(" ").trim();
    if (content.length < 80) continue;
    if (looksLikeTaxonomyList(content)) continue;

    let type = "semantic";
    let estimatedValue = "project_context";
    let confidence = 0.64;
    let reuse = 0.7;

    if (/goal|principle|policy|architecture|definition|frame|core idea/i.test(label)) {
      type = "decision";
      estimatedValue = "durable_decision";
      confidence = 0.7;
      reuse = 0.78;
    } else if (/how to use|workflow|next steps|roadmap|phased roadmap|implementation notes/i.test(label)) {
      type = "procedure";
      estimatedValue = "procedure_reuse";
      confidence = 0.72;
      reuse = 0.8;
    } else if (/pattern|compensation|operator profile|drift model|coherence model/i.test(label)) {
      type = "discovered_pattern";
      estimatedValue = "pattern_discovery";
      confidence = 0.7;
      reuse = 0.82;
    } else if (/conceptual|distinction|theory|model|abstraction|compounding intelligence/i.test(label)) {
      type = "conceptual_model";
      estimatedValue = "conceptual_reuse";
      confidence = 0.72;
      reuse = 0.82;
    } else if (/cognitive|thinking style|mental model|reasoning pattern/i.test(label)) {
      type = "cognitive_pattern";
      estimatedValue = "cognitive_regulation";
      confidence = 0.7;
      reuse = 0.8;
    } else if (/emotional|affective|what matters|friction|regulation/i.test(label)) {
      type = "emotional_pattern";
      estimatedValue = "regulation_support";
      confidence = 0.66;
      reuse = 0.72;
    } else if (/transfer|cross-domain|maps to|analogy/i.test(label)) {
      type = "transfer_hypothesis";
      estimatedValue = "cross_domain_transfer";
      confidence = 0.64;
      reuse = 0.76;
    }

    if (type === "semantic" && !/approved|template|persona|movement|brand|telemetry contract/i.test(label)) {
      continue;
    }

    maybePushCandidate(candidates, {
      type,
      title: label,
      rawLabel: label,
      content: `${label}: ${content}`,
      source_session: sessionId,
      evidence: { artifact: relPath, heading: label },
      confidence,
      reuse_likelihood: reuse,
      estimated_value: estimatedValue,
    });
  }

  extractTargetedCognitiveCandidates(fileInfo, text, sessionId, relPath, candidates);
  extractTargetedEmotionalCandidates(fileInfo, text, sessionId, relPath, candidates);
  extractTargetedTransferCandidates(fileInfo, text, sessionId, relPath, candidates);

  for (const paragraph of paragraphs.slice(0, 6)) {
    const firstSentence = paragraph.split(/(?<=[.!?])\s+/)[0] || paragraph;
    if (looksLikeTaxonomyList(paragraph)) continue;
    if (/you were never broken|i belong to myself|not a self-improvement brand|aligned cognitive amplifier/i.test(paragraph.toLowerCase())) {
      maybePushCandidate(candidates, {
        type: "decision",
        title: firstSentence,
        rawLabel: firstSentence,
        content: paragraph,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "paragraph" },
        confidence: 0.76,
        reuse_likelihood: 0.82,
        estimated_value: "durable_decision",
      });
    } else if (/when to apply|payoff|outcome|purpose/i.test(paragraph.toLowerCase())) {
      maybePushCandidate(candidates, {
        type: "procedure",
        title: firstSentence,
        rawLabel: firstSentence,
        content: paragraph,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "paragraph" },
        confidence: 0.68,
        reuse_likelihood: 0.74,
        estimated_value: "procedure_reuse",
      });
    } else if (/priority - highest|priority - high|outcome -/i.test(paragraph.toLowerCase())) {
      maybePushCandidate(candidates, {
        type: "procedure",
        title: firstSentence,
        rawLabel: firstSentence,
        content: paragraph,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "paragraph" },
        confidence: 0.7,
        reuse_likelihood: 0.8,
        estimated_value: "procedure_reuse",
      });
    } else if (/not just|difference between|is not the same as|rather than|means that|the goal is not/i.test(paragraph.toLowerCase())) {
      maybePushCandidate(candidates, {
        type: "conceptual_model",
        title: firstSentence,
        rawLabel: firstSentence,
        content: paragraph,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "paragraph" },
        confidence: 0.7,
        reuse_likelihood: 0.8,
        estimated_value: "conceptual_reuse",
      });
    } else if (/thinks in|reasoning patterns|thinking style|mental models|approaches problems/i.test(paragraph.toLowerCase())) {
      maybePushCandidate(candidates, {
        type: "cognitive_pattern",
        title: firstSentence,
        rawLabel: firstSentence,
        content: paragraph,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "paragraph" },
        confidence: 0.68,
        reuse_likelihood: 0.78,
        estimated_value: "cognitive_regulation",
      });
    } else if (/emotional|affective|what matters|friction|care deeply|cost surprises/i.test(paragraph.toLowerCase())) {
      maybePushCandidate(candidates, {
        type: "emotional_pattern",
        title: firstSentence,
        rawLabel: firstSentence,
        content: paragraph,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "paragraph" },
        confidence: 0.64,
        reuse_likelihood: 0.72,
        estimated_value: "regulation_support",
      });
    } else if (/transfer|cross-domain|another domain|maps to|structurally similar/i.test(paragraph.toLowerCase())) {
      maybePushCandidate(candidates, {
        type: "transfer_hypothesis",
        title: firstSentence,
        rawLabel: firstSentence,
        content: paragraph,
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "paragraph" },
        confidence: 0.64,
        reuse_likelihood: 0.76,
        estimated_value: "cross_domain_transfer",
      });
    }
  }

  const bulletLines = lines.filter(line => /^-\s+/.test(line)).slice(0, 20);
  if (bulletLines.length >= 3) {
    const bullets = bulletLines.map(line => line.replace(/^-\s+/, "").trim()).filter(Boolean);
    const procedureBullets = bullets.filter(line => line.length >= 20).slice(0, 6);
    if (procedureBullets.length >= 3) {
      maybePushCandidate(candidates, {
        type: "procedure",
        title: `${relPath} reusable workflow`,
        rawLabel: "workflow",
        content: procedureBullets.join(" "),
        source_session: sessionId,
        evidence: { artifact: relPath, kind: "bullets" },
        confidence: 0.7,
        reuse_likelihood: 0.78,
        estimated_value: "procedure_reuse",
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.type}:${candidate.title}:${candidate.content.slice(0, 120)}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  if (deduped.length === 0) return null;

  deduped.sort((a, b) => candidatePriority(b) - candidatePriority(a));

  return {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    query_type: "artifact",
    tool_observations: [],
    candidates: deduped.slice(0, 8),
    artifact_backfill: true,
    source_file: fileInfo.path,
    source_agent: "artifact",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let staged = 0;

  if (args.mode === "artifacts") {
    const files = collectArtifactFiles(args);
    for (const fileInfo of files) {
      const raw = readFileSync(fileInfo.path, "utf8");
      const payload = extractArtifactCandidates(fileInfo, raw);
      if (!payload) continue;
      writeCandidatePayload(fileInfo, payload);
      staged++;
    }
    console.log(`[backfill] scanned ${files.length} artifact files, staged ${staged} candidate payloads into ${CANDIDATES_DIR}`);
    return;
  }

  const files = collectSessionFiles(args);
  for (const fileInfo of files) {
    const messages = parseSessionMessages(fileInfo.path);
    if (messages.length < 2) continue;
    if (!isSubstantiveSession(messages)) continue;
    const sessionId = fileInfo.path.split("/").pop().replace(/\.jsonl$/, "");
    const payload = buildCandidatePayload(sessionId, messages);
    if (!payload) continue;
    writeCandidatePayload(fileInfo, payload);
    staged++;
  }

  console.log(`[backfill] scanned ${files.length} session files, staged ${staged} candidate payloads into ${CANDIDATES_DIR}`);
}

main();
