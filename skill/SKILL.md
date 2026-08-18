---
name: plan-review
description: Present implementation plans as HTML pages on the local Redline plan server instead of long terminal output. Use whenever the user asks for a project or feature plan, design doc, phased roadmap, or architecture proposal, when they say /plan-review, or when plan feedback needs processing. Serves mermaid diagrams, collects inline comments and suggested edits in the browser, and routes submitted feedback back into the session.
---

# Redline: the plan review workflow

The user does not want long plans printed in the terminal. Plans are written as markdown files, served at http://localhost:4747 by Redline (the local plan server), reviewed in the browser, and revised through a feedback loop. Keep terminal output to a few lines; the plan lives in the browser.

The server root is `~/.claude/plan-server` (the directory containing `server.py`; adjust every path below if it was cloned somewhere else). Use absolute paths when passing them to tools.

## 1. Write the plan

Create `~/.claude/plan-server/plans/<workspace>/<slug>.md` (both lowercase, hyphens). `<workspace>` is the project the plan belongs to, normally the kebab-cased basename of the repo or working directory (e.g. `autotrader`, `plan-server`). Every plan goes in a workspace folder; never write directly into `plans/`. The index page groups plans by workspace. Required front matter:

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

## 2. Serve and open

```
curl -sf http://localhost:4747/api/health >/dev/null 2>&1 \
  || echo "server down"
```

If down, start it with Bash `run_in_background`: `python3 ~/.claude/plan-server/server.py`. Then open `http://localhost:4747/plan/<workspace>/<slug>` in the browser (`open <url>` on macOS, `xdg-open <url>` on Linux, `start <url>` on Windows).

## 3. Watch the inbox (your workspace only)

Arm a persistent watcher, one per session. **Scope it to your own workspace.** Several sessions can run in parallel and every submit lands in the same `inbox/` directory; a watcher that claims everything interrupts its session with other projects' feedback and steals events from the session that owns them. Inbox filenames start with the workspace (`<workspace>__<slug>.json`), so watch only the workspace(s) whose plans this session wrote, e.g. `autotrader__*.json`. Use the Monitor tool if your environment has it; otherwise run the same loop with Bash `run_in_background`:

```
while true; do
  for f in $(find ~/.claude/plan-server/inbox -maxdepth 1 -name '<workspace>__*.json' 2>/dev/null); do
    echo "FEEDBACK $(basename "$f" .json) $(cat "$f")"
    mv "$f" "$f.claimed"
  done
  sleep 1
done
```

Description: "plan feedback inbox (<workspace>)". The event line carries the inbox JSON itself, so the `slug` and the `mode` (inline vs independent) are visible the moment the watcher fires, without reading the file. The `mv` to `.claimed` prevents duplicate events. If this session writes plans in a second workspace later, re-arm the watcher with both prefixes.

Stale `.claimed` files or inbox files **for your workspace** found at session start mean unprocessed feedback from earlier; process them the same way. Leave other workspaces' files alone; the session that owns them will claim them. Inbox filenames flatten the slug's `/` to `__` (e.g. `autotrader__status.json`); the real slug is in the file's `slug` field.

## 4. Process feedback when the watcher fires

**Feedback never breaks the task in flight.** The watcher firing is a notification, not an interrupt. If you are mid-task when it fires, glance at the feedback and triage:

- Urgent, or a quick answer (a question answerable in a line or two, a trivial edit): handle it immediately, reply, then continue the current task exactly where you left off.
- Anything longer (section rewrites, new phases, rethinking the approach): finish the current task to a clean stopping point first, then process the feedback. A slow reply is fine; abandoned or half-done work is not.

Never restart, re-plan, or drop in-flight work because feedback arrived.

**Check the inbox file's `mode` field before processing.** The page has a "Run independently" toggle; it stamps the inbox JSON with `"mode"`:

- `"independent"`: process the batch in the background, outside this session's context; that is the whole point of the toggle, it is the user's standing opt-in for background processing. If your environment has the Workflow tool, call it immediately with a minimal script (fill in `<slug>` and the claimed file path, using absolute paths):

  ```js
  export const meta = { name: 'plan-feedback', description: 'Process plan review feedback batch', phases: [{ title: 'Process' }] }
  phase('Process')
  return await agent(`Process plan review feedback exactly per section 4 of
  ~/.claude/plan-server/skill/SKILL.md. Slug: <slug>.
  Plan: ~/.claude/plan-server/plans/<slug>.md
  Feedback: ~/.claude/plan-server/feedback/<slug>.json
  Claimed inbox file to delete when done: <path>
  Read attached images, apply edits, resolve or answer every submitted item
  (resolution summaries or thread entries plus answered status), bump version
  and updated. Return a one-line summary of what changed.`)
  ```

  Use a pipeline over items instead of the single agent only when the batch is large. If there is no Workflow tool, spawn a background subagent with the Agent tool using the same prompt. If neither exists, fall back to processing inline. A background run continues while you work on your own task; when its notification arrives, relay the one-line outcome. Do not wait for it, poll it, or open the feedback file yourself.
- `"inline"` or missing: process it in this session, subject to the triage rule above.

Read the claimed inbox file to get the slug, then read `~/.claude/plan-server/feedback/<workspace>/<slug>.json`. For every item with `"status": "submitted"`:

- Items carry: `type` (comment or edit), `quote` (the selected text as rendered, so markdown syntax like `**` or backticks is stripped), `section` (nearest heading), `prefix`/`suffix` (surrounding rendered text), `comment`, for edits `suggested_text`, and possibly a `thread` array of `{who, text, at}` messages if the item has been discussed before (`who` is `user` or `claude`).
- Items and thread messages may carry `images`: screenshots the user attached, as `/uploads/<file>` paths that map to `~/.claude/plan-server/uploads/<file>`. Always Read those files; they are usually the core of the feedback, not decoration.
- Locate the passage in the markdown source using section plus quote; match loosely since rendered text differs from source.
- `edit` items: apply `suggested_text` to the source, adapting markdown syntax as needed. Use judgment; if the suggestion is wrong or conflicts with another item, deviate and explain when closing the item.
- `comment` items: revise the plan to address it, or answer the question.
- Then close or continue each item:
  - Fully handled: set `"status": "resolved"` and write `"resolution"`: a 1-2 line summary of what was decided or changed. Delete the item's `"thread"` and legacy `"reply"` fields; resolved cards show only the summary, never the trail. The server also compacts resolved items automatically on load (drops comment, thread, prefix and suffix), so feedback files stay small; never re-read or reason over resolved items when processing new feedback, only items with `"status": "submitted"` matter.
  - Needs the user's answer (open question, a choice between options, an unclear ask): append `{"who": "claude", "text": "...", "at": <epoch seconds>}` to the item's `"thread"` array and set `"status": "answered"`. The page shows these in red under "Needs your reply" and the index flags the plan. When the user replies in the browser, the item flips back to `"submitted"` and a new inbox file appears, so the watcher loop picks the conversation up again.
- Bump `version` and `updated` in the plan front matter. The browser polls every 2.5s and shows the new version plus replies automatically.
- Delete the processed `inbox/<workspace>__<slug>.json.claimed` file.
- Tell the user in one or two lines what changed; do not restate the plan in the terminal.

## 5. Implementation phase

When the user approves, implement phase by phase and keep the plan current: tick `- [x]` boxes and bump the version as work lands, so the page doubles as a progress board.
