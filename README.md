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
plans/*.md       one plan per file, front matter: title, version, status, updated
feedback/*.json  comments and suggested edits, statuses draft/submitted/resolved
inbox/*.json     signal files written on submit, claimed by the Claude session
vendor/          marked.min.js, mermaid.min.js
```

## API

```
GET  /                        index of plans
GET  /plan/<slug>             viewer page
GET  /api/health
GET  /api/plan/<slug>         {slug, meta, markdown, mtime}
GET  /api/feedback/<slug>     {items: [...]}
POST /api/feedback/<slug>     add draft {type, quote, section, prefix, suffix, comment, suggested_text}
POST /api/feedback/<slug>/delete   {id} remove a draft
POST /api/submit/<slug>       drafts -> submitted, writes inbox/<slug>.json
```

The Claude side of the workflow is documented in `~/.claude/skills/plan-review/SKILL.md`.
