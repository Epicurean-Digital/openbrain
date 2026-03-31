/**
 * OpenBrain — persistent memory, cross-session pattern learning, and context retrieval.
 *
 * Hooks used:
 *   before_prompt_build  — query classification + L0/L1/L2 retrieval injection
 *   agent_end            — cost logging + self-eval + debounced session curation
 *
 * Config (from openclaw.json plugins.entries.openbrain.config):
 *   workspace                — memory workspace path
 *   costWebhook              — optional HTTP endpoint for token cost logging
 *   curator.model            — curator model id
 *   curator.provider         — curator provider (anthropic|deepseek)
 *   eval.model               — eval model id
 *   eval.provider            — eval provider
 *   curationDebounceMinutes  — minutes of inactivity before curation fires (default 10)
 *   hotCacheSize             — top-N entries in HOT_CACHE.md (default 25)
 */

import { writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join }    from "node:path";
import { spawn }   from "node:child_process";
import { homedir } from "node:os";

const PLUGIN_DIR = import.meta.dirname;

// ── Query classifier ───────────────────────────────────────────────────────────
const TEMPORAL_RE   = /\b(current|latest|now|today|this week|recently|right now|price|status|news)\b/i;
const EPISODIC_RE   = /\b(remember|last time|we decided|what did|previously|earlier|before|discussed|mentioned|you said)\b/i;
const PROCEDURAL_RE = /\b(how (do|to|should|can)|steps|process|workflow|procedure|what.s the (way|approach))\b/i;

// PERSONAL_RE is built at load time from config.personalTerms — add your own project names, people, etc.
// These terms signal episodic/personal queries that benefit most from memory retrieval.
let PERSONAL_RE = null;

const STOP_WORDS = new Set([
  "that","this","with","from","have","what","when","where","which","your",
  "their","there","then","than","been","were","they","into","about","would",
]);

function classifyQuery(text) {
  if (TEMPORAL_RE.test(text))             return "temporal";
  if (EPISODIC_RE.test(text))             return "episodic";
  if (PROCEDURAL_RE.test(text))           return "procedural";
  if (PERSONAL_RE && PERSONAL_RE.test(text)) return "personal";
  return "factual";
}

function getQueryTerms(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w))
  )];
}

// ── Retrieval ──────────────────────────────────────────────────────────────────
function retrieveFromMind(query, mindMd) {
  if (!mindMd) return "";
  const terms = getQueryTerms(query);
  if (terms.length === 0) return "";

  const sections = mindMd
    .split(/\n---\n/)
    .map(s => s.trim())
    .filter(s => s.startsWith("## ["));

  const scored = sections
    .map(s => ({ s, hits: terms.filter(t => s.toLowerCase().includes(t)).length }))
    .filter(e => e.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4);

  return scored.map(e => e.s).join("\n\n---\n\n");
}

function retrieveFromSessions(query, workspace, daysBack = 14) {
  const terms = getQueryTerms(query);
  if (terms.length === 0) return "";
  const results = [];
  const today   = new Date();

  const sessionsDir = join(workspace, "memory/sessions");
  if (existsSync(sessionsDir)) {
    for (const f of readdirSync(sessionsDir).sort().reverse().slice(0, 30)) {
      if (!f.endsWith(".md")) continue;
      const raw  = readFileSync(join(sessionsDir, f), "utf8");
      const hits = terms.filter(t => raw.toLowerCase().includes(t)).length;
      if (hits >= 2) results.push(raw.slice(0, 400));
    }
  }

  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const path    = join(workspace, `memory/${dateStr}.md`);
    if (!existsSync(path)) continue;

    const content    = readFileSync(path, "utf8");
    const paragraphs = content.split(/\n\n+/);
    for (const p of paragraphs) {
      if (p.trim().length < 50) continue;
      const hits = terms.filter(t => p.toLowerCase().includes(t)).length;
      if (hits >= 2) results.push(`[${dateStr}] ${p.trim().slice(0, 300)}`);
    }
  }

  return results.slice(0, 6).join("\n\n");
}

function buildRetrievalContext(type, query, workspace) {
  if (type === "temporal") {
    return "<!-- brain: temporal query — prefer web search over memory for current information -->";
  }

  const mindMd      = existsSync(join(workspace, "memory/MIND.md"))
    ? readFileSync(join(workspace, "memory/MIND.md"), "utf8")
    : "";
  const parts       = [];
  const mindResults = retrieveFromMind(query, mindMd);
  if (mindResults) parts.push(`### Relevant memories (L1)\n${mindResults}`);

  if (type === "episodic" || type === "personal") {
    const sessionResults = retrieveFromSessions(query, workspace);
    if (sessionResults) parts.push(`### Recent session context (L2)\n${sessionResults}`);
  }

  if (parts.length === 0) return null;
  return `<!-- brain-retrieval: ${type} -->\n${parts.join("\n\n")}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function extractExchange(messages) {
  if (!Array.isArray(messages)) return null;
  let question = "", response = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg  = messages[i];
    if (!msg?.role) continue;
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === "text").map(b => b.text || "").join("\n")
        : "";
    if (!text.trim()) continue;
    if (!response && msg.role === "assistant") response = text.trim();
    if (!question && msg.role === "user")      question = text.trim();
    if (question && response) break;
  }
  return question || response ? { question, response } : null;
}

function formatTranscript(messages) {
  const turns = [];
  for (const msg of (messages || [])) {
    if (!msg?.role) continue;
    const content = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === "text").map(b => b.text).join("\n")
        : "";
    const text = content
      .replace(/Sender \(untrusted metadata\):[\s\S]*?```\n[\s\S]*?```\n/g, "")
      .trim();
    if (!text || (msg.role === "assistant" && text.startsWith("{") && text.includes('"type"'))) continue;
    turns.push(`${msg.role === "user" ? "Human" : "Assistant"}: ${text}`);
  }
  return turns.join("\n\n");
}

// ── Plugin entry point ────────────────────────────────────────────────────────
export default function openBrainPlugin(api) {
  const config = api.pluginConfig || {};

  // Build personal terms regex from config (add your own project names, people, etc.)
  const personalTerms = Array.isArray(config.personalTerms) && config.personalTerms.length > 0
    ? config.personalTerms
    : null;
  if (personalTerms) {
    const escaped = personalTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    PERSONAL_RE = new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
  }

  const WORKSPACE               = config.workspace || join(process.env.HOME || homedir(), ".openclaw/workspace");
  const COST_WEBHOOK            = config.costWebhook || null;
  const CURATOR_MODEL           = config.curator?.model    || "claude-sonnet-4-6";
  const CURATOR_PROVIDER        = config.curator?.provider || "anthropic";
  const EVAL_MODEL              = config.eval?.model    || "claude-haiku-4-5-20251001";
  const EVAL_PROVIDER           = config.eval?.provider || "anthropic";
  const DEBOUNCE_MS             = (config.curationDebounceMinutes ?? 10) * 60 * 1000;
  const HOT_CACHE_SIZE          = String(config.hotCacheSize ?? 25);

  const WORKINGS_MD  = join(WORKSPACE, "memory/WORKINGS.md");
  const CURATOR_SCRIPT = join(PLUGIN_DIR, "scripts/curator.js");
  const EVAL_SCRIPT    = join(PLUGIN_DIR, "scripts/eval.js");
  const TODAY          = () => new Date().toISOString().slice(0, 10);
  const MIN_CHARS      = 200;

  // Read API keys from environment or openclaw.json
  function getApiKey(provider) {
    if (provider === "deepseek") {
      if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
      try {
        const cfg = JSON.parse(readFileSync(
          join(process.env.HOME || homedir(), ".openclaw/openclaw.json"), "utf8"
        ));
        return cfg?.models?.providers?.deepseek?.apiKey || null;
      } catch { return null; }
    }
    // anthropic
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    try {
      const profiles = JSON.parse(readFileSync(
        join(process.env.HOME || homedir(), ".openclaw/agents/main/agent/auth-profiles.json"), "utf8"
      ));
      return profiles?.profiles?.["anthropic:default"]?.key || null;
    } catch { return null; }
  }

  const ANTHROPIC_KEY = getApiKey("anthropic");
  const DEEPSEEK_KEY  = getApiKey("deepseek");

  // Write config.json for eval.js to read
  try {
    writeFileSync(join(PLUGIN_DIR, "config.json"), JSON.stringify({
      eval_model:    EVAL_MODEL,
      eval_provider: EVAL_PROVIDER,
      // curator fields (for manual runs of curator.js)
      curator_model:    CURATOR_MODEL,
      curator_provider: CURATOR_PROVIDER,
    }, null, 2));
  } catch {}

  // Env vars passed to all child processes
  const childEnv = () => ({
    ...process.env,
    OPENBRAIN_WORKSPACE:        WORKSPACE,
    OPENBRAIN_PLUGIN_DIR:       PLUGIN_DIR,
    OPENBRAIN_HOT_CACHE_SIZE:   HOT_CACHE_SIZE,
    OPENBRAIN_CURATOR_MODEL:    CURATOR_MODEL,
    OPENBRAIN_CURATOR_PROVIDER: CURATOR_PROVIDER,
    ...(ANTHROPIC_KEY ? { ANTHROPIC_API_KEY: ANTHROPIC_KEY } : {}),
    ...(DEEPSEEK_KEY  ? { DEEPSEEK_API_KEY:  DEEPSEEK_KEY  } : {}),
  });

  // Per-session debounce state (main agent only)
  const pendingCurations = new Map();

  // Detect sub-agent sessions by session key format: agent:<id>:subagent:<uuid>
  function isSubagentSession(sessionId) {
    return typeof sessionId === "string" && sessionId.includes("subagent");
  }

  // ── Cost logging ──────────────────────────────────────────────────────────────
  async function logCostToWebhook(event) {
    if (!COST_WEBHOOK) return;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    let usage = null, model = event.model || null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant" && msg.usage) {
        usage = msg.usage;
        if (!model && msg.model) model = msg.model;
        break;
      }
    }
    if (!usage) return;

    const body = {
      session_id:     event.sessionId || event.session_id || null,
      model:          model || `${CURATOR_PROVIDER}/${CURATOR_MODEL}`,
      role:           "assistant",
      tokens_in:      usage.input_tokens  || usage.prompt_tokens    || 0,
      tokens_out:     usage.output_tokens || usage.completion_tokens || 0,
      estimated_cost: usage.cost?.total ?? 0,
      tags:           "openbrain-session",
    };

    await fetch(COST_WEBHOOK, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
  }

  // ── Curation scheduling ───────────────────────────────────────────────────────
  function scheduleCuration(sessionId, messages) {
    if (pendingCurations.has(sessionId)) {
      clearTimeout(pendingCurations.get(sessionId).timer);
    }

    const timer = setTimeout(() => {
      pendingCurations.delete(sessionId);
      const transcript = formatTranscript(messages);
      if (!transcript || transcript.length < 1000) return;

      api.logger?.info(`[openbrain] session ${sessionId.slice(0, 8)} idle — starting curation`);

      const child = spawn("node", [CURATOR_SCRIPT], { env: childEnv() });
      let stdout = "";
      child.stdout.on("data", d => { stdout += d; });
      child.stderr.on("data", d => api.logger?.warn(`[openbrain] curator: ${d.toString().trim()}`));
      child.on("close", code => {
        const last = stdout.trim().split("\n").pop() || "";
        api.logger?.info(`[openbrain] curation done (exit ${code}): ${last}`);
      });
      child.on("error", e => api.logger?.warn(`[openbrain] curator spawn error: ${e.message}`));

      child.stdin.write(transcript);
      child.stdin.end();
    }, DEBOUNCE_MS);

    pendingCurations.set(sessionId, { timer, messages });
  }

  // ── Self-eval ─────────────────────────────────────────────────────────────────
  function runEval(question, response) {
    return new Promise((resolve) => {
      const child = spawn("node", [EVAL_SCRIPT], { timeout: 25000, env: childEnv() });
      let stdout  = "";
      child.stdout.on("data", d => { stdout += d; });
      child.on("close", code  => resolve(code === 2 ? null : stdout.trim() || null));
      child.on("error", ()    => resolve(null));
      child.stdin.write(`${question}|||${response}`);
      child.stdin.end();
    });
  }

  function logToWorkings(verdict, question, response) {
    const entry = `## Self-eval trace — ${TODAY()}
- verdict: ${verdict.split(":")[0]}
- tags: [self-eval, trace]

**Verdict:** ${verdict}

**Question (truncated):** ${question.slice(0, 200)}

**Response (truncated):** ${response.slice(0, 300)}

---
`;
    try { appendFileSync(WORKINGS_MD, "\n" + entry); } catch {}
  }

  // ── Hook: before_prompt_build — retrieval injection ───────────────────────────
  api.on("before_prompt_build", (event) => {
    try {
      let query = "";
      if (typeof event.prompt === "string") {
        query = event.prompt;
      } else if (Array.isArray(event.prompt)) {
        query = event.prompt.filter(b => b.type === "text").map(b => b.text).join(" ");
      } else {
        const messages = event.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === "user") {
            const c = messages[i].content;
            query   = typeof c === "string" ? c
              : Array.isArray(c) ? c.filter(b => b.type === "text").map(b => b.text).join(" ")
              : "";
            break;
          }
        }
      }

      if (!query || query.length < 10) return {};

      const type    = classifyQuery(query);
      const context = buildRetrievalContext(type, query, WORKSPACE);

      api.logger?.info(`[openbrain] ${type} query → retrieval ${context ? "hit" : "miss"}`);

      return context ? { appendSystemContext: context } : {};
    } catch (e) {
      api.logger?.warn(`[openbrain] retrieval error: ${e.message}`);
      return {};
    }
  });

  // ── Immediate curation (sub-agents) ──────────────────────────────────────────
  function curateNow(sessionId, messages) {
    const transcript = formatTranscript(messages);
    if (!transcript || transcript.length < 1000) return;

    api.logger?.info(`[openbrain] subagent ${sessionId.slice(0, 16)} ended — curating immediately`);

    const child = spawn("node", [CURATOR_SCRIPT], { env: childEnv() });
    let stdout = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => api.logger?.warn(`[openbrain] curator: ${d.toString().trim()}`));
    child.on("close", code => {
      const last = stdout.trim().split("\n").pop() || "";
      api.logger?.info(`[openbrain] curation done (exit ${code}): ${last}`);
    });
    child.on("error", e => api.logger?.warn(`[openbrain] curator spawn error: ${e.message}`));

    child.stdin.write(transcript);
    child.stdin.end();
  }

  // ── Hook: agent_end — cost log + eval + curation ──────────────────────────────
  api.on("agent_end", async (event) => {
    // Cost logging
    logCostToWebhook(event).catch(err =>
      api.logger?.warn(`[openbrain] cost-log failed: ${err.message}`)
    );

    const sessionId = event.sessionId || event.session_id || "default";
    const subagent  = isSubagentSession(sessionId);

    // Curation — immediate for sub-agents, debounced for main agent
    if (subagent) {
      curateNow(sessionId, event.messages || []);
    } else {
      scheduleCuration(sessionId, event.messages || []);
    }

    // Self-eval — runs for all agents (collective quality signal)
    const exchange = extractExchange(event.messages);
    if (!exchange || exchange.response.length < MIN_CHARS) return;

    const verdict = await runEval(exchange.question, exchange.response);
    if (!verdict) return;

    api.logger?.info(`[openbrain] eval: ${verdict}`);

    if (verdict.startsWith("FLAG") || verdict.startsWith("REVISE")) {
      logToWorkings(verdict, exchange.question, exchange.response);
    }
  });

  api.logger?.info(`[openbrain] loaded — workspace: ${WORKSPACE}, curator: ${CURATOR_PROVIDER}/${CURATOR_MODEL}, eval: ${EVAL_PROVIDER}/${EVAL_MODEL}, debounce: ${DEBOUNCE_MS / 60000}m`);
}
