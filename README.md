# Plan Server

Local plan review loop for Claude Code sessions. Plans are markdown files rendered in the browser with mermaid diagrams; you annotate them (comments, suggested edits) and submit, and the feedback lands back in the Claude session via an inbox that Claude watches.

## Run

```
python3 server.py            # http://localhost:4747
```

No dependencies, Python stdlib only. marked and mermaid are vendored in `vendor/` so it works offline.

## Layout

```
server.py        http server: plans, feedback, submit, inbox signals
viewer.html      review UI: rendering, selection toolbar, review rail, polling
skill/SKILL.md   Claude Code skill driving the workflow (plan authoring, inbox watching, feedback processing)
plans/<workspace>/*.md      one plan per file, grouped by workspace (project) folder;
                            front matter: title, version, status, updated
feedback/<workspace>/*.json comments and suggested edits, statuses draft/submitted/answered/resolved;
                            answered items carry a thread and wait on the user, resolved items
                            keep a 1-2 line resolution summary instead of the trail
inbox/*.json                signal files written on submit, claimed by the Claude session
                            (flat; slug slashes become __, real slug is inside the JSON)
uploads/         screenshots pasted or dropped onto feedback (flat files, served at /uploads/)
vendor/          marked.min.js, mermaid.min.js
```

## Skill install

The `plan-review` skill lives in this repo and is symlinked into Claude Code's skills directory so the repo stays the single source of truth:

```
ln -s ../plan-server/skill ~/.claude/skills/plan-review
```

## API

Slugs are workspace-qualified paths: `<workspace>/<name>`, e.g. `autotrader/status`. The index page groups plans by workspace.

```
GET  /                        index of plans, grouped by workspace
GET  /plan/<slug>             viewer page
GET  /api/health
GET  /api/plan/<slug>         {slug, meta, markdown, mtime}
GET  /api/feedback/<slug>     {items: [...]}
POST /api/feedback/<slug>     add draft {type, quote, section, prefix, suffix, comment, suggested_text}
POST /api/feedback/<slug>/delete   {id} remove a draft
POST /api/submit/<slug>       {independent?} drafts -> submitted, writes inbox/<workspace>__<name>.json
POST /api/reply/<slug>        {id, text, images?, independent?} user reply on an answered item ->
                              back to submitted, appends to its thread and writes an inbox file
POST /api/upload/<slug>       {data: base64 image data url} -> {url: /uploads/<file>}; feedback
                              items and replies reference these in an images array

Inbox files carry "mode": "independent" | "inline" from the page's Run independently
toggle; independent batches are handed to a background agent by the Claude session.
```

The Claude side of the workflow is documented in `skill/SKILL.md`.
