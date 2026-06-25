---
name: sprintplan
description: "Locks in a sprint plan for one person — writes to their EMDEE sprint doc AND updates the GitHub Projects board (MalaysiaKaki/astrail, project #1). Run this after a planning discussion to make the plan official in both places. Each person runs it for themselves. Zhi Hao owns issues #6, #12. Shaun owns #4, #5, #7, #8, #9, #10, #11."
user-invocable: true
argument-hint: '"sprint goal one-liner" [--author zhihao|shaun] [--sprint N] [--issues 6,12] [--status todo|in_progress]'
allowed-tools:
  - Read
  - Write
  - Bash
  - mcp__emdee__get_doc
  - mcp__emdee__patch_section
  - mcp__emdee__append_section
  - mcp__emdee__create_child
  - mcp__emdee__write_doc
---

# sprintplan: Sprint Planner for Astrail

Syncs a sprint plan to two places at once: the EMDEE vault (your personal sprint doc) and the GitHub Projects board. Run after a planning discussion, not during a mid-sprint update (use `/shiplog` for that).

Arguments received: $ARGUMENTS

---

## DEFAULTS

| Field | Zhi Hao default | Shaun default |
|---|---|---|
| Author | zhihao | shaun |
| My issues | #6, #12 | #4, #5, #7, #8, #9, #10, #11 |
| GitHub org | MalaysiaKaki | MalaysiaKaki |
| Project number | 1 | 1 |
| Sprint | 1 | 1 |

---

## Step 1: Parse Arguments

Extract:
- **Goal**: The sprint goal one-liner. Everything not a flag.
- **--author**: `zhihao` or `shaun`. Default: infer from `git config user.name` — names containing "Shaun/shaun" → shaun, else → zhihao.
- **--sprint**: Sprint number. Default: `1`.
- **--issues**: Comma-separated issue numbers to commit to this sprint. Default: author's full owned list.
- **--status**: `todo` or `in_progress`. Which GitHub status to set for the committed issues. Default: `in_progress`.

If goal is missing, ask: *"One sentence — what is the goal for this sprint?"*

---

## Step 2: Preflight — Check GitHub Auth Scope

Run:
```bash
gh auth status 2>&1
```

If output does NOT contain `project` in the token scopes:
- Print:
  ```
  ⚠️  GitHub Projects needs one more scope.
  Run: gh auth refresh -s project
  Then re-run /sprintplan.
  ```
- Stop. Do not continue to Step 3.

If scope is present: proceed.

---

## Step 3: Load EMDEE Context

Read (skip silently if unavailable):
1. `astrail/SPRINTS.md` — current sprint goal, active issues, dates
2. `astrail/CONSTRAINTS.md` — deadlines (19 July credit cliff)
3. `astrail/team/[author]/SPRINT-[N].md` — existing sprint doc for this person

Extract and hold:
- Sprint start and end dates
- Any already-committed issues from the existing sprint doc
- Current phase (1.1 / 1.2 / 1.3 / 1.4)

---

## Step 4: Clarify (max 3 questions, one message)

Ask only what isn't already answered by arguments + EMDEE context:

1. **Which issues are you committing to?** (show the default list for their role, ask if they want to change it)
2. **Stretch goal?** (one issue they'll do if main list is done early — optional)
3. **Any blockers or dependencies on the other person?**

Skip a question if already clear from arguments or context.

---

## Step 5: Generate and Write EMDEE Sprint Doc

Target path: `astrail/team/[author]/SPRINT-[N].md`

### If the doc doesn't exist yet — create it:

Use `mcp__emdee__create_child` with parent `astrail/team/[author]` and this body:

```markdown
# [Author] Sprint [N]

> Sprint [N] personal log for [Full Name]. Tracks committed issues, daily progress, and reflections.

## Sprint Goal
[goal from arguments]

## Committed Issues
[list of issue numbers and titles]

## Stretch
[stretch issue if provided, else — none]

## Dependencies
[blockers or deps on the other person, else — none]

## Log
<!-- shiplog entries append here -->
```

### If the doc already exists — patch it:

Use `mcp__emdee__patch_section` to update:
- `## Sprint Goal` → new goal
- `## Committed Issues` → updated list
- `## Stretch` → updated stretch goal
- `## Dependencies` → updated deps

Do NOT touch `## Log` — that section is append-only, owned by `/shiplog`.

After writing, confirm: *"EMDEE sprint doc updated at `astrail/team/[author]/SPRINT-[N].md`. ✓"*

---

## Step 6: Update GitHub Projects Board

### 6a — Fetch project metadata

```bash
gh api graphql -f query='
{
  organization(login: "MalaysiaKaki") {
    projectV2(number: 1) {
      id
      fields(first: 20) {
        nodes {
          ... on ProjectV2Field { id name }
          ... on ProjectV2SingleSelectField {
            id name
            options { id name }
          }
          ... on ProjectV2IterationField { id name }
        }
      }
    }
  }
}'
```

Parse and hold:
- `projectId` — the project node ID
- `statusFieldId` — ID of the field named `Status`
- `statusOptionId` for the target status (e.g. `In progress` or `Todo`)
- `sprintFieldId` — ID of the field named `Sprint` (if it exists)

### 6b — Fetch project items and match to issue numbers

```bash
gh api graphql -f query='
{
  organization(login: "MalaysiaKaki") {
    projectV2(number: 1) {
      items(first: 50) {
        nodes {
          id
          content {
            ... on Issue { number title }
          }
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
            }
          }
        }
      }
    }
  }
}'
```

Build a map: `issue_number → item_id`.

### 6c — Update each committed issue

For each issue number in the committed list:

```bash
gh api graphql -f query='
mutation {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: "[projectId]"
      itemId: "[itemId]"
      fieldId: "[statusFieldId]"
      value: { singleSelectOptionId: "[statusOptionId]" }
    }
  ) { projectV2Item { id } }
}'
```

If a Sprint field exists, also set it to `Sprint [N]` for each item.

### 6d — Report results

Print a summary table:

```
GitHub Projects update
──────────────────────────────────
Issue  Title                                    Status
#6     connect Vercel frontend to backend       → In progress ✓
#12    ensure evidence and tradeoff UI is wired → In progress ✓
──────────────────────────────────
```

If any update fails, show the error and the manual fallback:
```
⚠️  #6 failed: [error]. Manual: github.com/orgs/MalaysiaKaki/projects/1
```

---

## Step 7: Final Summary

Output in this order:
1. EMDEE path updated
2. GitHub board changes
3. One-liner reminder:

```
Sprint [N] locked.
EMDEE: astrail/team/[author]/SPRINT-[N].md ✓
GitHub: [N issues] moved to [status] ✓

Next: run /shiplog after each meaningful commit.
```

---

## Quick invoke examples

```
sprintplan "ship auth + Supabase schema" --author zhihao --sprint 1
sprintplan "stabilise backend pipeline" --author shaun --sprint 1 --issues 7,8,9
sprintplan "wire frontend to live backend" --sprint 1 --status in_progress
```
