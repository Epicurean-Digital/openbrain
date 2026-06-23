import { readFileSync } from "node:fs";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "input_text" || item?.type === "output_text" || item?.type === "text") return item.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseExecOutput(output = "") {
  const match = String(output).match(/Output:\n([\s\S]*)$/);
  return match ? match[1].trim() : String(output).trim();
}

export function parseCodexSession(sessionFile) {
  const raw = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const messages = [];
  let sessionId = "";

  for (const line of raw) {
    const item = JSON.parse(line);
    if (item.type === "session_meta") {
      sessionId = item.payload?.id || sessionId;
      continue;
    }

    if (item.type !== "response_item") continue;
    const payload = item.payload || {};

    if (payload.type === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = contentText(payload.content).trim();
      if (!text) continue;
      messages.push({ role, content: text });
      continue;
    }

    if (payload.type === "function_call_output") {
      const output = parseExecOutput(payload.output || "");
      if (!output) continue;
      messages.push({
        role: "toolResult",
        toolName: payload.call_id || "function_call_output",
        content: output,
      });
      continue;
    }

    if (payload.type === "custom_tool_call_output") {
      const output = contentText(payload.output || payload.content || "").trim();
      if (!output) continue;
      messages.push({
        role: "toolResult",
        toolName: payload.name || "custom_tool",
        content: output,
      });
    }
  }

  return {
    session_id: sessionId || sessionFile.replace(/^.*rollout-/, "").replace(/\.jsonl$/, ""),
    agent: {
      platform: "codex",
      name: "codex-tui",
    },
    metadata: {
      session_file: sessionFile,
    },
    messages,
  };
}
