# OpenBrain Recall Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenBrain’s recall path more cache-friendly by promoting `HOT_CACHE.md` to the real L0 stable layer, isolating `HANDOFF.md` as volatile memory, and lowering default hook budgets.

**Architecture:** Keep the existing retrieval pipeline and layer model, but change which files populate the stable prefix and how tiers are assigned. Then update the default recall budgets across CLI and hook integrations so repeated prompts reuse a smaller, more stable prefix while still allowing volatile context when needed.

**Tech Stack:** Node.js ESM, OpenBrain core retrieval pipeline

---

### Task 1: Rework retrieval layering

**Files:**
- Modify: `index.js`

- [ ] Load `memory/HOT_CACHE.md` as the first stable retrieval layer
- [ ] Keep `STABLE_CONTEXT.md` / stable facts as supporting stable context, not the sole L0
- [ ] Re-tier `State handoff` from `stable` to `volatile`
- [ ] Keep constraints and procedures in stable / semi-stable tiers

### Task 2: Tighten default recall budgets

**Files:**
- Modify: `cli.js`
- Modify: `scripts/codex-adapter.js`
- Modify: `scripts/codex-with-openbrain.js`
- Modify: `scripts/codex-hooks.js`
- Modify: `scripts/mcp-server.js`
- Modify: `scripts/claude-hooks.js`
- Modify: `index.js`

- [ ] Lower startup-oriented budgets
- [ ] Lower prompt-submit defaults slightly
- [ ] Keep memsearch disabled by default
- [ ] Preserve current behavior shape while reducing injected text size

### Task 3: Document and verify cache-oriented behavior

**Files:**
- Modify: `README.md`

- [ ] Document that `HOT_CACHE.md` is the real L0 prefix
- [ ] Document that `HANDOFF.md` is volatile continuity, not stable prefix
- [ ] Verify retrieval output shape and tier hashes still work

