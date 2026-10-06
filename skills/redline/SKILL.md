---
name: redline
description: Redline, the planning and review loop. Present implementation plans as HTML pages on the local Redline server instead of long terminal output, and build playable prototypes (clickable dummy apps or websites) the user reviews by pinning comments to components. Use whenever the user asks for a project or feature plan, design doc, phased roadmap, or architecture proposal; when they ask for a prototype, clickable mockup, dummy app, playable demo or interactive mock of any app or website; when they say /redline or /plan-review; or when plan or prototype feedback needs processing. Serves mermaid diagrams, collects inline comments, suggested edits and component pins in the browser, and routes submitted feedback back into the session.
---

# Redline: the plan and prototype review workflow

Redline reviews two kinds of documents: **plans** (markdown, sections 1 to 6) and **prototypes** (playable HTML dummies of an app or website, section 7). Both share the inbox, feedback files, version history and the review rail.

The user does not want long plans printed in the terminal. Plans are written as markdown files, served by Redline (a local server), reviewed in the browser, and revised through a feedback loop. Keep terminal output to a few lines; the plan lives in the browser.

Review data (`plans/`, `feedback/`, `inbox/`, `uploads/`) lives in `~/.claude/redline`, whether Redline was installed as a Claude Code plugin or cloned to that path. If it was cloned somewhere else, or `REDLINE_HOME` is set, `sh <this skill's base directory>/redline.sh data` prints the real location; adjust every path below to it. Use absolute paths when passing them to tools.

**`<redline>` below means the server's URL.** Never assume a port: there is exactly one Redline per data directory, and it moves to the next free port (4747 upward) when its usual one is taken. Get the URL with `sh <this skill's base directory>/redline.sh url` (it starts the server in the background if it is not running, and reuses it if it is); the plugin's session hook also prints "Redline is running at ..." into the session context. `GET <redline>/api/health` answers with `"app": "redline"`, which is how anything can tell Redline apart from another app on the port.

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

`plans/` is its own local-only git repo (root at `~/.claude/redline/plans`, created by the server on first start). It is separate from the Redline repo and gitignored there; plans, feedback, inbox and uploads must never be added to or pushed from `~/.claude/redline`. After writing the file, commit it in the plans repo so v1 is a retrievable point in history, not just a number in the front matter:

```
git -C ~/.claude/redline/plans add <workspace>/<slug>.md
git -C ~/.claude/redline/plans commit -m "<workspace>/<slug>: v1"
```

## 2. Serve and open

```
sh <this skill's base directory>/redline.sh url
```

This prints `<redline>`, starting the server if needed and reusing it if it is already running (never start a second one; `redline.sh start` and `url` are both safe to repeat). The base directory is printed when this skill loads. Then open `<redline>/plan/<workspace>/<slug>` in the browser: `open <url>` on macOS, `xdg-open <url>` on Linux, `start <url>` on Windows. `localhost` and `127.0.0.1` both reach it.

## 3. Watch the inbox (your workspace only)

Arm a persistent watcher, one per session. **Scope it to your own workspace.** Several sessions can run in parallel and every submit lands in the same `inbox/` directory; a watcher that claims everything interrupts its session with other projects' feedback and steals events from the session that owns them. Inbox filenames start with the workspace (`<workspace>__<slug>.json`), so watch only the workspace(s) whose plans this session wrote, e.g. `my-app__*.json`. Use the Monitor tool if your environment has it; otherwise run the same loop with Bash `run_in_background`:

```
while true; do
  for f in $(find ~/.claude/redline/inbox -maxdepth 1 -name '<workspace>__*.json' 2>/dev/null); do
    echo "FEEDBACK $(basename "$f" .json) $(cat "$f")"
    mv "$f" "$f.claimed"
  done
  sleep 1
done
```

Description: "plan feedback inbox (<workspace>)". The event line carries the inbox JSON itself, so the `slug` and the `mode` (inline vs independent) are visible the moment the watcher fires, without reading the file. The `mv` to `.claimed` prevents duplicate events. If this session writes plans in a second workspace later, re-arm the watcher with both prefixes.

Stale `.claimed` files or inbox files **for your workspace** found at session start mean unprocessed feedback from earlier; process them the same way. Leave other workspaces' files alone; the session that owns them will claim them. Inbox filenames flatten the slug's `/` to `__` (e.g. `my-app__status.json`); the real slug is in the file's `slug` field.

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
  <absolute path of this SKILL.md>. Slug: <slug>.
  Plan: ~/.claude/redline/plans/<slug>.md (a prototype instead:
  ~/.claude/redline/plans/<slug>.proto/index.html, see section 7)
  Feedback: ~/.claude/redline/feedback/<slug>.json
  Claimed inbox file to delete when done: <path>
  Read attached images, apply edits, resolve or answer every submitted item
  (resolution summaries or thread entries plus answered status), bump version
  and updated, then commit in the nested plans repo
  (git -C ~/.claude/redline/plans add/commit, see step 4).
  Return a one-line summary of what changed.`)
  ```

  Use a pipeline over items instead of the single agent only when the batch is large. If there is no Workflow tool, spawn a background subagent with the Agent tool using the same prompt. If neither exists, fall back to processing inline. A background run continues while you work on your own task; when its notification arrives, relay the one-line outcome. Do not wait for it, poll it, or open the feedback file yourself.
- `"inline"` or missing: process it in this session, subject to the triage rule above.

Read the claimed inbox file to get the slug, then read `~/.claude/redline/feedback/<workspace>/<slug>.json`. The inbox JSON's `kind` is `plan` or `prototype`; for a prototype, also follow the pin rules in section 7. For every item with `"status": "submitted"`:

- Items carry: `type` (comment or edit), `quote` (the selected text as rendered, so markdown syntax like `**` or backticks is stripped; selections over 200 characters are stored as `head … tail` with the full length in `quote_len`), `section` (where it is, e.g. `Phase 2: real capacity › item 2`), `prefix`/`suffix` (40 characters of rendered text around it), `comment`, for edits `suggested_text`, and possibly a `thread` array of `{who, text, at}` messages if the item has been discussed before (`who` is `user` or `claude`).
- Plan comments also carry an `anchor` and an `at`: `anchor.lines` is the line range in the plan file (`"41"` or `"12-19"`), `anchor.where` the readable path, `anchor.s`/`anchor.e` the start and end block (`src`, its line range) with a character offset `o` into that block's rendered text; `at.version` and `at.sha` are the plan version and commit the line numbers refer to. They point at exactly one place, even when the same words appear several times.
- Items and thread messages may carry `images`: screenshots the user attached, as `/uploads/<file>` paths that map to `~/.claude/redline/uploads/<file>`. Always Read those files; they are usually the core of the feedback, not decoration.
- Locate the passage: when `at.version` equals the plan's current `version`, read `anchor.lines` straight from the file (`sed -n '41p'` or the Read tool with that offset); the quote and offsets confirm the spot. If the plan has changed since, read those lines as they were (`git -C ~/.claude/redline/plans show <at.sha>:<workspace>/<slug>.md`) and find the same passage in the current file (`git diff` between the two helps). Items without an anchor (older ones) are located by `section` plus `quote`, matching loosely since rendered text differs from source.
- `edit` items: apply `suggested_text` to the source, adapting markdown syntax as needed. Use judgment; if the suggestion is wrong or conflicts with another item, deviate and explain when closing the item.
- `comment` items: revise the plan to address it, or answer the question.
- Then close or continue each item:
  - Fully handled: set `"status": "resolved"` and write `"resolution"`: a 1-2 line summary of what was decided or changed. Delete the item's `"thread"` and legacy `"reply"` fields; resolved cards show only the summary, never the trail. The server also compacts resolved items automatically on load (drops comment, thread, prefix and suffix), so feedback files stay small; never re-read or reason over resolved items when processing new feedback, only items with `"status": "submitted"` matter.
  - Needs the user's answer (open question, a choice between options, an unclear ask): append `{"who": "claude", "text": "...", "at": <epoch seconds>}` to the item's `"thread"` array and set `"status": "answered"`. The page shows these in red under "Needs your reply" and the index flags the plan. When the user replies in the browser, the item flips back to `"submitted"` and a new inbox file appears, so the watcher loop picks the conversation up again.
- Bump `version` and `updated` in the plan front matter. The browser polls every 2.5s and shows the new version plus replies automatically.
- Commit the bump in the nested plans repo: `git -C ~/.claude/redline/plans add <workspace>/<slug>.md && git -C ~/.claude/redline/plans commit -m "<workspace>/<slug>: v<N> - <what changed>"` (a prototype: `add <workspace>/<slug>.proto`). This is what makes the previous version recoverable; skipping it silently loses v<N-1>. Never run these against `~/.claude/redline` itself: `plans/` is ignored there, so the add fails and the version is lost.
- Delete the processed `inbox/<workspace>__<slug>.json.claimed` file.
- Tell the user in one or two lines what changed; do not restate the plan in the terminal.

## 5. Implementation phase

When the user approves, implement phase by phase and keep the plan current: tick `- [x]` boxes and bump the version as work lands, so the page doubles as a progress board. Commit after each bump the same way as step 4, so the progress-board history (which boxes were ticked, in what version) is recoverable too.

## 6. Seeing older versions

The page itself has a version menu in the header (the `v<N>` pill next to the title), a Versions list in the left pane and a History tab: picking a version loads that commit read-only, with a "Restore this version" button (commits the old content back as a new version, nothing destructive), and the download button in the header (`.md`) works on the live version or whichever historical one is shown, for handing someone a plain file without needing git. "Changes since v<N-1>" highlights what the latest version changed. Point the user at these instead of asking them to run git.

For your own lookups, every bump is a commit, so history is plain git on the nested plans repo:

```
git -C ~/.claude/redline/plans log --oneline -- <workspace>/<slug>.md
git -C ~/.claude/redline/plans show <sha>:<workspace>/<slug>.md
git -C ~/.claude/redline/plans diff <sha1> <sha2> -- <workspace>/<slug>.md
```

For a prototype use the folder path `<workspace>/<slug>.proto` (and `<workspace>/<slug>.proto/index.html` with `show`).

If the user asks to see or compare an older version, use these rather than trying to reconstruct it from the feedback JSON (resolved items get compacted and don't hold the old plan body).

## 7. Prototypes: playable dummies with component comments

When the user asks for a prototype, clickable mockup, dummy app or playable demo of an app or website (or says yes when you offer one for a UI-heavy plan), build it as a Redline prototype instead of a plan. Offer one in a single line when a plan is UI heavy; never build one unasked.

### Layout and front matter

A prototype is a folder next to the plans: `~/.claude/redline/plans/<workspace>/<slug>.proto/` with `index.html` as the entry and optional `assets/`. Pick a slug that no plan in the workspace uses. Front matter is the usual block wrapped in the first HTML comment of `index.html`; the server strips it before serving:

```html
<!--
---
title: Checkout flow
version: 1
status: in review
updated: YYYY-MM-DD
device: mobile
plan: <workspace>/<plan-slug>
---
-->
<!doctype html>
```

`device` (mobile, tablet or desktop) picks the default frame. `plan` links the prototype to a plan; a plan links back with `prototype: <workspace>/<slug>` in its own front matter. Commit v1 in the plans repo (`git -C ~/.claude/redline/plans add <workspace>/<slug>.proto`, then commit `<workspace>/<slug>: v1`), then open `<redline>/proto/<workspace>/<slug>` and arm the inbox watcher exactly as for plans.

### The contract

1. **Self-contained.** Inline CSS and JS (or files under `assets/`). Icons are inline SVG; a brand gets a drawn SVG logo mark, never plain text; no emoji as icons. It must work at phone and desktop widths. Follow any UI preferences the user has stated.
2. **Screens.** Every screen is an element with `data-rl-screen="cart"` and `data-rl-title="Cart"`; navigation uses the hash (`#/cart`, `#/product/3`, `#/cart?state=empty`). The shell's screen picker, pin navigation and live reload all rely on this. Any framework is fine as long as these rules hold.
3. **Component ids.** Every element worth commenting on carries `data-rl="<screen>.<thing>"`, e.g. `data-rl="cart.checkout-button"`. Tag a group and each meaningful part inside it (every tile in a stat row, every line of a price summary, every field of a form), so a click lands on the part the user means while the group id still catches its gaps. Repeated items (cards in a list) share one id; their text tells them apart. **Never rename or drop an id when editing**; pins anchor to them across versions. When a component is genuinely removed, say so in the resolution.
4. **Playable.** Every visible button and link does something: navigates, toggles, opens a sheet, shows a toast. Forms validate with fake rules. Lists use realistic dummy data and volume. Empty, loading and error states are reachable through `?state=` switches.
5. **Fake everything.** State lives in memory; no real network calls, credentials or payments. The page runs in a sandboxed iframe with an opaque origin: storage is shimmed in memory, cookies are unavailable, and Reset reloads to a clean state. Keep dummy data deterministic (seeded) so text, and therefore anchors, stay stable across reloads.
6. **Real sites.** When the user names an existing website or app, look at it for reference (browser screenshots if a browser tool is available), then rebuild the layout with dummy data and placeholder branding. Do not mirror the site, copy its assets or reuse its logo.
7. **Offline by default.** Prefer vanilla JS plus the optional kit. Pull a framework from cdnjs or jsdelivr only when the prototype genuinely needs one.

The optional kit at `/static/kit.js` covers most needs: `Kit.screen(name, render)`, `Kit.start({home})`, `Kit.go(path)`, `Kit.back()`, `Kit.state()` for `?state=`, `data-go="cart"` and `data-back` attributes, `Kit.fake` (seeded names, cities, prices, dates, words, SVG initial avatars), `Kit.money`, `Kit.toast`, `Kit.sheet`, `Kit.modal`, `Kit.skeleton` and `Kit.delay`. `examples/demo/sprout-shop.proto/index.html` in the Redline repo is a complete five-screen example to copy patterns from.

### What the user does

In the browser the user clicks through the prototype, presses `C` for Comment mode, then clicks a component (the nearest `data-rl` ancestor wins, `Alt` picks the exact element) or drags a box over an area. Each pin gets a comment or a "Suggest copy" edit, plus an automatic screenshot of the element or area. Pins, screen notes and general notes collect in the rail and go out with Send to Claude like plan feedback.

### Processing prototype feedback

Same loop as section 4, with these differences:

- Items with `"kind": "pin"` carry an `anchor`: `screen`, `title`, `route`, `component` (the `data-rl` id), `selector`, `tag`, `text`, `offset` (where on the element they clicked, as fractions), `box` (for an area pin, the area as fractions of the anchored element), and `viewport`. `section` is the screen title and `quote` the element's text. `"kind": "screen"` items are notes about a whole screen.
- Find the element by `component` first (grep `data-rl="<id>"` in `index.html`), then by `selector` and `text`. Always open the attached screenshots; they show the state the user saw (an open sheet, a filled form) that the source alone does not.
- `edit` items are copy changes: `quote` is the current text, `suggested_text` the replacement.
- Keep every `data-rl` id stable. Bump `version` and `updated` in the front matter comment, then commit the folder: `git -C ~/.claude/redline/plans add <workspace>/<slug>.proto && git -C ~/.claude/redline/plans commit -m "<workspace>/<slug>: v<N> - <what changed>"`.
- When a change is visual and a browser tool is available, check the touched screen at `<redline>/p/<workspace>/<slug>/#/<screen>` before resolving.
- The page reloads the prototype on the same screen when files change, toasts the new version, and shows resolved pins in green.
