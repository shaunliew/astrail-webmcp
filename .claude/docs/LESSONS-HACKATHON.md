# Hard-Won Lessons from the Hackathon (do not regress)

> Extracted verbatim from `.claude/CLAUDE.md` on 2026-07-03 (backup:
> `.claude/backups/CLAUDE.md.2026-07-03.bak`). Read this BEFORE touching any file in
> `backend/agents/` or anything that calls the OpenAI Agents SDK.

- `ModelSettings(tool_choice="required", parallel_tool_calls=True)` on the extractor — without `required`, model skips WebSearchTool and hallucinates coords.
- `_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)` — typed fallback to `gpt-4o`. Apply to every agent.
- `output_type` must be a Pydantic model, not a bare list.
- Pydantic lat/lng bounds: `ge=-90, le=90` and `ge=-180, le=180` — catches hallucinated coords.
- `evidence_caption_quote` must be verbatim substring of `caption + locationName`. Drop if not.
- `WebSearchTool` calls appear as `ToolSearchCallItem`, not `ToolCallItem`. Match both class-name patterns.
- Apify MCP `client_session_timeout_seconds` default is 5s — always too short. Irrelevant now (using direct HTTP), but note if SDK ever returns.

## Adding new lessons

When a session discovers a new hard-won lesson about THIS codebase, append it here.
Harness/workflow lessons go to `~/.claude/playbook/LESSONS.md` instead — but only if that
playbook directory exists on your machine (it does on Zhi Hao's; on other machines, skip
that step). Append codebase lessons as a
single bullet: what breaks, the exact fix, one line each. Do not rewrite existing bullets.
