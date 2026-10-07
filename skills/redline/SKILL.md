---
name: redline
description: "Redline entry point for /redline. Routes to redline:plan-review (plans, design docs, roadmaps, architecture proposals) or redline:prototype-review (clickable prototypes, mockups, wireframes, UI markup). Use it when the user says /redline or asks for Redline without saying which; otherwise prefer the two specific skills."
---

# Redline

Redline is a browser review loop for two kinds of documents, each with its own skill:

- **Plans** (feature plans, design docs, phased roadmaps, architecture proposals, plan reviews): the plan-review skill, `redline:plan-review`.
- **Prototypes** (clickable prototypes, mockups, wireframes, dummy apps, interactive demos, UX reviews, UI markup): the prototype-review skill, `redline:prototype-review`.

Pick the one that matches the request and invoke it with the Skill tool, passing the user's request along. If it is unclear which one they want, ask in one line; a plan for a UI-heavy feature is a plan, with a prototype offered afterwards.

In a git clone install the same skills are named `plan-review` and `prototype-review`. If neither name resolves (an older clone install that links only this directory), get this directory's real path with `cd ${CLAUDE_SKILL_DIR} && pwd -P`, Read `<real path>/../plan-review/SKILL.md` or `<real path>/../prototype-review/SKILL.md`, and follow it, taking the CLAUDE_SKILL_DIR placeholder in that file to mean that file's own directory.

A `FEEDBACK <workspace>__<slug> {...}` line from an inbox watcher is Redline feedback: process it per section 2 of `${CLAUDE_SKILL_DIR}/review-loop.md`.

Files in this directory, shared by both skills: `redline.sh` (start, find or stop the server; `sh ${CLAUDE_SKILL_DIR}/redline.sh url` prints its URL) and `review-loop.md` (inbox watcher, feedback processing, version history).
