---
name: prototype-review
description: "Redline prototype review: builds playable, clickable prototypes (dummy apps or websites with fake data) that the user marks up in the browser by pinning comments to components, and brings those pins back for the next version. Use when the user asks for a prototype, clickable mockup, wireframe, dummy app, interactive demo or screen flow of any app or website, wants a UX review, to mark up a UI or iterate on a layout, says /prototype-review, or when Redline prototype feedback arrives, even if they don't say redline."
---

# Redline prototype review

A prototype is a playable HTML dummy of an app or website, served by Redline (a local server) in a phone, tablet or desktop frame. The user clicks through it, pins comments to components, and sends them back into this session for the next version. Keep terminal output to a few lines; the prototype lives in the browser. For a written plan, design doc or roadmap instead, use the plan-review skill (`redline:plan-review`).

**Shared files.** Redline's launcher and the review loop shared with plans live in `${CLAUDE_SKILL_DIR}/../redline/`: `redline.sh` starts or finds the server, and `review-loop.md` holds the inbox watcher, feedback processing (including pins) and version history. Steps 4 and 6 below depend on it.

**Data and server.** Review data (`plans/`, `feedback/`, `inbox/`, `uploads/`) lives in `~/.claude/redline`, whether Redline was installed as a Claude Code plugin or cloned to that path. If it was cloned somewhere else, or `REDLINE_HOME` is set, `sh ${CLAUDE_SKILL_DIR}/../redline/redline.sh data` prints the real location; adjust every path below to it. Use absolute paths when passing them to tools. **`<redline>` below means the server's URL.** Never assume a port: there is exactly one Redline per data directory, and it moves to the next free port (4747 upward) when its usual one is taken.

## 1. Layout and front matter

A prototype is a folder next to the plans: `~/.claude/redline/plans/<workspace>/<slug>.proto/` with `index.html` as the entry and optional `assets/`. `<workspace>` is the project it belongs to, normally the kebab-cased basename of the repo or working directory (e.g. `my-app`). Pick a slug that no plan in the workspace uses. Front matter is the usual block wrapped in the first HTML comment of `index.html`; the server strips it before serving:

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

`device` (mobile, tablet or desktop) picks the default frame. `plan` (optional) links the prototype to a plan; a plan links back with `prototype: <workspace>/<slug>` in its own front matter.

## 2. The contract

1. **Self-contained.** Inline CSS and JS (or files under `assets/`). Icons are inline SVG; a brand gets a drawn SVG logo mark, never plain text; no emoji as icons. It must work at phone and desktop widths. Follow any UI preferences the user has stated.
2. **Screens.** Every screen is an element with `data-rl-screen="cart"` and `data-rl-title="Cart"`; navigation uses the hash (`#/cart`, `#/product/3`, `#/cart?state=empty`). The shell's screen picker, pin navigation and live reload all rely on this. Any framework is fine as long as these rules hold.
3. **Component ids.** Every element worth commenting on carries `data-rl="<screen>.<thing>"`, e.g. `data-rl="cart.checkout-button"`. Tag a group and each meaningful part inside it (every tile in a stat row, every line of a price summary, every field of a form), so a click lands on the part the user means while the group id still catches its gaps. Repeated items (cards in a list) share one id; their text tells them apart. **Never rename or drop an id when editing**; pins anchor to them across versions. When a component is genuinely removed, say so in the resolution.
4. **Playable.** Every visible button and link does something: navigates, toggles, opens a sheet, shows a toast. Forms validate with fake rules. Lists use realistic dummy data and volume. Empty, loading and error states are reachable through `?state=` switches.
5. **Fake everything.** State lives in memory; no real network calls, credentials or payments. The page runs in a sandboxed iframe with an opaque origin: storage is shimmed in memory, cookies are unavailable, and Reset reloads to a clean state. Keep dummy data deterministic (seeded) so text, and therefore anchors, stay stable across reloads.
6. **Real sites.** When the user names an existing website or app, look at it for reference (browser screenshots if a browser tool is available), then rebuild the layout with dummy data and placeholder branding. Do not mirror the site, copy its assets or reuse its logo.
7. **Offline by default.** Prefer vanilla JS plus the optional kit. Pull a framework from cdnjs or jsdelivr only when the prototype genuinely needs one.

The optional kit at `/static/kit.js` covers most needs: `Kit.screen(name, render)`, `Kit.start({home})`, `Kit.go(path)`, `Kit.back()`, `Kit.state()` for `?state=`, `data-go="cart"` and `data-back` attributes, `Kit.fake` (seeded names, cities, prices, dates, words, SVG initial avatars), `Kit.money`, `Kit.toast`, `Kit.sheet`, `Kit.modal`, `Kit.skeleton` and `Kit.delay`. `examples/demo/sprout-shop.proto/index.html` at the root of the Redline repo or plugin (seeded on first start as `~/.claude/redline/plans/demo/sprout-shop.proto/index.html`) is a complete five-screen example to copy patterns from.

## 3. Commit v1, serve and open

`plans/` is its own local-only git repo (root at `~/.claude/redline/plans`), separate from the Redline repo; never add review data to `~/.claude/redline` itself. Commit v1 so it is a retrievable point in history:

```
git -C ~/.claude/redline/plans add <workspace>/<slug>.proto
git -C ~/.claude/redline/plans commit -m "<workspace>/<slug>: v1"
sh ${CLAUDE_SKILL_DIR}/../redline/redline.sh url
```

The last command prints `<redline>`, starting the server if needed and reusing it if it is already running (never start a second one). Open `<redline>/proto/<workspace>/<slug>` in the browser: `open <url>` on macOS, `xdg-open <url>` on Linux, `start <url>` on Windows.

## 4. Arm the inbox watcher

Read `${CLAUDE_SKILL_DIR}/../redline/review-loop.md` now and arm the watcher exactly as its section 1 says: one per session, scoped to this workspace (`<workspace>__*.json`), never the whole inbox.

## 5. What the user does

In the browser the user clicks through the prototype, presses `C` for Comment mode, then clicks a component (the nearest `data-rl` ancestor wins, `Alt` picks the exact element) or drags a box over an area. Each pin gets a comment or a "Suggest copy" edit, plus an automatic screenshot of the element or area. Pins, screen notes and general notes collect in the rail and go out with Send to Claude.

## 6. Process feedback when the watcher fires

A `FEEDBACK <workspace>__<slug> {...}` event is a notification, not an interrupt: follow section 2 of `review-loop.md` (triage against the task in flight, the `mode` field for background processing, finding each pin by its `data-rl` component and screenshot, closing items, then bump `version` and `updated` in the front matter comment, commit the `.proto` folder and reply in a line or two). Keep to the contract above on every edit, above all stable `data-rl` ids.
