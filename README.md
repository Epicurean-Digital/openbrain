# OpenBrain

Persistent memory, cross-session pattern learning, and context retrieval for [OpenClaw](https://github.com/openclaw) agents.

OpenBrain gives your agent a brain that compounds over time. After each session it extracts facts, decisions, and reasoning patterns, stores them in a structured long-term memory, and retrieves the most relevant context automatically before every response.

---

## What it does

**Before every response (`before_prompt_build`)**
- Classifies the incoming query: temporal / episodic / procedural / personal / factual
- Injects relevant memory into the system prompt:
  - **L0** — HOT_CACHE.md: top-25 entries by confidence × recency, always loaded
  - **L1** — MIND.md keyword search: entries that match query terms
  - **L2** — Session archive search: recent sessions that match query terms
- Temporal queries skip memory injection and defer to web search instead

**After every turn (`agent_end`)**
- Runs a lightweight self-eval pass (Haiku) to flag alignment or completeness issues
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
  MIND.md          — long-term memory: permanent facts, procedures, patterns
  HOT_CACHE.md     — top-N entries by score (L0 context, loaded every session)
  WORKINGS.md      — reasoning traces and self-eval flags (indexed, not loaded)
  sessions/        — session index files for L2 keyword retrieval
  archive/         — entries that decayed below threshold
  search-log-*.json — retrieval logs fed back to curator for reinforcement
```

**Memory types:** `semantic`, `episodic`, `procedural`, `cognitive`, `emotional`, `metamemory`, `prospective`, `spatial`, `pattern`

**Decay half-lives:** cognitive/procedural → permanent · semantic/emotional → 180d · episodic → 60d · metamemory/prospective → 14d

**Patterns** are a special type: the curator strips domain-specific detail and stores the abstract reasoning move, surface examples across domains, and documented failure cases.

---

## Requirements

- [OpenClaw](https://github.com/openclaw) with plugin support
- Node.js 18+
- An Anthropic API key (for eval and curation fallback)
- **Recommended:** a DeepSeek API key (R1 is used for curation when available — significantly better reasoning)
- **Optional:** [memsearch](https://github.com/openclaw/memsearch) for vector search over MIND.md

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
      "provider": "anthropic"
    },
    "eval": {
      "model": "your-model-id",
      "provider": "anthropic"
    },

    "personalTerms": ["your-project", "your-name"],

    "curationDebounceMinutes": 10,
    "hotCacheSize": 25
  }
}
```

### Config reference

| Key | Default | Description |
|-----|---------|-------------|
| `workspace` | `~/.openclaw/workspace` | Root directory for all memory files |
| `curator.model` | `claude-sonnet-4-6` | Model used for curation — any capable model; reasoning models recommended |
| `curator.provider` | `anthropic` | `anthropic` or `deepseek` |
| `eval.model` | `claude-haiku-4-5-20251001` | Model used for self-eval — a fast, cheap model is ideal |
| `eval.provider` | `anthropic` | `anthropic` or `deepseek` |
| `personalTerms` | `[]` | Terms that trigger personal/episodic retrieval — add your project names, people, etc. |
| `curationDebounceMinutes` | `10` | Minutes of inactivity before curation fires |
| `hotCacheSize` | `25` | Number of entries in HOT_CACHE.md |
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

# Self-eval a response
echo "question|||response" | node scripts/eval.js
```

---

## License

MIT
