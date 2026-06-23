# Claude OpenBrain Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend OpenBrain so Claude Code can use shared ambient memory and continuously ingest session learning through native hooks.

**Architecture:** Reuse the existing shared-memory core and Codex hook pattern. Add a Claude transcript normalizer, a Claude hook runner for `SessionStart`, `UserPromptSubmit`, `PostToolBatch`, and `Stop`, and register those hooks in Claude’s global settings so Claude writes to `memory/hosts/claude/` while sharing long-term memory with Codex and OpenClaw.

**Tech Stack:** Node.js ESM, Claude Code hooks, OpenBrain core (`ingestMessages`, `recallForSource`)

---

### Task 1: Add Claude transcript parsing

**Files:**
- Create: `scripts/shared/claude-session.js`

- [ ] Parse Claude JSONL sessions into the common OpenBrain message envelope
- [ ] Capture user text, assistant text, and tool results
- [ ] Preserve session id and transcript path metadata

### Task 2: Add Claude hook runner

**Files:**
- Create: `scripts/claude-hooks.js`
- Modify: `package.json`

- [ ] Implement `sessionstart` ambient recall
- [ ] Implement `userpromptsubmit` prompt-aware recall
- [ ] Implement `posttoolbatch` lightweight incremental ingest
- [ ] Implement `stop` final ingest and curator kickoff
- [ ] Add package scripts for the Claude hook commands

### Task 3: Register Claude hooks and document usage

**Files:**
- Modify: `README.md`
- Modify: `/home/cizambra/.claude/settings.json`

- [ ] Document Claude integration alongside the existing Codex section
- [ ] Add global Claude hook configuration for the four events

### Task 4: Verify end to end locally

**Files:**
- None

- [ ] Run syntax checks on new scripts
- [ ] Exercise hook commands with synthetic payloads
- [ ] Confirm parser works against a real local Claude transcript

