# AGENTS.md

## Long-Term Memory
When a topic arises that feels like it has history — projects, people, decisions, patterns, drift signals, or compensation strategies — query the memory folder via memsearch before responding:
```
/home/cizambra/.memsearch-venv/bin/memsearch search "<topic>" --provider local
```

## Memory Search
When querying long-term memory, use the instrumented wrapper (logs retrievals for reinforcement):
```
node /home/cizambra/workspace/openbrain/scripts/search-wrapper.js search "<topic>" --provider local
```

## Hot Cache (L0 Context)
At the start of each session, read memory/HOT_CACHE.md — it contains your most relevant long-term knowledge, pre-ranked by confidence and recency. This is your baseline context before any query.
