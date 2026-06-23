#!/usr/bin/env node

import {
  ensureWorkspaceScaffolding,
  formatTranscript,
  ingestMessages,
  recallForSource,
} from "./index.js";

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

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function usage() {
  console.log(`OpenBrain CLI

Usage:
  node cli.js recall --workspace <path> --query "<text>" [--source-platform codex] [--source-agent main] [--json]
  node cli.js ingest --workspace <path> --session-id <id> [--transcript-file file.json | --stdin] [--source-platform codex] [--source-agent main] [--json]
  node cli.js format --transcript-file file.json [--stdin]
`);
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeMessage(message = {}) {
  const role = message.role || message?.message?.role || "user";
  const content = normalizeContent(message.content ?? message?.message?.content);

  if (role === "tool" || role === "toolResult") {
    return {
      role: "toolResult",
      toolName: message.name || message.toolName || message?.message?.toolName || "tool",
      content,
    };
  }

  return {
    role,
    content,
  };
}

function normalizeTranscriptPayload(payload) {
  const sessionId = payload?.session_id || payload?.sessionId || payload?.metadata?.session_id || "shared-session";
  const source = {
    platform: payload?.agent?.platform || payload?.source?.platform || payload?.metadata?.source_platform || "",
    agent: payload?.agent?.name || payload?.source?.agent || payload?.metadata?.source_agent || "",
  };

  const rawMessages = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];

  return {
    sessionId,
    source,
    messages: rawMessages.map(normalizeMessage),
  };
}

async function readTranscriptPayload(args) {
  if (args["transcript-file"]) {
    const fs = await import("node:fs");
    return JSON.parse(fs.readFileSync(args["transcript-file"], "utf8"));
  }
  if (args.stdin || !process.stdin.isTTY) {
    const text = await readStdin();
    return text.trim() ? JSON.parse(text) : { messages: [] };
  }
  throw new Error("Provide --transcript-file or --stdin");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help) {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (command === "recall") {
    const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE;
    const query = args.query || "";
    if (!workspace || !query) throw new Error("recall requires --workspace and --query");
    ensureWorkspaceScaffolding(workspace, { platform: args["source-platform"] || "shared" });
    const result = recallForSource(workspace, query, {
      platform: args["source-platform"] || "shared",
      agent: args["source-agent"] || "",
      sessionId: args["session-id"] || "",
    }, {
      stableContextEnabled: true,
      activeMemoryEnabled: true,
      prostheticMemoryEnabled: true,
      totalMaxChars: Number(args["max-chars"] || 1800) || 1800,
      hotCacheMaxChars: 450,
      stableContextMaxChars: 450,
      handoffMaxChars: 500,
      sessionMaxChars: 600,
      mindMaxChars: 700,
      driftMaxChars: 400,
      compensationMaxChars: 400,
      memsearchEnabled: false,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(result?.context || "");
    return;
  }

  if (command === "ingest") {
    const workspace = args.workspace || process.env.OPENBRAIN_WORKSPACE;
    if (!workspace) throw new Error("ingest requires --workspace");
    const payload = normalizeTranscriptPayload(await readTranscriptPayload(args));
    const sessionId = args["session-id"] || payload.sessionId || "shared-session";
    const source = {
      platform: args["source-platform"] || payload.source.platform || "shared",
      agent: args["source-agent"] || payload.source.agent || "",
    };

    const result = ingestMessages(workspace, sessionId, payload.messages, source);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Ingested ${result.candidateCount} candidates${result.candidateFile ? ` -> ${result.candidateFile}` : ""}`);
    return;
  }

  if (command === "format") {
    const payload = normalizeTranscriptPayload(await readTranscriptPayload(args));
    process.stdout.write(`${formatTranscript(payload.messages)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[openbrain] ${error.message}`);
  process.exit(1);
});
