---
name: plan-review
description: "Redline plan review: writes implementation plans as versioned pages on the local Redline server (mermaid diagrams, inline comments, suggested edits) instead of long terminal output, and brings the user's browser feedback back for the next revision. Use when the user wants to plan a feature, app or migration, write a design doc, phased roadmap or architecture proposal, review or revise a plan, says /plan-review, or when Redline plan feedback arrives. Prefer it to printing a long plan in the terminal, even if they don't say redline."
---

# Redline plan review

The user does not want long plans printed in the terminal. Plans are written as markdown files, served by Redline (a local server), reviewed in the browser, and revised through a feedback loop. Keep terminal output to a few lines; the plan lives in the browser. For a clickable prototype instead of a plan, use the prototype-review skill (`redline:prototype-review`).

**Shared files.** Redline's launcher and the review loop shared with prototypes live in `${CLAUDE_SKILL_DIR}/../redline/`: `redline.sh` starts or finds the server, and `review-loop.md` holds the inbox watcher, feedback processing and version history. Steps 4 to 6 below depend on it.

**Data and server.** Review data (`plans/`, `feedback/`, `inbox/`, `uploads/`) lives in `~/.claude/redline`, whether Redline was installed as a Claude Code plugin or cloned to that path. If it was cloned somewhere else, or `REDLINE_HOME` is set, `sh ${CLAUDE_SKILL_DIR}/../redline/redline.sh data` prints the real location; adjust every path below to it. Use absolute paths when passing them to tools. **`<redline>` below means the server's URL.** Never assume a port: there is exactly one Redline per data directory, and it moves to the next free port (4747 upward) when its usual one is taken.

## 1. Write the plan

Create `~/.claude/redline/plans/<workspace>/<slug>.md` (both lowercase, hyphens). `<workspace>` is the project the plan belongs to, normally the kebab-cased basename of the repo or working directory (e.g. `my-app`, `redline`). Every plan goes in a workspace folder; never write directly into `plans/`. The index page groups plans by workspace. Required front matter:

```
---
title: Human readable title
version: 1
status: in review
updated: YYYY-MM-DD
---
```

Content guidelines:
- Mermaid diagrams are expected, not optional: a `flowchart` for components and a `sequenceDiagram` (or `stateDiagram-v2`) for the main workflow. Avoid angle brackets inside mermaid labels; use `<br/>` only for line breaks inside quoted labels.
- Phase sections with `- [ ]` task checklists, a components table, and a risks or open questions section.
- Follow any writing style preferences the user has expressed.

## 2. Commit v1

`plans/` is its own local-only git repo (root at `~/.claude/redline/plans`, created by the server on first start). It is separate from the Redline repo and gitignored there; plans, feedback, inbox and uploads must never be added to or pushed from `~/.claude/redline`. After writing the file, commit it in the plans repo so v1 is a retrievable point in history, not just a number in the front matter:

```
git -C ~/.claude/redline/plans add <workspace>/<slug>.md
git -C ~/.claude/redline/plans commit -m "<workspace>/<slug>: v1"
```

## 3. Serve and open

```
sh ${CLAUDE_SKILL_DIR}/../redline/redline.sh url
```

This prints `<redline>`, starting the server if needed and reusing it if it is already running (never start a second one; `redline.sh start` and `url` are both safe to repeat). The plugin's session hook also prints "Redline is running at ..." into the session context, and `GET <redline>/api/health` answers with `"app": "redline"`. Then open `<redline>/plan/<workspace>/<slug>` in the browser: `open <url>` on macOS, `xdg-open <url>` on Linux, `start <url>` on Windows. `localhost` and `127.0.0.1` both reach it.

## 4. Arm the inbox watcher

Read `${CLAUDE_SKILL_DIR}/../redline/review-loop.md` now and arm the watcher exactly as its section 1 says: one per session, scoped to this workspace (`<workspace>__*.json`), never the whole inbox.

## 5. Process feedback when the watcher fires

A `FEEDBACK <workspace>__<slug> {...}` event is a notification, not an interrupt: follow section 2 of `review-loop.md` (triage against the task in flight, the `mode` field for background processing, line anchors on plan comments, closing items, then bump `version` and `updated`, commit in the plans repo and reply in a line or two).

## 6. Implementation phase

When the user approves, implement phase by phase and keep the plan current: tick `- [x]` boxes and bump the version as work lands, so the page doubles as a progress board. Commit after each bump the same way as in section 2 of `review-loop.md`, so the progress-board history (which boxes were ticked, in what version) is recoverable too.

For older versions, point the user at the page's version menu and History tab; for your own lookups use the git commands in section 3 of `review-loop.md`.

## Prototypes for UI-heavy plans

When a plan is UI heavy, offer a playable prototype in a single line; never build one unasked. If the user says yes, use the prototype-review skill, and link the two: `prototype: <workspace>/<proto-slug>` in this plan's front matter, `plan: <workspace>/<slug>` in the prototype's.
