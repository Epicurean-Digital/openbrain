# OpenBrain Redesign Spec

## Goal
Redesign OpenBrain into a file-first memory system that supports:

1. Long-term memory across sessions.
2. Decision, belief, and lesson extraction from memory.
3. Learning from outcomes so future decisions improve.
4. Controlled decay so memory stays useful instead of accumulating noise.
5. Private per-agent memory with selective sharing across LLM runtimes.

The target operating model is:

- private memory inside each agent runtime
- shared memory only for explicitly promoted artifacts between Codex and Claude
- the current OpenBrain repo remains the implementation base

## Context

The current OpenBrain codebase already has the right primitive surfaces:

- retrieval injection in `index.js`
- curation in `scripts/curator.js`
- decay in `scripts/decay.js`
- hot-cache ranking in `scripts/hot-cache.js`
- Codex and Claude hooks / adapters

The redesign should not replace these primitives with a database-first rewrite. Instead, it should formalize the memory lifecycle and separate:

- raw event capture
- consolidation
- derived views
- retrieval
- reinforcement
- decay
- selective sharing

## Principles

1. File-first is the source of truth.
2. Derived views must be rebuildable from source events.
3. Memory should be scoped by runtime and agent unless explicitly shared.
4. Only memory that has proven utility should be promoted.
5. Forgetting is a feature, not a bug.
6. Provenance must be preserved on every durable memory object.
7. Cross-LLM sharing must be explicit and auditable.

## Non-goals

- No database-backed source of truth in v1.
- No global shared memory by default.
- No weight updates or fine-tuning.
- No fully automatic cross-agent promotion without policy gates.
- No attempt to store every transcript line as durable memory.

## Architecture Overview

OpenBrain v1 becomes a memory fabric with two namespaces:

### 1. Private namespace

Each runtime and agent gets its own private memory path:

- session state
- local open loops
- local handoff state
- local hot cache
- private observations
- private procedure candidates
- private lessons

Private memory is used for within-agent continuity and does not leak to other runtimes unless promoted.

### 2. Shared namespace

A shared namespace stores only explicitly promoted artifacts that can be useful across Codex and Claude:

- durable facts
- stable constraints
- reusable procedures
- decisions with lasting impact
- lessons / outcome summaries
- reusable beliefs that are relevant to multiple runtimes

Shared memory is still file-based, but it is separate from private memory and governed by stricter promotion rules.

## Memory Object Model

OpenBrain should treat memory as typed objects rather than as undifferentiated text.

### Core object types

- `event`: raw interaction, tool result, or session artifact with provenance
- `episode`: a bounded interaction segment with time and scope
- `fact`: durable claim with source and confidence
- `constraint`: rule that should influence future behavior
- `procedure`: reusable action pattern with preconditions and success signals
- `decision`: a choice made by the agent, plus rationale and evidence
- `outcome`: result of a decision or action
- `lesson`: generalized learning from one or more outcomes
- `belief`: decision-relevant judgment with confidence and revision history
- `drift_signal`: recurring failure mode or coherence risk
- `compensation`: the intervention that corrects a drift signal
- `candidate`: provisional memory staged for later validation

### Required metadata

Every durable memory object should include:

- `id`
- `type`
- `scope`
- `owner_runtime`
- `owner_agent`
- `share_policy`
- `created_at`
- `updated_at`
- `source_refs`
- `confidence`
- `reinforcement_count`
- `decay_mode`
- `visibility`

### Sharing metadata

`share_policy` should be one of:

- `private`
- `shared_explicit`
- `shared_group`
- `blocked`

`visibility` should be one of:

- `local`
- `shared_codex`
- `shared_claude`
- `shared_cross_llm`

## Memory Lifecycle

The core loop is:

`observe -> extract -> validate -> store -> retrieve -> act -> score -> reinforce/revise -> decay -> consolidate`

### Observe

Capture session messages, tool results, outcomes, and explicit user constraints.

### Extract

Convert raw input into candidates for facts, decisions, procedures, beliefs, lessons, and drift signals.

### Validate

Reject unsupported, duplicate, low-value, or unsafe candidates.

### Store

Write durable objects to the appropriate namespace with provenance and scope.

### Retrieve

Bring back only the minimum relevant memory required for the current task.

### Act

Use retrieved memory to guide the agent’s decision-making.

### Score

Record whether the memory helped the outcome, was ignored, or caused misdirection.

### Reinforce / revise

Increase weight for useful memory, revise contradictory memory, and convert repeated patterns into procedures or beliefs.

### Decay

Reduce the prominence of stale or unhelpful memory.

### Consolidate

Merge repeated evidence into stronger facts, procedures, and lessons.

## Private vs Shared Memory Rules

### Private memory

Private memory is the default for each agent runtime.

It may contain:

- working context
- local preferences
- local decisions
- local open loops
- local session summaries
- local procedure candidates

It must not be visible to other runtimes unless promoted.

### Shared memory

Shared memory is only for content that survives promotion criteria:

- it is reusable
- it is not too context-specific
- it has enough confidence
- it has clear provenance
- it is not sensitive or transient

Shared memory is the only layer intended to bridge Codex and Claude.

### Promotion rule

Private memory may be promoted to shared memory when all are true:

- the memory has been reinforced at least once
- it has a clear durable use case
- it is not session-specific noise
- it passes any applicable safety or privacy filters
- it is explicitly marked promotable

## Decision and Belief Learning

OpenBrain should not stop at storing facts. It should extract decision-making substance.

### Decision extraction

For each meaningful decision, store:

- what was decided
- why it was decided
- what evidence supported it
- what alternatives were considered
- what tradeoff was accepted
- what outcome followed

### Belief extraction

A belief is a decision-relevant judgment that can change with evidence.

Beliefs should be formed when:

- the same judgment appears across multiple sessions
- the judgment repeatedly informs good decisions
- the judgment survives contradiction checks

Beliefs should change when:

- evidence contradicts them
- outcomes show they were harmful
- better procedures replace them

### Lesson extraction

Lessons should be derived from outcomes, not just from prose summaries.

A lesson should answer:

- what happened
- why it mattered
- what to do differently next time

## Retrieval Policy

Retrieval should remain layered, but the architecture should be explicit about which layers are private and which are shared.

### Retrieval order

1. Current task frame
2. Private volatile continuity
3. Shared durable memory
4. Private durable memory
5. Long-horizon session archive
6. Optional semantic search fallback when needed

### Retrieval constraints

- Do not inject raw history unless it is clearly useful.
- Prefer compact derived views over verbose transcripts.
- Prefer high-confidence memory over merely recent memory.
- Prefer memory with explicit provenance.
- Prefer agent-local memory before shared memory unless the task is cross-agent by nature.

### Query classes

The system should continue to distinguish:

- temporal
- episodic
- procedural
- personal
- factual

Temporal queries should still bias toward current external search rather than memory.

## Reinforcement Policy

Reinforcement should measure utility, not just frequency.

### Increase reinforcement when

- a memory is retrieved and directly improves a decision
- a memory prevents an error or contradiction
- a procedure is reused successfully
- a lesson improves later outcomes

### Decrease or quarantine memory when

- it is contradicted
- it repeatedly fails to help
- it is stale
- it is too specific to one episode
- it is sensitive or unsafe to retain

### Reinforcement signals

Useful signals include:

- retrieval success
- outcome success
- repeated reuse
- cross-session recurrence
- cross-agent usefulness

## Decay Policy

Decay must be type-aware.

### Decay dimensions

- `time_decay`: ordinary aging
- `utility_decay`: memory no longer helps
- `contradiction_decay`: memory has been disproven or superseded
- `safety_decay`: memory contains private, risky, or sensitive content

### Suggested behavior

- facts decay slowly if reinforced
- procedures decay slowly if reused
- beliefs decay if contradicted or unused
- lessons decay if no longer relevant
- session episodes decay faster than durable abstractions

Decay should never destroy source provenance. It should move memory to colder or archived states.

## Materialized Views

The system should keep derived views for fast retrieval and operator inspection.

### Private views

- `ACTIVE.md`
- `HANDOFF.md`
- private session archive
- private hot cache

### Shared views

- `MIND.md`
- `HOT_CACHE.md`
- `CONSTRAINTS.md`
- `PROCEDURES.md`

### Derived learning views

Future v1.1 views may include:

- `BELIEFS.md`
- `LESSONS.md`
- `DECISIONS.md`
- `DRIFT_PATTERNS.md`
- `COMPENSATION_STRATEGIES.md`

These should be materialized from source objects, not hand-edited as canonical truth.

## Cross-LLM Governance

The key policy choice is that Codex and Claude do not share everything.

### Within Codex

Codex agents may use selective private memory and may share only approved artifacts into the shared namespace.

### Between Codex and Claude

Only shared namespace objects are visible across runtimes.

### Governance requirements

- explicit promotion is required
- provenance must remain intact
- runtime ownership must be recorded
- shared artifacts must be reviewable in plain text
- conflicts must be representable without losing history

## Safety and Privacy

OpenBrain must be able to forget sensitive or risky memory.

### Safety requirements

- redact secrets before durable storage
- avoid sharing private workspace details unless explicitly needed
- allow hard deletion for sensitive artifacts
- ensure shared memory cannot silently reintroduce private content

### Privacy requirements

- the private namespace is never promoted automatically
- shared namespace promotion is opt-in
- memory should be scoped as narrowly as possible

## Observability

The system should expose enough telemetry to answer:

- what was retrieved
- what was promoted
- what was reinforced
- what decayed
- what was rejected
- what was shared across runtimes

This is important because the memory system itself will drift if it cannot be audited.

## Rollout Strategy

### Phase 1

Implement the architecture as a documentation and schema update on top of the current file-first stack.

### Phase 2

Refactor curation so it emits typed objects for private and shared namespaces.

### Phase 3

Add reinforcement and decay based on usefulness, contradiction, and reuse.

### Phase 4

Add explicit cross-LLM sharing controls and promotion gates.

### Phase 5

Optionally add a database or stronger index only if file-based rebuilds or concurrent writes become a bottleneck.

## Success Criteria

The redesign is successful if:

- the system can remember across sessions without relying on raw transcript replay
- decisions and beliefs can be extracted and reused
- useful memory becomes stronger over time
- stale or harmful memory decays
- private memory stays private by default
- shared memory between Codex and Claude is explicit and auditable
- the existing repo can still be inspected and regenerated from files

## Open Questions

1. Should shared memory be limited to a fixed allowlist of artifact types in v1, or should artifact type promotion be policy-driven?
2. Should beliefs be stored in a dedicated materialized file in v1, or inferred from facts, decisions, and lessons until usage proves the need for a separate file?
3. Should each runtime keep its own hot cache file, or should the shared namespace also have a shared hot cache derived from promoted memory?
