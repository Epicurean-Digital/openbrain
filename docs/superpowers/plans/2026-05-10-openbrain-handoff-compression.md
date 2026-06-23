# OpenBrain Handoff Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `HANDOFF.md` materially smaller and less redundant so OpenBrain's volatile recall layer stays useful without undermining prompt caching.

**Architecture:** Keep the existing continuity model and `state-transfer.json` payload, but change the human-readable `HANDOFF.md` materialization to be a compact operator handoff instead of a near-verbatim replay of the last exchange. Reduce duplication between objective/next-step/request/summary fields, cap list sizes and line lengths more aggressively, and normalize continuation-style prompts into compact summaries.

**Tech Stack:** Node.js ESM, OpenBrain continuity pipeline

---

### Task 1: Identify compression targets in handoff generation

**Files:**
- Modify: `index.js`

- [ ] Confirm which `buildStateTransfer()` fields are duplicative in real artifacts
- [ ] Preserve JSON durability while allowing tighter Markdown handoff output
- [ ] Define a compact handoff shape that favors operator usefulness over exhaustive replay

### Task 2: Tighten state-transfer summarization and handoff materialization

**Files:**
- Modify: `index.js`

- [ ] Add helpers to normalize continuation boilerplate and compress long exchange summaries
- [ ] Cap list counts and line lengths more aggressively for `HANDOFF.md`
- [ ] Remove redundant verbose sections from Markdown handoff while keeping the most actionable context
- [ ] Keep `state-transfer.json` intact enough for downstream logic

### Task 3: Verify artifact size and recall behavior

**Files:**
- Modify: `README.md` if behavior changes need documentation

- [ ] Run syntax checks
- [ ] Regenerate a real handoff artifact in a temp workspace
- [ ] Compare byte size before vs after on a real workspace sample
- [ ] Verify recall still returns useful volatile continuity
