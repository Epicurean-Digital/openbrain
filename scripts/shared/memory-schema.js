export function normalizeMemoryObject(input = {}, defaults = {}) {
  const merged = {
    ...defaults,
    ...input,
  };
  const now = new Date().toISOString();

  return {
    ...merged,
    id: merged.id || `${merged.type || "memory"}:${Date.now()}`,
    type: merged.type || "candidate",
    scope: merged.scope || "global",
    owner_runtime: merged.owner_runtime || "unknown",
    owner_agent: merged.owner_agent || "unknown",
    share_policy: merged.share_policy || "private",
    visibility: merged.visibility || "local",
    confidence: merged.confidence ?? 0.5,
    reinforcement_count: merged.reinforcement_count ?? 1,
    decay_mode: merged.decay_mode || "slow",
    source_refs: Array.isArray(merged.source_refs) ? merged.source_refs : [],
    created_at: merged.created_at || now,
    updated_at: merged.updated_at || now,
  };
}
