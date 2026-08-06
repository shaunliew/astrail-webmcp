# Handoff template — `docs/deploy/YYYY-MM-DD-<topic>-handoff.md`

Distilled from the four handoffs that already worked (entitlements deploy + go-live, account-deletion
backend, launch legal precautions). Copy the skeleton, delete what does not apply, **keep the shape**:
the receiving owner should be able to act without asking a single question, and without reading the
diff.

The one rule that makes a handoff worth writing: **state what is TRUE now, not what is intended.**
"Deployed dark, gated OFF, migrations applied to prod, verified 2026-08-05" is a handoff. "Deletion is
done" is a rumour.

---

```markdown
# <Feature> — <backend|frontend|deploy> handoff (YYYY-MM-DD)

> One paragraph: what is merged, what is deployed, what is gated OFF, and what the reader must do.
> Name the receiving owner in the first sentence. If the reader does nothing, what happens?

## State at a glance

| Thing | State |
|---|---|
| Code | merged to `dev` at `<sha>` / on branch `<x>`, unpushed |
| Migrations | `<file>` applied to prod ✅ / written, NOT applied ⬜ |
| Backend | deployed, gated OFF (`FLAG=False`) |
| Frontend | not started / built behind `NEXT_PUBLIC_X` |
| User-visible | **nothing** / <what a user sees today> |

## Your lane — what blocks the gate

Numbered, each one actionable alone, each with the file and the fix. Mark 🔒 for anything the writer
cannot do (needs the other owner's surface or credentials). If there are none, say "nothing blocks —
this is FYI" so the reader stops reading.

1. **F1 — <one-line defect>.** `<file:symbol>` — <what goes wrong, concretely>. Fix: <the change>.

## Verification performed

Evidence, not adjectives. Commands run + what they returned. State the **coverage boundary** —
what you did NOT verify is the most useful line in the doc, because the reader will otherwise assume
you did. Baselines the reader must hold (test counts, eval anchors, latency) go here.

## Deploy order

The golden order for this change specifically, with owners. Call out any step where code-before-schema
(or the reverse) breaks — and whether `autoDeployTrigger` needs to be `off` for it.

## Rollback

What restores the previous state, per tier, and what is forward-only. If rollback is non-atomic
(e.g. Blueprint + dashboard), say both places.

## Deferred — deliberately NOT fixed here

Each with a concrete trigger for when it comes back. An undocumented deferral reads as an oversight to
the next person; a triggered one reads as a decision.

## References

Plan, review reports, PR, EMDEE docs, prior handoffs this supersedes.
```

---

## After writing it

1. Commit it with the arc (`docs(deploy): …`), stage explicit paths.
2. Hand **Codex** the GitHub Project #1 card update — Codex owns board mutations.
3. Tell the other owner it exists and what decision you need from them. The doc is the artifact; the
   message is just the pointer.
4. When the blockers clear, **update the doc in place** — a stale handoff is worse than none, because
   the next reader trusts it.
