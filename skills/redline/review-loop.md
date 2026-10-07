# Redline review loop

Shared by the plan-review and prototype-review skills: the inbox watcher (section 1), feedback processing (section 2) and version history (section 3). Read it when you arm the watcher and whenever feedback arrives.

`<here>` below is the directory holding this file; `redline.sh` sits next to it. Paths assume the default data directory `~/.claude/redline`; if `sh <here>/redline.sh data` prints another one, use that instead, and pass absolute paths to tools. `<redline>` is the server's URL, printed by `sh <here>/redline.sh url`. A document is named `<workspace>/<slug>`: a plan is `plans/<workspace>/<slug>.md`, a prototype is the folder `plans/<workspace>/<slug>.proto/`, and its feedback is `feedback/<workspace>/<slug>.json`.

## 1. Watch the inbox (your workspace only)

Arm a persistent watcher, one per session. **Scope it to your own workspace.** Several sessions can run in parallel and every submit lands in the same `inbox/` directory; a watcher that claims everything interrupts its session with other projects' feedback and steals events from the session that owns them. Inbox filenames start with the workspace (`<workspace>__<slug>.json`), so watch only the workspace(s) whose plans or prototypes this session wrote, e.g. `my-app__*.json`. Use the Monitor tool if your environment has it; otherwise run the same loop with Bash `run_in_background`:

```
while true; do
  for f in $(find ~/.claude/redline/inbox -maxdepth 1 -name '<workspace>__*.json' 2>/dev/null); do
    echo "FEEDBACK $(basename "$f" .json) $(cat "$f") (process per <absolute path of this file>, section 2)"
    mv "$f" "$f.claimed"
  done
  sleep 1
done
```

Description: "Redline feedback inbox (<workspace>)". The event line carries the inbox JSON itself, so the `slug`, the `kind` (plan or prototype) and the `mode` (inline or independent) are visible the moment the watcher fires, without reading the file; the path at the end leads back here after a compaction. The `mv` to `.claimed` prevents duplicate events. If this session writes documents in a second workspace later, re-arm the watcher with both prefixes.

Stale `.claimed` files or inbox files **for your workspace** found at session start mean unprocessed feedback from earlier; process them the same way. Leave other workspaces' files alone; the session that owns them will claim them. Inbox filenames flatten the `/` in `<workspace>/<slug>` to `__` (e.g. `my-app__status.json`); the real name is in the file's `slug` field.

## 2. Process feedback when the watcher fires

**Feedback never breaks the task in flight.** The watcher firing is a notification, not an interrupt. If you are mid-task when it fires, glance at the feedback and triage:

- Urgent, or a quick answer (a question answerable in a line or two, a trivial edit): handle it immediately, reply, then continue the current task exactly where you left off.
- Anything longer (section rewrites, new phases, rethinking the approach): finish the current task to a clean stopping point first, then process the feedback. A slow reply is fine; abandoned or half-done work is not.

Never restart, re-plan, or drop in-flight work because feedback arrived.

### Inline or independent

**Check the inbox JSON's `mode` field before processing.** The page has a "Run independently" toggle that stamps it:

- `"independent"`: process the batch in the background, outside this session's context; that is the whole point of the toggle, it is the user's standing opt-in for background processing. If your environment has the Workflow tool, call it immediately with a minimal script (fill in the names and the claimed file path, using absolute paths):

  ```js
  export const meta = { name: 'redline-feedback', description: 'Process Redline review feedback batch', phases: [{ title: 'Process' }] }
  phase('Process')
  return await agent(`Process Redline review feedback exactly per section 2 of
  <absolute path of this file>. Document: <workspace>/<slug> (<kind>).
  Plan: ~/.claude/redline/plans/<workspace>/<slug>.md (a prototype instead:
  ~/.claude/redline/plans/<workspace>/<slug>.proto/index.html; keep to the
  prototype contract in <here>/../prototype-review/SKILL.md)
  Feedback: ~/.claude/redline/feedback/<workspace>/<slug>.json
  Claimed inbox file to delete when done: <path>
  Read attached images, apply edits, resolve or answer every submitted item
  (resolution summaries or thread entries plus answered status), bump version
  and updated, then commit in the nested plans repo
  (git -C ~/.claude/redline/plans add/commit, see section 2).
  Return a one-line summary of what changed.`)
  ```

  Use a pipeline over items instead of the single agent only when the batch is large. If there is no Workflow tool, spawn a background subagent with the Agent tool using the same prompt. If neither exists, fall back to processing inline. A background run continues while you work on your own task; when its notification arrives, relay the one-line outcome. Do not wait for it, poll it, or open the feedback file yourself.
- `"inline"` or missing: process it in this session, subject to the triage rule above.

### Read the batch

Read `~/.claude/redline/feedback/<workspace>/<slug>.json`. Only items with `"status": "submitted"` matter; never re-read or reason over resolved items. Every item carries:

- `type` (comment or edit), `comment`, and for edits `suggested_text`.
- `quote`: the selected text as rendered (markdown syntax like `**` or backticks is stripped; selections over 200 characters are stored as `head … tail` with the full length in `quote_len`), `section` (where it is, e.g. `Phase 2: real capacity › item 2`), and `prefix`/`suffix` (40 characters of rendered text around it).
- Possibly a `thread` array of `{who, text, at}` messages if the item has been discussed before (`who` is `user` or `claude`).
- Possibly `images` on the item or its thread messages: screenshots the user attached, as `/uploads/<file>` paths that map to `~/.claude/redline/uploads/<file>`. Always Read those files; they are usually the core of the feedback, not decoration.

**Plan items** also carry an `anchor` and an `at`: `anchor.lines` is the line range in the plan file (`"41"` or `"12-19"`), `anchor.where` the readable path, `anchor.s`/`anchor.e` the start and end block (`src`, its line range) with a character offset `o` into that block's rendered text; `at.version` and `at.sha` are the plan version and commit the line numbers refer to. They point at exactly one place, even when the same words appear several times. To locate the passage: when `at.version` equals the plan's current `version`, read `anchor.lines` straight from the file (`sed -n '41p'` or the Read tool with that offset); the quote and offsets confirm the spot. If the plan has changed since, read those lines as they were (`git -C ~/.claude/redline/plans show <at.sha>:<workspace>/<slug>.md`) and find the same passage in the current file (`git diff` between the two helps). Items without an anchor (older ones) are located by `section` plus `quote`, matching loosely since rendered text differs from source.

**Prototype items** with `"kind": "pin"` carry an `anchor` instead: `screen`, `title`, `route`, `component` (the `data-rl` id), `selector`, `tag`, `text`, `offset` (where on the element they clicked, as fractions), `box` (for an area pin, the area as fractions of the anchored element), and `viewport`. `section` is the screen title and `quote` the element's text. `"kind": "screen"` items are notes about a whole screen. Find the element by `component` first (grep `data-rl="<id>"` in `index.html`), then by `selector` and `text`. Always open the attached screenshots; they show the state the user saw (an open sheet, a filled form) that the source alone does not. `edit` items on a prototype are copy changes: `quote` is the current text, `suggested_text` the replacement.

### Apply and close

- `edit` items: apply `suggested_text` to the source, adapting markdown syntax as needed. Use judgment; if the suggestion is wrong or conflicts with another item, deviate and explain when closing the item.
- `comment` items: revise the document to address it, or answer the question.
- Prototypes: keep every `data-rl` id stable (pins anchor to them across versions); when a component is genuinely removed, say so in the resolution. When a change is visual and a browser tool is available, check the touched screen at `<redline>/p/<workspace>/<slug>/#/<screen>` before resolving.
- Then close or continue each item:
  - Fully handled: set `"status": "resolved"` and write `"resolution"`: a 1-2 line summary of what was decided or changed. Delete the item's `"thread"` and legacy `"reply"` fields; resolved cards show only the summary, never the trail. The server also compacts resolved items automatically on load (drops comment, thread, prefix and suffix), so feedback files stay small.
  - Needs the user's answer (open question, a choice between options, an unclear ask): append `{"who": "claude", "text": "...", "at": <epoch seconds>}` to the item's `"thread"` array and set `"status": "answered"`. The page shows these in red under "Needs your reply" and the index flags the document. When the user replies in the browser, the item flips back to `"submitted"` and a new inbox file appears, so the watcher picks the conversation up again.

### Bump, commit, report

- Bump `version` and `updated` in the front matter (a plan's top block; a prototype's first HTML comment in `index.html`). The browser polls every 2.5s and shows the new version plus replies automatically; a prototype reloads on the same screen and shows resolved pins in green.
- Commit the bump in the nested plans repo: `git -C ~/.claude/redline/plans add <workspace>/<slug>.md && git -C ~/.claude/redline/plans commit -m "<workspace>/<slug>: v<N> - <what changed>"` (a prototype: `add <workspace>/<slug>.proto`). This is what makes the previous version recoverable; skipping it silently loses v<N-1>. Never run these against `~/.claude/redline` itself: `plans/` is ignored there, so the add fails and the version is lost.
- Delete the processed `inbox/<workspace>__<slug>.json.claimed` file.
- Tell the user in one or two lines what changed; do not restate the document in the terminal.

## 3. Seeing older versions

The page itself has a version menu in the header (the `v<N>` pill next to the title), a Versions list in the left pane and a History tab: picking a version loads that commit read-only, with a "Restore this version" button (commits the old content back as a new version, nothing destructive), and the download button in the header (`.md` for a plan, `.html` or `.zip` for a prototype) works on the live version or whichever historical one is shown, for handing someone a plain file without needing git. "Changes since v<N-1>" highlights what the latest version changed. Point the user at these instead of asking them to run git.

For your own lookups, every bump is a commit, so history is plain git on the nested plans repo:

```
git -C ~/.claude/redline/plans log --oneline -- <workspace>/<slug>.md
git -C ~/.claude/redline/plans show <sha>:<workspace>/<slug>.md
git -C ~/.claude/redline/plans diff <sha1> <sha2> -- <workspace>/<slug>.md
```

For a prototype use the folder path `<workspace>/<slug>.proto` (and `<workspace>/<slug>.proto/index.html` with `show`).

If the user asks to see or compare an older version, use these rather than trying to reconstruct it from the feedback JSON (resolved items get compacted and don't hold the old body).
