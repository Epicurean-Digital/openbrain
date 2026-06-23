# OpenBrain Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign OpenBrain into a file-first memory fabric with private per-agent memory and explicit cross-LLM sharing, while adding typed decision, belief, lesson, reinforcement, and decay loops.

**Architecture:** Keep the current file-backed OpenBrain core, but split memory into private and shared namespaces, add typed durable objects with provenance and visibility metadata, and make curation emit reusable learning artifacts instead of only summaries. Retrieval should continue to work through materialized views, but the source of truth becomes append-only memory records plus rebuildable projections for hot cache, continuity, constraints, procedures, and future beliefs or lessons.

**Tech Stack:** Node.js ESM, existing OpenBrain file pipeline, file-based JSONL/Markdown artifacts, Codex and Claude hook adapters

---

### Task 1: Lock the memory contract and namespace layout

**Files:**
- Modify: `index.js`
- Modify: `scripts/curator.js`
- Modify: `scripts/decay.js`
- Modify: `scripts/hot-cache.js`
- Modify: `README.md`
- Create: `memory/events.jsonl`

- [ ] **Step 1: Add a typed memory contract at the top of `index.js`**

```js
const MEMORY_OBJECT_TYPES = [
  "event",
  "episode",
  "fact",
  "constraint",
  "procedure",
  "decision",
  "outcome",
  "lesson",
  "belief",
  "drift_signal",
  "compensation",
  "candidate",
];

const MEMORY_VISIBILITY = [
  "local",
  "shared_codex",
  "shared_claude",
  "shared_cross_llm",
];
```

- [ ] **Step 2: Define explicit private and shared workspace roots**

```js
const PRIVATE_MEMORY_ROOT = join(WORKSPACE, "memory/private");
const SHARED_MEMORY_ROOT = join(WORKSPACE, "memory/shared");
const PRIVATE_HOST_ROOT = (runtime) => join(PRIVATE_MEMORY_ROOT, runtime);
const EVENT_LOG_PATH = join(WORKSPACE, "memory/events.jsonl");
```

- [ ] **Step 3: Update the README memory map to separate private and shared stores**

```md
memory/
  private/   # runtime-scoped agent folders
  shared/    # explicitly promoted cross-LLM artifacts
```

- [ ] **Step 4: Run a syntax check after the contract and path constants are added**

Run: `node --check index.js && node --check scripts/curator.js && node --check scripts/decay.js && node --check scripts/hot-cache.js`
Expected: all four files parse with no syntax errors.

### Task 2: Split capture and projection in the curation pipeline

**Files:**
- Modify: `scripts/curator.js`
- Modify: `index.js`
- Create: `scripts/shared/memory-schema.js`
- Create: `scripts/shared/memory-store.js`

- [ ] **Step 1: Add a shared memory-object normalizer**

```js
export function normalizeMemoryObject(input, defaults = {}) {
  return {
    id: input.id || `${defaults.type || "memory"}:${Date.now()}`,
    type: input.type || defaults.type || "candidate",
    scope: input.scope || defaults.scope || "global",
    owner_runtime: input.owner_runtime || defaults.owner_runtime || "unknown",
    owner_agent: input.owner_agent || defaults.owner_agent || "unknown",
    share_policy: input.share_policy || defaults.share_policy || "private",
    visibility: input.visibility || defaults.visibility || "local",
    confidence: input.confidence ?? 0.5,
    reinforcement_count: input.reinforcement_count ?? 1,
    decay_mode: input.decay_mode || "slow",
    source_refs: Array.isArray(input.source_refs) ? input.source_refs : [],
    created_at: input.created_at || new Date().toISOString(),
    updated_at: input.updated_at || new Date().toISOString(),
    ...input,
  };
}
```

```js
export function appendMemoryEvent(path, event) {
  const record = normalizeMemoryObject(event, { type: event.type || "event" });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}
```

- [ ] **Step 2: Teach `curator.js` to emit typed private artifacts first**

```js
// curate into private candidates, then selectively promote to shared files
const privateCandidate = normalizeMemoryObject({
  type: "decision",
  share_policy: "private",
  visibility: "local",
});
```

- [ ] **Step 3: Add a promotion path for explicitly shared artifacts**

```js
const promotable = candidate.share_policy === "shared_explicit"
  && candidate.visibility !== "local"
  && candidate.confidence >= 0.75;
```

- [ ] **Step 4: Keep the existing candidate JSONL and Markdown outputs rebuildable**

Run:

```bash
cat /tmp/sample-transcript.jsonl | node scripts/curator.js --candidates
```

Expected: private candidate records are written to the workspace, and shared outputs are only created for promotable items.

### Task 3: Add decision, belief, and lesson projections

**Files:**
- Modify: `index.js`
- Modify: `scripts/curator.js`
- Create: `scripts/derive-beliefs.js`
- Create: `scripts/derive-lessons.js`
- Create: runtime-scoped JSONL stores under `memory/private/`

- [ ] **Step 1: Add a decision ledger writer in `index.js`**

```js
function writeDecisionRecord(path, decision) {
  const record = normalizeMemoryObject({
    ...decision,
    type: "decision",
    visibility: decision.visibility || "local",
  }, { type: "decision" });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}
```

- [ ] **Step 2: Define a belief derivation pass from repeated decisions and outcomes**

```js
function deriveBelief(decisions, outcomes) {
  return {
    type: "belief",
    statement: "A repeated decision pattern becomes a belief when it keeps improving outcomes.",
    confidence: 0.8,
    source_refs: decisions.flatMap((d) => d.source_refs || []).slice(0, 8),
  };
}
```

- [ ] **Step 3: Define a lesson derivation pass from outcomes**

```js
function deriveLesson(outcome) {
  return {
    type: "lesson",
    statement: outcome.success
      ? "Keep the pattern that produced the successful outcome."
      : "Revise the pattern that produced the failure.",
  };
}
```

- [ ] **Step 4: Add small standalone scripts that can rebuild beliefs and lessons from JSONL sources**

Run:

```bash
node --check scripts/derive-beliefs.js
node --check scripts/derive-lessons.js
```

Expected: both scripts parse and can be invoked from the repo root.

### Task 4: Make reinforcement and decay utility-aware

**Files:**
- Modify: `scripts/decay.js`
- Modify: `scripts/hot-cache.js`
- Modify: `index.js`

- [ ] **Step 1: Extend decay metadata so utility and contradiction can change an entry faster than age alone**

```js
const DECAY_MODES = {
  time: "time_decay",
  utility: "utility_decay",
  contradiction: "contradiction_decay",
  safety: "safety_decay",
};
```

- [ ] **Step 2: Update `decay.js` to respect reinforcement and contradiction markers before archiving**

```js
if (getField(block, "contradiction_count") > 0) {
  // contradiction decay should reduce confidence faster than plain time decay
}
```

- [ ] **Step 3: Update hot-cache ranking to prefer useful, reinforced, non-contradicted objects**

```js
score = confidence * Math.log(1 + reinforced) * recency * utilityFactor * contradictionFactor;
```

- [ ] **Step 4: Verify decay and hot-cache scripts still round-trip existing entries**

Run: `node scripts/decay.js && node scripts/hot-cache.js`
Expected: existing memory files are rewritten successfully and no entries disappear unexpectedly.

### Task 5: Separate private agent memory from shared cross-LLM memory

**Files:**
- Modify: `index.js`
- Modify: `scripts/codex-adapter.js`
- Modify: `scripts/claude-hooks.js`
- Modify: `scripts/codex-hooks.js`
- Modify: `scripts/mcp-server.js`
- Modify: `scripts/codex-with-openbrain.js`
- Modify: `README.md`

- [ ] **Step 1: Add runtime-scoped private memory roots for each agent adapter**

```js
const runtimeRoot = join(WORKSPACE, "memory/private", runtime, agentId);
```

- [ ] **Step 2: Add a shared memory root that only accepts explicit promotions**

```js
const sharedRoot = join(WORKSPACE, "memory/shared");
```

- [ ] **Step 3: Update Codex and Claude adapters to read private memory from their own runtime scope first**

```js
const privateFirst = [runtimePrivateContext, sharedContext, durableContext];
```

- [ ] **Step 4: Keep cross-LLM sharing limited to explicit shared artifacts**

```js
if (artifact.share_policy !== "shared_explicit") return null;
```

- [ ] **Step 5: Document the sharing contract in README**

```md
Codex agents may keep private memory local; shared memory is only for explicitly promoted artifacts that Claude is also allowed to read.
```

### Task 6: Add smoke verification and documentation updates

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Create: `scripts/verify-memory-fabric.js`

- [ ] **Step 1: Add a repo-level verification script**

```json
{
  "scripts": {
    "verify:memory-fabric": "node scripts/verify-memory-fabric.js"
  }
}
```

- [ ] **Step 2: Implement a smoke test that rebuilds memory views in a temp workspace**

```js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "openbrain-memory-"));
mkdirSync(join(workspace, "memory/private/codex/agent-a"), { recursive: true });
mkdirSync(join(workspace, "memory/shared"), { recursive: true });
writeFileSync(join(workspace, "memory/events.jsonl"), JSON.stringify({
  type: "decision",
  share_policy: "shared_explicit",
  visibility: "shared_cross_llm",
  confidence: 0.9,
}) + "\n", "utf8");
writeFileSync(join(workspace, "memory/private/codex/agent-a/decisions.jsonl"), JSON.stringify({
  type: "decision",
  share_policy: "private",
  visibility: "local",
  confidence: 0.9,
}) + "\n", "utf8");

// invoke the existing curator, decay, and hot-cache scripts against the temp workspace
// assert that shared materialized views exist and private entries remain under private/
readFileSync(join(workspace, "memory/shared/HOT_CACHE.md"), "utf8");
readFileSync(join(workspace, "memory/private/codex/agent-a/decisions.jsonl"), "utf8");
```

- [ ] **Step 3: Run the smoke test and the syntax checks**

Run: `npm run verify:memory-fabric && node --check index.js && node --check scripts/curator.js && node --check scripts/decay.js && node --check scripts/hot-cache.js`
Expected: smoke test passes and all scripts parse.

- [ ] **Step 4: Update README to describe the new memory model**

```md
- Private memory is per runtime and per agent.
- Shared memory is explicit and cross-LLM.
- Decision, belief, and lesson objects are derived from outcomes.
- Decay is utility-aware, not only time-based.
```

### Task 7: Clean up the design artifacts after implementation is in place

**Files:**
- Modify: `docs/superpowers/plans/2026-06-22-openbrain-redesign.md` if it becomes stale
- Modify: `docs/superpowers/specs/2026-06-22-openbrain-redesign.md` in the Obsidian vault only if the spec changes

- [ ] **Step 1: Mark the implementation plan as superseded once the core memory fabric lands**

Mark this plan as superseded in the front matter or add a short note once the core memory fabric lands.

- [ ] **Step 2: Keep the spec and plan aligned if scope changes during implementation**

Run: `git diff -- docs/superpowers/plans/2026-06-22-openbrain-redesign.md`
Expected: any scope drift is explicit and documented before code changes continue.
