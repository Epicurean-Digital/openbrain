import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { normalizeMemoryObject } from "./memory-schema.js";

export function appendMemoryEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const record = normalizeMemoryObject(event, { type: event?.type || "event" });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
