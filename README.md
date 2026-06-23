# OpenBrain

Persistent memory, cross-session pattern learning, and context retrieval for [OpenClaw](https://github.com/openclaw) agents, with a shared-memory CLI for other LLM runtimes.

OpenBrain gives your agent a brain that compounds over time. After each session it extracts facts, decisions, and reasoning patterns, stores them in a structured long-term memory, and retrieves the most relevant context automatically before every response.

---

## What it does

OpenBrain now has two integration surfaces:

- `OpenClaw plugin`
- `agent-agnostic CLI` for shared memory across Codex, Claude, and other runtimes

**Before every response (`before_prompt_build`)**
- Classifies the incoming query: temporal / episodic / procedural / personal / factual
- Injects relevant memory into the system prompt:
  - durable constraints that match the current task
  - proven procedures for recurring operational work
  - same-day continuity from `ACTIVE.md` and `open-loops.md`
  - **L0** — HOT_CACHE.md: top-ranked durable memories, loaded first as the cache-friendly stable prefix
  - **L1** — MIND.md keyword search: entries that match query terms
  - optional semantic recall via `memsearch` when installed, but only when local retrieval looks weak enough to justify the extra latency/cost
  - **L2** — Session archive search: recent sessions that match query terms
  - drift and compensation memory only when the current turn shows coherence/drift risk
- Temporal queries skip memory injection and defer to web search instead

**After every turn (`agent_end`)**
- Updates same-day continuity files (`ACTIVE.md` and `open-loops.md`)
- Captures explicit user constraints into a durable constraint store
- Captures reusable successful workflows into a proven-procedure store
- Writes cheap candidate memories for later promotion
- Runs a selective coherence check on higher-risk main-agent replies
- Schedules a curation run after a configurable period of inactivity (default 10 min)
- Optionally posts token usage to a cost webhook

**Curation pipeline** (runs after session goes idle)
- Sends the session transcript to a reasoning model (DeepSeek R1 or Sonnet)
- Extracts: facts, decisions, reasoning moves, abstract patterns, contradictions
- Routes outputs to MEMORY.md (working memory) or MIND.md (long-term)
- Writes a session index entry for L2 retrieval
- Runs decay, rebuilds HOT_CACHE, self-heals scaffolding

---

## Memory architecture

```
memory/
  private/<runtime>/<agent>/ — runtime-private continuity, candidate staging, and durable memory
  shared/                    — explicit cross-LLM artifacts only
  events.jsonl               — append-only memory event log
  legacy `memory/` files are still read for compatibility, but new writes land in the private/shared layout above
```

**Memory types:** `semantic`, `episodic`, `procedural`, `cognitive`, `emotional`, `metamemory`, `prospective`, `spatial`, `pattern`, `reasoning_pattern`, `discovered_pattern`, `outcome_lesson`, `conceptual_model`, `cognitive_pattern`, `emotional_pattern`, `transfer_hypothesis`, `drift_signal`, `compensation`, `constraint`, `proven_procedure`

OpenBrain can learn from:
- user-provided facts and decisions
- assistant-generated reasoning patterns and outcome lessons
- investigation/tool results that uncover durable facts or patterns
- repeated drift/coherence failures and the interventions that restore coherence

OpenBrain also preserves operating state independently of transcript history:
- `HANDOFF.md` is a compact operator handoff, not a transcript replay
- `state-transfer.json` is the structured source of truth for state transfer
- this is intended to survive both session transitions and transcript compaction

Retrieval is intentionally layered for caching efficiency:
- `HOT_CACHE.md` is the most cache-friendly prefix and should remain small and durable
- `STABLE_CONTEXT.md`, constraints, and procedures are still stable or semi-stable layers
- `HANDOFF.md`, `ACTIVE.md`, and `open-loops.md` are volatile continuity, not stable prefix
- volatile layers are useful, but they should not dominate every prompt

Handoff quality can be checked locally with:
- `npm run eval:handoff -- --workspace /path/to/workspace`
- `npm run eval:handoff -- --workspace /path/to/workspace --platform claude`

**Decay half-lives:** cognitive/procedural → permanent · semantic/emotional → 180d · episodic → 60d · metamemory/prospective → 14d

**Patterns** are a special type: the curator strips domain-specific detail and stores the abstract reasoning move, surface examples across domains, and documented failure cases.

---

## Requirements

- [OpenClaw](https://github.com/openclaw) with plugin support
- Node.js 18+
- An Anthropic API key (for eval and curation fallback)
- **Recommended:** a DeepSeek API key (R1 is used for curation when available — significantly better reasoning)
- **Optional:** [memsearch](https://github.com/openclaw/memsearch) for semantic search over `memory/` including `MIND.md`, `drift-patterns.md`, and `compensation-strategies.md`

---

## Installation

Copy the plugin directory into your OpenClaw extensions folder:

```bash
git clone https://github.com/epicurean-digital/openbrain ~/.openclaw/extensions/openbrain
```

Then register it in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openbrain"],
    "installs": {
      "openbrain": {
        "source": "path",
        "sourcePath": "/home/yourname/.openclaw/extensions/openbrain",
        "installPath": "/home/yourname/.openclaw/extensions/openbrain",
        "version": "0.1.0",
        "installedAt": "2026-01-01T00:00:00.000Z"
      }
    }
  }
}
```

### Shared-memory CLI

You can also use OpenBrain outside OpenClaw:

```bash
cd /path/to/openbrain
node cli.js recall --workspace /path/to/shared-workspace --query "What do we already know about this?"
node cli.js ingest --workspace /path/to/shared-workspace --session-id codex-123 --source-platform codex --transcript-file transcript.json
```

The CLI keeps:

- private runtime memory in `memory/private/<platform>/<agent>/`
- explicit shared artifacts in `memory/shared/`
- legacy `memory/hosts/<platform>/` files are read as a compatibility fallback only

That means `Codex`, `Claude`, and `OpenClaw` can keep their own runtime state separate while only explicitly promoted artifacts are exposed across runtimes.

### Codex adapter

Codex now has two usable integration surfaces for OpenBrain:

- `hooks` for automatic recall and post-session learning
- `MCP` for on-demand memory lookup during a live session

The lower-level file adapter still exists for direct session parsing and debugging.

Commands:

```bash
cd /path/to/openbrain

node scripts/codex-adapter.js recall \
  --workspace /path/to/shared-workspace \
  --query "What do we already know about this project?" \
  --json

node scripts/codex-adapter.js extract-session --latest --json

node scripts/codex-adapter.js ingest-session \
  --workspace /path/to/shared-workspace \
  --latest \
  --json
```

The adapter reads Codex rollout files from:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

and converts them into OpenBrain messages:

- `user` / `assistant` messages from Codex response items
- `toolResult` messages from function call outputs

This gives Codex access to the same durable memory store while keeping volatile state under:

```text
memory/private/codex/codex-tui/
```

### Codex hooks

For native Codex memory behavior, register OpenBrain through `~/.codex/hooks.json`.

OpenBrain ships hook entrypoints for:

- `UserPromptSubmit`
- `PostToolUse`
- `Stop`

The first one injects Codex-private memory first, then explicit shared artifacts, as `additionalContext`. `PostToolUse` does lightweight incremental ingest during long sessions. `Stop` ingests the finished Codex session and kicks off candidate curation.

Example `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/cizambra/workspace/openbrain/scripts/codex-hooks.js userpromptsubmit",
            "async": false
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/cizambra/workspace/openbrain/scripts/codex-hooks.js posttooluse",
            "async": false
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/cizambra/workspace/openbrain/scripts/codex-hooks.js stop",
            "async": true
          }
        ]
      }
    ]
  }
}
```

Required env:

```bash
export OPENBRAIN_WORKSPACE=/path/to/shared-workspace
```

The hook scripts read Codex hook payloads from `stdin` and use the same private-first/shared-explicit memory contract as the CLI and MCP server.

`PostToolUse` is intentionally cheap:

- it only refreshes memory when the Codex session file has changed
- it updates private Codex continuity and candidate staging
- it does not run the heavy curator

### Claude Code hooks

Claude Code can use the same OpenBrain workspace through native hooks, but its private runtime state stays under `memory/private/claude/claude-code/` and only explicit shared artifacts are read from `memory/shared/`.

Recommended events:

- `SessionStart` for broad ambient context
- `UserPromptSubmit` for prompt-aware recall
- `PostToolBatch` for lightweight incremental ingest
- `Stop` for final ingest and curator kickoff

Claude transcript files already contain enough structure for OpenBrain to normalize:

- user messages
- assistant text
- tool uses and tool results

OpenBrain writes Claude private volatile state under:

```text
memory/private/claude/claude-code/
```

and only surfaces explicit shared artifacts in `memory/shared/`.

Example Claude hook config:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/cizambra/workspace/openbrain/scripts/claude-hooks.js sessionstart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/cizambra/workspace/openbrain/scripts/claude-hooks.js userpromptsubmit"
          }
        ]
      }
    ],
    "PostToolBatch": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/cizambra/workspace/openbrain/scripts/claude-hooks.js posttoolbatch"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/cizambra/workspace/openbrain/scripts/claude-hooks.js stop"
          }
        ]
      }
    ]
  }
}
```

Required env:

```bash
export OPENBRAIN_WORKSPACE=/path/to/shared-workspace
```

If you do not set it, the hook runner defaults to:

```text
/home/cizambra/.openclaw/workspace
```

That keeps long sessions memoryful without paying the full curation cost on every tool call.

### Codex MCP server

For interactive Codex use, the better integration surface is MCP. OpenBrain ships a stdio MCP server that exposes shared-memory tools directly inside Codex.

Run it manually:

```bash
cd /path/to/openbrain
OPENBRAIN_WORKSPACE=/path/to/shared-workspace node scripts/mcp-server.js
```

Recommended Codex registration:

```bash
codex mcp add openbrain \
  --env OPENBRAIN_WORKSPACE=/path/to/shared-workspace \
  -- node /path/to/openbrain/scripts/mcp-server.js
```

It exposes:

- `openbrain_recall`
- `openbrain_ingest_codex_session`

This covers:

- `on-demand` memory lookup from inside Codex
- `ambient` memory access from Codex-private runtime memory first, with explicit shared artifacts available when promoted

Volatile Codex continuity now remains runtime-scoped under `memory/private/codex/codex-tui/`.

### Hard ambient Codex launcher

If you want memory injected up front instead of only being available as a tool, use the hard-ambient launcher:

```bash
cd /path/to/openbrain
node scripts/codex-with-openbrain.js --prompt "Fix the routing bug"
```

What it does:

1. recalls Codex-private memory before Codex starts
2. prepends private context plus explicit shared artifacts to the initial Codex prompt
3. launches Codex normally
4. ingests the resulting Codex session on exit
5. runs `curator.js --candidates` by default

Examples:

```bash
node scripts/codex-with-openbrain.js --prompt "Continue the newsletter frontsite refactor"
node scripts/codex-with-openbrain.js --resume-last --prompt "Pick up where we left off"
node scripts/codex-with-openbrain.js --query "current project context for /home/cizambra/workspace/openbrain"
node scripts/codex-with-openbrain.js --prompt "Quick investigation" --no-curate
```

This remains useful when you want guaranteed startup preload even outside the hook flow.

### Continuous Codex ingest + curation

If you want OpenBrain to keep learning while you chat with Codex, run the session watcher:

```bash
cd /path/to/openbrain
node scripts/codex-session-watcher.js
```

What it does:

- watches `~/.codex/sessions/`
- detects changed rollout files
- re-ingests updated Codex sessions into OpenBrain
- periodically runs `curator.js --candidates`

Useful options:

```bash
node scripts/codex-session-watcher.js --interval-seconds 15 --curate-minutes 5
node scripts/codex-session-watcher.js --once
node scripts/codex-session-watcher.js --no-curate
```

Recommended model for Codex:

1. Start the watcher in one terminal.
2. Use the MCP server for `openbrain_recall` during live work.
3. Use the hard-ambient launcher when you want startup preload as well.

This gives you:

- proactive memory availability through MCP
- startup ambient preload through the launcher
- continuous post-hoc ingest and periodic curation through the watcher

---

## Configuration

Add to `plugins.entries` in `openclaw.json`:

```json
"openbrain": {
  "enabled": true,
  "config": {
    "workspace": "/home/yourname/.openclaw/workspace",

    "curator": {
      "model": "your-model-id",
      "provider": "your-provider"
    },
    "eval": {
      "model": "your-model-id",
      "provider": "your-provider"
    },
    "coherenceCheck": {
      "enabled": true,
      "model": "your-model-id",
      "provider": "your-provider",
      "minChars": 280
    },

    "personalTerms": ["your-project", "your-name"],

    "curationDebounceMinutes": 10,
    "hotCacheSize": 25,
    "curateSubagents": false,
    "activeMemory": {
      "enabled": true,
      "maxChars": 900
    },
    "stableContext": {
      "enabled": true,
      "maxChars": 700
    },
    "constraints": {
      "maxChars": 700
    },
    "procedures": {
      "maxChars": 800
    },
    "openLoops": {
      "maxChars": 700
    },
    "retrieval": {
      "totalMaxChars": 2200
    },
    "memsearch": {
      "enabled": true,
      "maxChars": 900
    },
    "autoscale": {
      "enabled": true,
      "clarificationTurns": 2,
      "correctionTurns": 1
    },
    "telemetry": {
      "enabled": true,
      "writeJsonl": true,
      "webhook": null
    }
  }
}
```

### Config reference

| Key | Default | Description |
|-----|---------|-------------|
| `workspace` | `~/.openclaw/workspace` | Root directory for all memory files |
| `curator.model` | `claude-sonnet-4-6` | Model used for curation — any capable model; reasoning models recommended |
| `curator.provider` | `anthropic` | Any provider configured in OpenClaw |
| `eval.model` | `claude-haiku-4-5-20251001` | Model used for self-eval — a fast, cheap model is ideal |
| `eval.provider` | `anthropic` | Any provider configured in OpenClaw |
| `coherenceCheck.enabled` | `true` | Run a selective post-response coherence check on higher-risk main-agent replies |
| `coherenceCheck.model` | `eval.model` | Model used for selective coherence checks |
| `coherenceCheck.provider` | `eval.provider` | Provider used for selective coherence checks |
| `coherenceCheck.minChars` | `280` | Minimum assistant response size before a coherence check is considered |
| `personalTerms` | `[]` | Terms that trigger personal/episodic retrieval — add your project names, people, etc. |
| `curationDebounceMinutes` | `10` | Minutes of inactivity before curation fires |
| `hotCacheSize` | `25` | Number of entries in HOT_CACHE.md |
| `curateSubagents` | `false` | Curate sub-agent sessions immediately; off by default for cost control |
| `activeMemory.enabled` | `true` | Enable same-day active frame retrieval from `ACTIVE.md` |
| `activeMemory.maxChars` | `900` | Max chars injected from `ACTIVE.md` |
| `stableContext.enabled` | `true` | Enable optional stable-prefix retrieval from `memory/STABLE_CONTEXT.md` |
| `stableContext.maxChars` | `700` | Max chars injected from `memory/STABLE_CONTEXT.md` |
| `constraints.maxChars` | `700` | Max chars injected from durable scoped constraints |
| `procedures.maxChars` | `800` | Max chars injected from proven procedures |
| `openLoops.maxChars` | `700` | Max chars injected from `open-loops.md` |
| `retrieval.totalMaxChars` | `2200` | Max total chars injected by OpenBrain per prompt |
| `memsearch.enabled` | `true` | If memsearch is installed locally, use it selectively for semantic recall when local retrieval is weak; no-op if unavailable |
| `memsearch.maxChars` | `900` | Max chars injected from memsearch results |
| `autoscale.enabled` | `true` | Enable correction/clarification loop tracking for escalation recommendations |
| `autoscale.clarificationTurns` | `2` | Clarification turns in a session before recommending escalation |
| `autoscale.correctionTurns` | `1` | User correction turns before recommending escalation |
| `telemetry.enabled` | `true` | Emit generic OpenBrain telemetry events |
| `telemetry.writeJsonl` | `true` | Write JSONL telemetry to `memory/telemetry/YYYY-MM-DD.jsonl` |
| `telemetry.webhook` | `null` | Optional generic telemetry webhook for Quorum or any other consumer |

## Manual eval logging

Quorum can summarize `eval.result` events even without a full runner. OpenBrain includes a small helper so you can record manual eval outcomes into the same telemetry stream:

```bash
node scripts/log-eval.js \
  --eval-id EVAL-SF-001 \
  --kind stable_fact_recall \
  --status pass \
  --model anthropic/claude-sonnet-4-6 \
  --session-id example-session \
  --turns 1 \
  --notes "Returned correct Windows-mounted vault path from stable facts."
```

The helper:
- writes to `memory/telemetry/YYYY-MM-DD.jsonl`
- posts to `telemetry.webhook` if configured
- lets Quorum aggregate eval pass/fail trends immediately

## LongMemEval preparation runner

OpenBrain includes a lightweight LongMemEval harness that prepares one benchmark item into an isolated workspace by replaying its haystack sessions through the curator. This is the cleanest way to test memory ingestion and retrieval without contaminating your real workspace.

Run it like this:

```bash
cd /home/cizambra/workspace/openbrain
npm run longmemeval -- \
  --dataset /path/to/longmemeval_s_cleaned.json \
  --index 0 \
  --clean
```

What it does:
- creates a dedicated workspace for that benchmark item
- ingests each haystack session in chronological order through `scripts/curator.js`
- writes `benchmark-packet.json` with:
  - the isolated workspace path
  - the final question
  - the expected answer

Then ask the benchmark question against that isolated workspace:

```bash
OPENBRAIN_WORKSPACE=/path/to/prepared/workspace
```

If you want to grade a candidate answer immediately:

```bash
npm run longmemeval -- \
  --dataset /path/to/longmemeval_s_cleaned.json \
  --index 0 \
  --answer "your answer here"
```

And if you want that result logged into OpenBrain telemetry:

```bash
npm run longmemeval -- \
  --dataset /path/to/longmemeval_s_cleaned.json \
  --index 0 \
  --answer "your answer here" \
  --log
```

Recommended workflow:
- start with `longmemeval_oracle.json` to validate answer quality when retrieval scope is already narrowed
- then move to `longmemeval_s_cleaned.json` to test actual long-memory retrieval
- keep each benchmark item in its own isolated workspace

## Manual coherence logging

Use the CDT questionnaire with `log-coherence.js` to record scored reviews:

```bash
node scripts/log-coherence.js \
  --eval-id EVAL-CC-001 \
  --overall-score 25 \
  --model anthropic/claude-sonnet-4-6 \
  --session-id eval-cc-001 \
  --constraint 1,1,1,1 \
  --detection 2,2,2,2 \
  --regulation 2,2,2,2 \
  --return-score 3,3,3,3 \
  --action-truth 4,4,4,4 \
  --hard-fails constraint_violated,bad_artifact_repeated \
  --diagnostics constraint,detection,regulation \
  --notes "Repeated a violating recommendation from a prior artifact instead of correcting it."
```

This emits `coherence.rated` so Quorum can track average coherence score and hard-fail frequency.

## Cache-aware retrieval

OpenBrain now shapes retrieval for context caching rather than only for recall:

- `memory/STABLE_CONTEXT.md` is an optional stable-prefix file for long-lived instructions or operator context.
- Retrieval is emitted in volatility order: stable -> semi-stable -> volatile.
- Telemetry includes per-tier chars and a `cache_friendly` flag so Quorum can show whether retrieval is likely preserving cache locality.

## Autoscale policy

OpenBrain now tracks cheap-model failure tax as a control loop:

- `model.failure_tax` fires when the user is correcting a bad answer.
- `model.escalation_recommended` fires when a session crosses the configured clarification/correction threshold.
- The next prompt gets a routing note recommending escalation to Sonnet or DeepSeek instead of continuing to burn turns on the cheap path.
| `costWebhook` | `null` | Optional HTTP endpoint to POST token usage after each turn |

### API keys

OpenBrain reads API keys from environment variables or your OpenClaw config — nothing is hardcoded:

```bash
# Environment variables (highest priority)
export ANTHROPIC_API_KEY=sk-ant-...
export DEEPSEEK_API_KEY=sk-...
```

Or store them in `~/.openclaw/openclaw.json` under `models.providers.deepseek.apiKey` / the standard Anthropic auth profile — OpenBrain will find them automatically.

---

## Curator models

The curation step is where most of the intelligence lives. Model choice matters:

| Model | Quality | Speed | Cost |
|-------|---------|-------|------|
| DeepSeek R1 (`deepseek-reasoner`) | Best — extended reasoning, strong abstraction | Slow | Low |
| Claude Sonnet 4.6 | Good — fast, reliable | Fast | Medium |
| Claude Haiku 4.5 | Adequate for short sessions | Very fast | Very low |

DeepSeek R1 is the default when a DeepSeek key is present. Its chain-of-thought reasoning trace is written to `WORKINGS.md` for debugging.

---

## Running scripts manually

All scripts under `scripts/` can be run standalone:

```bash
# Curate a specific session
OPENBRAIN_WORKSPACE=~/.openclaw/workspace node scripts/curator.js --date 2026-03-30

# Pipe a transcript directly
cat transcript.txt | OPENBRAIN_WORKSPACE=~/.openclaw/workspace node scripts/curator.js

# Rebuild HOT_CACHE from current MIND.md
OPENBRAIN_WORKSPACE=~/.openclaw/workspace node scripts/hot-cache.js

# Apply decay pass
OPENBRAIN_WORKSPACE=~/.openclaw/workspace node scripts/decay.js

# Selective coherence-check payload
echo '{"question":"...","response":"...","activeContext":"..."}' | node scripts/coherence-check.js

# Backfill candidate memories from recent OpenClaw session history
OPENBRAIN_WORKSPACE=~/.openclaw/workspace node scripts/backfill-candidates.js --days 14 --limit 40
```

---

## License

MIT
