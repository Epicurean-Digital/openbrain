import { readFileSync } from "node:fs";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeToolResult(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const item of content) {
    if (!item || item.type !== "tool_result") continue;
    if (typeof item.content === "string") {
      parts.push(item.content.trim());
      continue;
    }
    const nested = contentText(item.content).trim();
    if (nested) parts.push(nested);
  }

  return parts.filter(Boolean).join("\n").trim();
}

export function parseClaudeSession(sessionFile) {
  const raw = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const messages = [];
  const toolNamesById = new Map();
  let sessionId = "";

  for (const line of raw) {
    const item = JSON.parse(line);
    sessionId = item.sessionId || sessionId;

    if (item.type === "assistant") {
      const message = item.message || {};
      const content = message.content;

      if (Array.isArray(content)) {
        const text = contentText(content).trim();
        if (text) messages.push({ role: "assistant", content: text });

        for (const block of content) {
          if (block?.type === "tool_use" && block.id) {
            toolNamesById.set(block.id, block.name || "tool_use");
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        messages.push({ role: "assistant", content: content.trim() });
      }

      continue;
    }

    if (item.type === "user") {
      const message = item.message || {};
      const content = message.content;

      if (typeof content === "string" && content.trim()) {
        messages.push({ role: "user", content: content.trim() });
        continue;
      }

      if (!Array.isArray(content)) continue;

      const toolResultText = normalizeToolResult(content);
      if (toolResultText) {
        const firstToolResult = content.find((block) => block?.type === "tool_result");
        const toolUseId = firstToolResult?.tool_use_id || "";
        messages.push({
          role: "toolResult",
          toolName: toolNamesById.get(toolUseId) || toolUseId || "tool_result",
          content: toolResultText,
        });
        continue;
      }

      const text = contentText(content).trim();
      if (text) messages.push({ role: "user", content: text });
    }
  }

  return {
    session_id: sessionId || sessionFile.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
    agent: {
      platform: "claude",
      name: "claude-code",
    },
    metadata: {
      session_file: sessionFile,
    },
    messages,
  };
}
