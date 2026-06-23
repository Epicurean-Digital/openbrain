#!/usr/bin/env node

import { ingestMessages, recallForSource } from "../index.js";
import { parseCodexSession } from "./shared/codex-session.js";

const DEFAULT_WORKSPACE = process.env.OPENBRAIN_WORKSPACE || "";

const TOOLS = [
  {
    name: "openbrain_recall",
    description:
      "Recall OpenBrain context for the current task. Private runtime memory is consulted first; explicit shared artifacts are the cross-LLM layer. Use this when the user references prior decisions, ongoing projects, recurring workflows, personal context, or asks something that may benefit from continuity.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Path to the shared OpenBrain workspace. Optional if OPENBRAIN_WORKSPACE is set for the MCP server.",
        },
        query: {
          type: "string",
          description: "The current user query or recall question.",
        },
        source_platform: {
          type: "string",
          description: "Agent platform name, e.g. codex.",
          default: "codex",
        },
        source_agent: {
          type: "string",
          description: "Agent name, e.g. codex-tui.",
          default: "codex-tui",
        },
        session_id: {
          type: "string",
          description: "Optional active session identifier.",
        },
        max_chars: {
          type: "number",
          description: "Optional total context character budget.",
          default: 2200,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "openbrain_ingest_codex_session",
    description:
      "Ingest a completed Codex rollout file into OpenBrain private runtime memory. Explicit shared promotion happens later in the curation flow.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Path to the shared OpenBrain workspace. Optional if OPENBRAIN_WORKSPACE is set for the MCP server.",
        },
        session_file: {
          type: "string",
          description: "Absolute path to a Codex rollout JSONL file.",
        },
        source_platform: {
          type: "string",
          default: "codex",
        },
        source_agent: {
          type: "string",
          default: "codex-tui",
        },
      },
      required: ["session_file"],
      additionalProperties: false,
    },
  },
];

function writeMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function writeResponse(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function handleRequest(request) {
  const { id, method, params } = request;

  if (method === "initialize") {
    writeResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "openbrain",
        version: "0.1.0",
      },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "ping") {
    writeResponse(id, {});
    return;
  }

  if (method === "resources/list") {
    writeResponse(id, { resources: [] });
    return;
  }

  if (method === "resources/templates/list") {
    writeResponse(id, { resourceTemplates: [] });
    return;
  }

  if (method === "prompts/list") {
    writeResponse(id, { prompts: [] });
    return;
  }

  if (method === "tools/list") {
    writeResponse(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const workspace = args.workspace || DEFAULT_WORKSPACE;

    if ((name === "openbrain_recall" || name === "openbrain_ingest_codex_session") && !workspace) {
      writeError(id, -32602, "workspace is required unless OPENBRAIN_WORKSPACE is configured for the MCP server");
      return;
    }

    if (name === "openbrain_recall") {
      const result = recallForSource(
        workspace,
        args.query,
        {
          platform: args.source_platform || "codex",
          agent: args.source_agent || "codex-tui",
          sessionId: args.session_id || "",
        },
        {
          stableContextEnabled: true,
          activeMemoryEnabled: true,
          prostheticMemoryEnabled: true,
          totalMaxChars: Number(args.max_chars || 1800) || 1800,
          hotCacheMaxChars: 450,
          stableContextMaxChars: 450,
          handoffMaxChars: 500,
          sessionMaxChars: 600,
          mindMaxChars: 700,
          driftMaxChars: 400,
          compensationMaxChars: 400,
          memsearchEnabled: false,
        }
      );

      writeResponse(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
      return;
    }

    if (name === "openbrain_ingest_codex_session") {
      const parsed = parseCodexSession(args.session_file);
      const result = ingestMessages(
        workspace,
        parsed.session_id,
        parsed.messages,
        {
          platform: args.source_platform || "codex",
          agent: args.source_agent || "codex-tui",
          sessionId: parsed.session_id,
        }
      );

      writeResponse(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_file: args.session_file,
                session_id: parsed.session_id,
                message_count: parsed.messages.length,
                ...result,
              },
              null,
              2
            ),
          },
        ],
      });
      return;
    }

    writeError(id, -32601, `Unknown tool: ${name}`);
    return;
  }

  writeError(id, -32601, `Method not found: ${method}`);
}

let buffer = Buffer.alloc(0);

function consumeBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number(match[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) return;

    const payload = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    let request;
    try {
      request = JSON.parse(payload);
    } catch (error) {
      writeError(null, -32700, `Parse error: ${error.message}`);
      continue;
    }

    Promise.resolve(handleRequest(request)).catch((error) => {
      writeError(request?.id ?? null, -32603, error.message);
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  consumeBuffer();
});

process.stdin.on("end", () => process.exit(0));
