#!/usr/bin/env python3
"""Local plan review server.

Serves plan markdown files as reviewable HTML pages, collects inline
comments and suggested edits from the browser, and drops a signal file
in inbox/ when the user submits a batch so Claude can pick it up.

Stdlib only. Run: python3 server.py [--port 4747]
"""
import argparse
import base64
import html
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
PLANS_DIR = os.path.join(ROOT, "plans")
FEEDBACK_DIR = os.path.join(ROOT, "feedback")
INBOX_DIR = os.path.join(ROOT, "inbox")
VENDOR_DIR = os.path.join(ROOT, "vendor")
UPLOADS_DIR = os.path.join(ROOT, "uploads")
STATIC_DIR = os.path.join(ROOT, "static")

# A prototype is a folder <slug>.proto/ with index.html as its entry, living
# next to plans so it shares their git history, feedback, inbox and uploads.
PROTO_EXT = ".proto"
PROTO_ENTRY = "index.html"

LOCK = threading.RLock()

# The server is local-only by design. Rejecting foreign Host headers stops
# DNS rebinding, where a malicious page resolves its own domain to 127.0.0.1
# to read plans or post feedback through the visitor's browser.
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]"}

MAX_BODY = 32 * 1024 * 1024  # fits a 15 MB image as a base64 JSON field

for d in (PLANS_DIR, FEEDBACK_DIR, INBOX_DIR, VENDOR_DIR, UPLOADS_DIR):
    os.makedirs(d, exist_ok=True)


def _seed_examples():
    """First run only: copy the bundled demo plan and demo prototype from
    examples/ into plans/ so the live demos work. plans/ itself is
    local-only and gitignored by the Redline repo."""
    has_md = has_proto = False
    for dirpath, dirnames, files in os.walk(PLANS_DIR):
        if any(d.endswith(PROTO_EXT) for d in dirnames):
            has_proto = True
        dirnames[:] = [d for d in dirnames if d != ".git" and not d.endswith(PROTO_EXT)]
        if any(f.endswith(".md") for f in files):
            has_md = True
    examples = os.path.join(ROOT, "examples")
    for dirpath, dirnames, files in os.walk(examples):
        protos = [d for d in dirnames if d.endswith(PROTO_EXT)]
        dirnames[:] = [d for d in dirnames if not d.endswith(PROTO_EXT)]
        dest_dir = os.path.join(PLANS_DIR, os.path.relpath(dirpath, examples))
        if not has_md:
            for name in files:
                if name.endswith(".md"):
                    os.makedirs(dest_dir, exist_ok=True)
                    shutil.copyfile(os.path.join(dirpath, name), os.path.join(dest_dir, name))
        if not has_proto:
            for d in protos:
                if not os.path.exists(os.path.join(dest_dir, d)):
                    shutil.copytree(os.path.join(dirpath, d), os.path.join(dest_dir, d))


def _init_plans_repo():
    """plans/ keeps its own git history (one commit per plan version) in a
    nested repo, separate from the Redline repo, so plans can never ride
    along with a push of the tool itself."""
    if os.path.isdir(os.path.join(PLANS_DIR, ".git")):
        return
    try:
        subprocess.run(["git", "-C", PLANS_DIR, "init", "-q"],
                       capture_output=True, timeout=5)
    except Exception:
        pass


_seed_examples()
_init_plans_repo()

IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg",
               "image/webp": "webp", "image/gif": "gif"}


def clean_image_urls(value):
    if not isinstance(value, list):
        return []
    return [u for u in value
            if isinstance(u, str) and re.match(r"^/uploads/[\w.-]+$", u)]


def parse_meta_lines(block):
    meta = {}
    for line in block.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta


def parse_front_matter(text):
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.DOTALL)
    if not m:
        return {}, text
    return parse_meta_lines(m.group(1)), text[m.end():]


# Prototype front matter is the same block wrapped in the first HTML comment.
PROTO_FM = re.compile(r"^\s*<!--[ \t]*\n---\n(.*?)\n---[ \t]*\n-->[ \t]*\n?", re.DOTALL)


def parse_proto(text):
    m = PROTO_FM.match(text)
    if not m:
        return {}, text
    return parse_meta_lines(m.group(1)), text[m.end():]


META_ORDER = ["title", "version", "status", "updated"]


def render_meta(meta):
    meta = dict(meta)
    lines = ["---"]
    for k in META_ORDER:
        if k in meta:
            lines.append("%s: %s" % (k, meta.pop(k)))
    for k, v in meta.items():
        lines.append("%s: %s" % (k, v))
    lines.append("---")
    return "\n".join(lines) + "\n"


def safe_slug(raw):
    """Sanitize a possibly nested slug like 'workspace/plan-name'."""
    parts = [re.sub(r"[^a-zA-Z0-9_-]", "", p) for p in unquote(raw).split("/")]
    return "/".join(p for p in parts if p)


def plan_file(slug):
    return os.path.join(PLANS_DIR, *slug.split("/")) + ".md"


def feedback_file(slug):
    return os.path.join(FEEDBACK_DIR, *slug.split("/")) + ".json"


def inbox_file(slug):
    return os.path.join(INBOX_DIR, slug.replace("/", "__") + ".json")


def proto_dir(slug):
    return os.path.join(PLANS_DIR, *slug.split("/")) + PROTO_EXT


def doc_kind(slug):
    """'plan', 'prototype' or None. A plan wins if both exist."""
    if not slug:
        return None
    if os.path.exists(plan_file(slug)):
        return "plan"
    if os.path.isfile(os.path.join(proto_dir(slug), PROTO_ENTRY)):
        return "prototype"
    return None


def proto_mtime(slug):
    """Newest mtime across the prototype folder, so the shell can poll cheaply."""
    newest = 0.0
    for dirpath, _, files in os.walk(proto_dir(slug)):
        newest = max(newest, os.path.getmtime(dirpath))
        for name in files:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
            except OSError:
                pass
    return newest


def proto_files(slug):
    base = proto_dir(slug)
    out = []
    for dirpath, _, files in os.walk(base):
        for name in files:
            out.append(os.path.relpath(os.path.join(dirpath, name), base).replace(os.sep, "/"))
    return sorted(out)


def write_inbox(slug, count, independent):
    with open(inbox_file(slug), "w") as f:
        json.dump({"slug": slug, "kind": doc_kind(slug) or "plan", "count": count,
                   "at": time.time(),
                   "mode": "independent" if independent else "inline"}, f)


BRIDGE_TAG = '<script src="/static/bridge.js"></script>'


def prepare_proto_html(data):
    """Strip the front matter comment and load the bridge before any
    prototype script runs (it installs the storage shim)."""
    text = data.decode("utf-8", errors="replace")
    m = PROTO_FM.match(text)
    if m:
        text = text[m.end():]
    for pat in (r"<head\b[^>]*>", r"<html\b[^>]*>", r"<!doctype[^>]*>"):
        hit = re.search(pat, text, re.IGNORECASE)
        if hit:
            text = text[:hit.end()] + BRIDGE_TAG + text[hit.end():]
            break
    else:
        text = BRIDGE_TAG + text
    return text.encode("utf-8")


ANCHOR_STRINGS = ("screen", "title", "route", "component", "selector", "tag", "text")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def clean_anchor(a):
    """Keep only known, size capped anchor fields; offsets and boxes are
    fractions of the anchored element's box."""
    if not isinstance(a, dict):
        return None
    out = {}
    for k in ANCHOR_STRINGS:
        v = a.get(k)
        if isinstance(v, str) and v:
            out[k] = v[:500]
    for k, n in (("offset", 2), ("box", 4)):
        v = a.get(k)
        if isinstance(v, list) and len(v) == n and all(_num(x) for x in v):
            out[k] = [round(max(0.0, min(1.0, float(x))), 4) for x in v]
    vp = a.get("viewport")
    if isinstance(vp, dict):
        o = {}
        if isinstance(vp.get("name"), str):
            o["name"] = vp["name"][:20]
        for k in ("w", "h"):
            if _num(vp.get(k)):
                o[k] = int(vp[k])
        if o:
            out["viewport"] = o
    return out or None


SHA_RE = re.compile(r"^[0-9a-f]{4,40}$")
VERSION_IN_SUBJECT = re.compile(r":\s*v(\d+)")


def git(*args):
    """Run git against the nested plans/ repo (never the Redline repo).
    Returns stdout, or None on any failure (not a repo, git missing, file
    untracked) so history is just absent, not fatal."""
    try:
        out = subprocess.run(["git", "-C", PLANS_DIR] + list(args),
                              capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    return out.stdout if out.returncode == 0 else None


def git_bytes(*args):
    """Like git() but binary safe, for serving prototype files from history."""
    try:
        out = subprocess.run(["git", "-C", PLANS_DIR] + list(args),
                              capture_output=True, timeout=10)
    except Exception:
        return None
    return out.stdout if out.returncode == 0 else None


def plan_git_path(slug):
    return slug + ".md"  # relative to PLANS_DIR, the nested repo root


def doc_git_path(slug):
    if doc_kind(slug) == "prototype":
        return slug + PROTO_EXT
    return plan_git_path(slug)


def plan_history(slug):
    path = doc_git_path(slug)
    follow = ["--follow"] if path.endswith(".md") else []  # --follow takes one file
    out = git(*(["log"] + follow + ["--format=%H%x1f%h%x1f%ad%x1f%s",
               "--date=format:%Y-%m-%d %H:%M", "--", path]))
    if not out:
        return []
    commits = []
    for line in out.strip("\n").split("\n"):
        parts = line.split("\x1f")
        if len(parts) != 4:
            continue
        full, short, date, subject = parts
        m = VERSION_IN_SUBJECT.search(subject)
        commits.append({"sha": full, "short": short, "date": date,
                        "subject": subject, "version": m.group(1) if m else None})
    return commits


def plan_at_commit(slug, sha):
    """The plan markdown, or a prototype's index.html, as of a commit."""
    if not SHA_RE.match(sha):
        return None
    if doc_kind(slug) == "prototype":
        return git("show", "%s:%s%s/%s" % (sha, slug, PROTO_EXT, PROTO_ENTRY))
    return git("show", "%s:%s" % (sha, plan_git_path(slug)))


COMPACT_DROP = ("prefix", "suffix", "comment", "suggested_text", "thread", "reply",
                "images")


def compact_resolved(data):
    """Resolved items keep only a 1-2 line resolution; the trail is dropped so
    feedback files stay small when the agent re-reads them."""
    changed = False
    for i in data.get("items", []):
        if i.get("status") != "resolved":
            continue
        if not i.get("resolution"):
            legacy = (i.get("reply") or i.get("comment") or "Resolved.").strip()
            i["resolution"] = legacy[:280]
            changed = True
        for k in COMPACT_DROP:
            if k in i:
                del i[k]
                changed = True
    return changed


def load_feedback(slug):
    path = feedback_file(slug)
    with LOCK:
        if os.path.exists(path):
            with open(path) as f:
                data = json.load(f)
            if compact_resolved(data):
                save_feedback(slug, data)
            return data
    return {"items": []}


def save_feedback(slug, data):
    path = feedback_file(slug)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def feedback_counts(slug):
    counts = {"draft": 0, "submitted": 0, "answered": 0, "resolved": 0}
    for item in load_feedback(slug)["items"]:
        counts[item.get("status", "draft")] = counts.get(item.get("status", "draft"), 0) + 1
    return counts


def list_plans():
    """Plans and prototypes, newest first."""
    plans = []
    for dirpath, dirnames, files in os.walk(PLANS_DIR):
        protos = [d for d in dirnames if d.endswith(PROTO_EXT)]
        # never descend into git internals or into a prototype's own files
        dirnames[:] = [d for d in dirnames if d != ".git" and not d.endswith(PROTO_EXT)]
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, PLANS_DIR)
            slug = rel[:-3].replace(os.sep, "/")
            with open(path) as f:
                meta, _ = parse_front_matter(f.read())
            plans.append({
                "slug": slug, "kind": "plan",
                "workspace": slug.rsplit("/", 1)[0] if "/" in slug else "",
                "title": meta.get("title", slug),
                "version": meta.get("version", "1"),
                "status": meta.get("status", "draft"),
                "updated": meta.get("updated", ""),
                "mtime": os.path.getmtime(path),
                "counts": feedback_counts(slug),
            })
        for d in protos:
            entry = os.path.join(dirpath, d, PROTO_ENTRY)
            if not os.path.isfile(entry):
                continue
            rel = os.path.relpath(os.path.join(dirpath, d), PLANS_DIR)
            slug = rel[:-len(PROTO_EXT)].replace(os.sep, "/")
            if os.path.exists(plan_file(slug)):
                print("redline: %s exists as a plan and a prototype; listing the plan only"
                      % slug, file=sys.stderr)
                continue
            with open(entry, encoding="utf-8", errors="replace") as f:
                text = f.read()
            meta, _ = parse_proto(text)
            screens = set(re.findall(r"data-rl-screen\s*=\s*[\"']([^\"']+)", text))
            plans.append({
                "slug": slug, "kind": "prototype",
                "workspace": slug.rsplit("/", 1)[0] if "/" in slug else "",
                "title": meta.get("title", slug),
                "version": meta.get("version", "1"),
                "status": meta.get("status", "draft"),
                "updated": meta.get("updated", ""),
                "mtime": proto_mtime(slug),
                "screens": len(screens),
                "counts": feedback_counts(slug),
            })
    plans.sort(key=lambda p: -p["mtime"])
    return plans


INDEX_TEMPLATE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redline · plans</title>
<style>
:root {{
  --paper:#faf8f3; --surface:#fff; --ink:#22252e; --muted:#6c7180;
  --accent:#b45309; --line:#e5e1d8;
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --paper:#14161c; --surface:#1c1f27; --ink:#e8e6e1; --muted:#9aa0ad;
          --accent:#f59e0b; --line:#2a2e38; }}
}}
* {{ box-sizing:border-box; margin:0; }}
body {{ background:var(--paper); color:var(--ink);
       font:16px/1.6 Charter, Georgia, serif; padding:48px 24px; }}
main {{ max-width:720px; margin:0 auto; }}
h1 {{ font-size:28px; margin-bottom:4px; }}
.sub {{ color:var(--muted); font:12px ui-monospace, Menlo, monospace;
        text-transform:uppercase; letter-spacing:.08em; margin-bottom:32px; }}
a.card {{ display:block; background:var(--surface); border:1px solid var(--line);
          border-radius:10px; padding:18px 20px; margin-bottom:12px;
          text-decoration:none; color:inherit; }}
a.card:hover {{ border-color:var(--accent); }}
.trow {{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }}
.t {{ font-size:19px; }}
.chip {{ flex:none; font:11px ui-monospace, Menlo, monospace; text-transform:uppercase;
         letter-spacing:.06em; padding:2px 10px; border-radius:999px;
         border:1px solid currentColor; white-space:nowrap;
         background:color-mix(in srgb, currentColor 12%, transparent); }}
.chip.ok {{ color:#15803d; }}
.chip.rev {{ color:#b45309; }}
.chip.dr {{ color:var(--muted); }}
.chip.info {{ color:var(--accent); }}
@media (prefers-color-scheme: dark) {{
  .chip.ok {{ color:#4ade80; }}
  .chip.rev {{ color:#fbbf24; }}
}}
.meta {{ color:var(--muted); font:12px ui-monospace, Menlo, monospace; margin-top:6px; }}
.need {{ color:#dc2626; font-weight:600; }}
@media (prefers-color-scheme: dark) {{ .need {{ color:#f87171; }} }}
.empty {{ color:var(--muted); font-style:italic; }}
h2.ws {{ font:13px ui-monospace, Menlo, monospace; text-transform:uppercase;
         letter-spacing:.08em; color:var(--accent); margin:28px 0 10px;
         padding-bottom:6px; border-bottom:1px solid var(--line); }}
.tl {{ display:flex; align-items:flex-start; gap:10px; min-width:0; flex:1; }}
.tl .t {{ padding-top:1px; }}
.trow .chip {{ margin-top:4px; }}
.kind {{ flex:none; width:30px; height:30px; border-radius:8px; display:grid; place-items:center;
         color:var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); }}
.kind svg {{ width:17px; height:17px; }}
</style></head><body><main>
<h1>Redline</h1>
<div class="sub">plan review server, port {port}</div>
{rows}
</main></body></html>"""


PLAN_ICON = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
             'stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7z"/>'
             '<path d="M14 3v5h5M10 13h6M10 17h6"/></svg>')
PROTO_ICON = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
              'stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" '
              'height="19" rx="2.5"/><path d="M10.5 18.5h3"/><path d="M9 7h6M9 10.5h4"/></svg>')


def status_class(status):
    s = status.lower()
    if any(w in s for w in ("approved", "done", "complete", "shipped")):
        return "ok"
    if "review" in s:
        return "rev"
    if "draft" in s:
        return "dr"
    return "info"


def render_index(port):
    plans = list_plans()
    if not plans:
        rows = '<p class="empty">No plans yet. Claude will write the first one to plans/&lt;workspace&gt;/.</p>'
    else:
        groups = {}
        for p in plans:
            groups.setdefault(p["workspace"], []).append(p)
        esc = html.escape
        rows = ""
        for ws, items in groups.items():
            rows += '<h2 class="ws">%s</h2>' % esc(ws or "ungrouped")
            for p in items:
                c = p["counts"]
                fb = "%d draft, %d waiting, %d resolved" % (c["draft"], c["submitted"], c["resolved"])
                if c.get("answered"):
                    fb = ('<span class="need">%d awaiting your reply</span> &middot; '
                          % c["answered"]) + fb
                proto = p["kind"] == "prototype"
                kind = ('<span class="kind" title="Prototype">%s</span>' % PROTO_ICON) if proto \
                    else ('<span class="kind" title="Plan">%s</span>' % PLAN_ICON)
                extra = ""
                if proto:
                    extra = "prototype &middot; %d screen%s &middot; " % (
                        p["screens"], "" if p["screens"] == 1 else "s")
                rows += (
                    '<a class="card" href="/%s/%s">'
                    '<div class="trow"><div class="tl">%s<div class="t">%s</div></div>'
                    '<span class="chip %s">%s</span></div>'
                    '<div class="meta">%sv%s &middot; updated %s &middot; %s</div></a>'
                    % ("proto" if proto else "plan", esc(p["slug"]), kind, esc(p["title"]),
                       status_class(p["status"]), esc(p["status"]), extra,
                       esc(p["version"]), esc(p["updated"]), fb)
                )
    return INDEX_TEMPLATE.format(port=port, rows=rows)


SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"

STATIC_TYPES = {"js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                "svg": "image/svg+xml", "html": "text/html; charset=utf-8",
                "json": "application/json", "mjs": "text/javascript; charset=utf-8",
                "woff2": "font/woff2", "webp": "image/webp"}


def content_type(name):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in STATIC_TYPES:
        return STATIC_TYPES[ext]
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def split_proto_path(raw, exists):
    """Split '<ws>/<slug>/<file path>' at the first prefix that names a
    prototype (exists(slug) decides). Returns (slug, subpath, had_sub) or None."""
    segs = [s for s in unquote(raw).split("/") if s]
    if any(s in (".", "..") for s in segs):
        return None
    for i in range(1, len(segs) + 1):
        slug = safe_slug("/".join(segs[:i]))
        if slug and exists(slug):
            sub = "/".join(segs[i:])
            return slug, sub or PROTO_ENTRY, bool(sub) or raw.endswith("/")
    return None


def proto_download(slug, sha=None):
    """(bytes, filename, ctype): a lone index.html downloads as .html, a
    folder as a zip."""
    name = slug.replace("/", "-")
    if sha is None:
        files = proto_files(slug)
        with open(os.path.join(proto_dir(slug), PROTO_ENTRY), encoding="utf-8",
                  errors="replace") as f:
            version = parse_proto(f.read())[0].get("version", "1")
        tag = "v%s" % version
        if files == [PROTO_ENTRY]:
            with open(os.path.join(proto_dir(slug), PROTO_ENTRY), "rb") as f:
                return f.read(), "%s.%s.html" % (name, tag), "text/html; charset=utf-8"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for rel in files:
                z.write(os.path.join(proto_dir(slug), *rel.split("/")), "%s/%s" % (name, rel))
        return buf.getvalue(), "%s.%s.zip" % (name, tag), "application/zip"
    rel = slug + PROTO_EXT
    entry = git("show", "%s:%s/%s" % (sha, rel, PROTO_ENTRY))
    if entry is None:
        return None
    tag = "v%s-%s" % (parse_proto(entry)[0].get("version", "x"), sha[:7])
    listing = (git("ls-tree", "-r", "--name-only", sha, "--", rel) or "").split()
    if len(listing) == 1:
        return entry.encode(), "%s.%s.html" % (name, tag), "text/html; charset=utf-8"
    data = git_bytes("archive", "--format=zip", "--prefix=%s/" % name, "%s:%s" % (sha, rel))
    if data is None:
        return None
    return data, "%s.%s.zip" % (name, tag), "application/zip"


def bump(version):
    try:
        return str(int(version) + 1)
    except (TypeError, ValueError):
        return version or "1"


def restore_proto(slug, sha, old_entry):
    """Put the prototype folder back exactly as it was at sha (files added
    since are removed), stamp a new version, commit. Nothing is lost: the
    versions in between stay in history."""
    rel = slug + PROTO_EXT
    entry = os.path.join(proto_dir(slug), PROTO_ENTRY)
    with LOCK:
        with open(entry, encoding="utf-8", errors="replace") as f:
            cur_meta, _ = parse_proto(f.read())
        new_version = bump(cur_meta.get("version", "1"))
        folder = proto_dir(slug)
        backup = folder + ".restoring"
        if os.path.exists(backup):
            shutil.rmtree(backup)
        shutil.move(folder, backup)  # set aside, so a failed checkout loses nothing
        if git("checkout", sha, "--", rel) is None or not os.path.isfile(entry):
            if os.path.exists(folder):
                shutil.rmtree(folder)
            shutil.move(backup, folder)
            return {"ok": False, "error": "restore failed"}
        shutil.rmtree(backup)
        old_meta, old_body = parse_proto(old_entry)
        old_meta["version"] = new_version
        old_meta["updated"] = time.strftime("%Y-%m-%d")
        with open(entry, "w", encoding="utf-8") as f:
            f.write("<!--\n" + render_meta(old_meta) + "-->\n" + old_body)
        git("add", "-A", "--", rel)
        git("commit", "-m", "%s: v%s - restored from %s" % (slug, new_version, sha[:7]))
    return {"ok": True, "version": new_version}


class Handler(BaseHTTPRequestHandler):
    server_version = "PlanServer/1.0"

    def log_message(self, fmt, *args):
        pass

    def send_bytes(self, data, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, code=200):
        self.send_bytes(json.dumps(obj).encode(), "application/json", code)

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_proto(self, data, name):
        """Prototype files: sandboxed even when opened directly in a tab, so
        prototype code never runs with the Redline origin."""
        ctype = content_type(name)
        if ctype.startswith("text/html"):
            data = prepare_proto_html(data)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "sandbox " + SANDBOX)
        self.end_headers()
        self.wfile.write(data)

    def send_download(self, data, filename, ctype="text/markdown; charset=utf-8"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path, ctype):
        try:
            with open(path, "rb") as f:
                self.send_bytes(f.read(), ctype)
        except FileNotFoundError:
            self.send_json({"error": "not found"}, 404)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def host_allowed(self):
        host = self.headers.get("Host") or ""
        if host.startswith("["):  # IPv6 literal, e.g. [::1]:4747
            host = host.split("]")[0] + "]"
        else:
            host = host.rsplit(":", 1)[0]
        if host in ALLOWED_HOSTS:
            return True
        self.send_json({"error": "forbidden host"}, 403)
        return False

    def post_allowed(self):
        """Any page open in the browser can fire a text/plain POST at
        localhost, and the Host check passes; that would plant feedback an
        agent then acts on. Requiring JSON forces a CORS preflight the server
        never approves, and the Origin check rejects other local origins
        (including sandboxed prototypes, whose Origin is 'null')."""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self.send_json({"error": "expected application/json"}, 415)
            return False
        origin = self.headers.get("Origin")
        if origin is not None:
            port = self.server.server_address[1]
            if origin not in {"http://%s:%d" % (h, port) for h in ALLOWED_HOSTS}:
                self.send_json({"error": "forbidden origin"}, 403)
                return False
        return True

    def do_GET(self):
        try:
            if self.host_allowed():
                self.route_get()
        except BrokenPipeError:
            pass
        except Exception:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self.send_json({"error": "internal error"}, 500)

    def do_POST(self):
        try:
            if self.host_allowed() and self.post_allowed():
                self.route_post()
        except BrokenPipeError:
            pass
        except Exception:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self.send_json({"error": "internal error"}, 500)

    def route_get(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self.send_json({"ok": True, "time": time.time()})
        if path in ("/", "/index.html"):
            return self.send_bytes(render_index(self.server.server_address[1]).encode(), "text/html")
        if path.startswith("/vendor/"):
            name = os.path.basename(path)
            return self.send_file(os.path.join(VENDOR_DIR, name), "application/javascript")
        if path.startswith("/uploads/"):
            name = os.path.basename(path)
            ext = name.rsplit(".", 1)[-1].lower()
            ctype = {v: k for k, v in IMAGE_TYPES.items()}.get(ext, "application/octet-stream")
            return self.send_file(os.path.join(UPLOADS_DIR, name), ctype)
        if path.startswith("/static/"):
            name = os.path.basename(path)
            return self.send_file(os.path.join(STATIC_DIR, name), content_type(name))
        if path.startswith("/plan/"):
            slug = safe_slug(path[len("/plan/"):])
            if doc_kind(slug) == "prototype":
                return self.redirect("/proto/" + slug)
            return self.send_file(os.path.join(ROOT, "viewer.html"), "text/html")
        if path.startswith("/proto/"):
            slug = safe_slug(path[len("/proto/"):])
            if doc_kind(slug) == "plan":
                return self.redirect("/plan/" + slug)
            return self.send_file(os.path.join(ROOT, "prototype.html"), "text/html")
        if path.startswith("/p/"):
            hit = split_proto_path(path[len("/p/"):], lambda s: doc_kind(s) == "prototype")
            if not hit:
                return self.send_json({"error": "not found"}, 404)
            slug, sub, had_sub = hit
            if not had_sub:  # relative asset URLs need the trailing slash
                query = self.path[len(path):]
                return self.redirect("/p/%s/%s" % (slug, query))
            base = os.path.realpath(proto_dir(slug))
            target = os.path.realpath(os.path.join(base, *sub.split("/")))
            if target != base and not target.startswith(base + os.sep):
                return self.send_json({"error": "not found"}, 404)
            if os.path.isdir(target):
                target = os.path.join(target, PROTO_ENTRY)
            if not os.path.isfile(target):
                return self.send_json({"error": "not found"}, 404)
            with open(target, "rb") as f:
                return self.send_proto(f.read(), target)
        if path.startswith("/p-at/"):
            sha, _, rest = path[len("/p-at/"):].partition("/")
            if not SHA_RE.match(sha):
                return self.send_json({"error": "not found"}, 404)
            hit = split_proto_path(rest, lambda s: git_bytes(
                "cat-file", "-e", "%s:%s%s/%s" % (sha, s, PROTO_EXT, PROTO_ENTRY)) is not None)
            if not hit:
                return self.send_json({"error": "not found"}, 404)
            slug, sub, had_sub = hit
            if not had_sub:
                return self.redirect("/p-at/%s/%s/" % (sha, slug))
            sub = sub.rstrip("/")
            data = git_bytes("show", "%s:%s%s/%s" % (sha, slug, PROTO_EXT, sub))
            if data is None:
                sub = sub + "/" + PROTO_ENTRY
                data = git_bytes("show", "%s:%s%s/%s" % (sha, slug, PROTO_EXT, sub))
            if data is None:
                return self.send_json({"error": "not found"}, 404)
            return self.send_proto(data, sub)
        if path.startswith("/api/proto/"):
            slug = safe_slug(path[len("/api/proto/"):])
            if doc_kind(slug) != "prototype":
                return self.send_json({"error": "not found"}, 404)
            with open(os.path.join(proto_dir(slug), PROTO_ENTRY), encoding="utf-8",
                      errors="replace") as f:
                meta, _ = parse_proto(f.read())
            return self.send_json({"slug": slug, "kind": "prototype", "meta": meta,
                                   "mtime": proto_mtime(slug)})
        if path.startswith("/api/plan/"):
            slug = safe_slug(path[len("/api/plan/"):])
            p = plan_file(slug)
            if not os.path.exists(p):
                return self.send_json({"error": "not found"}, 404)
            with open(p) as f:
                meta, body = parse_front_matter(f.read())
            return self.send_json({"slug": slug, "meta": meta, "markdown": body,
                                   "mtime": os.path.getmtime(p)})
        if path.startswith("/api/feedback/"):
            slug = safe_slug(path[len("/api/feedback/"):])
            return self.send_json(load_feedback(slug))
        if path.startswith("/api/history/"):
            slug = safe_slug(path[len("/api/history/"):])
            return self.send_json({"slug": slug, "commits": plan_history(slug)})
        if path.startswith("/api/history-at/"):
            rest = path[len("/api/history-at/"):]
            sha, _, slug_raw = rest.partition("/")
            slug = safe_slug(slug_raw)
            content = plan_at_commit(slug, sha) if slug else None
            if content is None:
                return self.send_json({"error": "not found"}, 404)
            if doc_kind(slug) == "prototype":
                meta, _ = parse_proto(content)
                return self.send_json({"slug": slug, "sha": sha, "meta": meta,
                                       "kind": "prototype"})
            meta, body = parse_front_matter(content)
            return self.send_json({"slug": slug, "sha": sha, "meta": meta, "markdown": body})
        if path.startswith("/raw/"):
            slug = safe_slug(path[len("/raw/"):])
            if doc_kind(slug) == "prototype":
                data, fname, ctype = proto_download(slug)
                return self.send_download(data, fname, ctype)
            p = plan_file(slug)
            if not os.path.exists(p):
                return self.send_json({"error": "not found"}, 404)
            with open(p, "rb") as f:
                data = f.read()
            with open(p) as f:
                meta, _ = parse_front_matter(f.read())
            fname = "%s.v%s.md" % (slug.replace("/", "-"), meta.get("version", "1"))
            return self.send_download(data, fname)
        if path.startswith("/raw-at/"):
            rest = path[len("/raw-at/"):]
            sha, _, slug_raw = rest.partition("/")
            slug = safe_slug(slug_raw)
            if slug and SHA_RE.match(sha) and doc_kind(slug) == "prototype":
                got = proto_download(slug, sha)
                if got is None:
                    return self.send_json({"error": "not found"}, 404)
                return self.send_download(*got)
            content = plan_at_commit(slug, sha) if slug else None
            if content is None:
                return self.send_json({"error": "not found"}, 404)
            meta, _ = parse_front_matter(content)
            fname = "%s.v%s-%s.md" % (slug.replace("/", "-"), meta.get("version", "x"), sha[:7])
            return self.send_download(content.encode(), fname)
        self.send_json({"error": "not found"}, 404)

    def route_post(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]

        if len(parts) >= 4 and parts[:2] == ["api", "feedback"] and parts[-1] == "delete":
            slug = safe_slug("/".join(parts[2:-1]))
            body = self.read_body()
            with LOCK:
                data = load_feedback(slug)
                data["items"] = [i for i in data["items"]
                                 if not (i.get("id") == body.get("id")
                                         and i.get("status") == "draft")]
                save_feedback(slug, data)
            return self.send_json({"ok": True})

        if len(parts) >= 3 and parts[:2] == ["api", "upload"]:
            slug = safe_slug("/".join(parts[2:]))
            body = self.read_body()
            m = re.match(r"^data:(image/(?:png|jpeg|webp|gif));base64,(.+)$",
                         body.get("data") or "", re.DOTALL)
            if not m:
                return self.send_json({"error": "expected a base64 image data url"}, 400)
            if len(m.group(2)) > 15_000_000:
                return self.send_json({"error": "image too large"}, 413)
            raw = base64.b64decode(m.group(2))
            name = "%s__%d-%s.%s" % (slug.replace("/", "__"), int(time.time() * 1000),
                                     os.urandom(2).hex(), IMAGE_TYPES[m.group(1)])
            with open(os.path.join(UPLOADS_DIR, name), "wb") as f:
                f.write(raw)
            return self.send_json({"ok": True, "url": "/uploads/" + name})

        if len(parts) >= 3 and parts[:2] == ["api", "feedback"]:
            slug = safe_slug("/".join(parts[2:]))
            item = self.read_body()
            allowed = {"type", "quote", "prefix", "suffix", "section",
                       "comment", "suggested_text", "images", "kind", "anchor"}
            item = {k: v for k, v in item.items() if k in allowed}
            if item.get("kind") not in (None, "pin", "screen"):
                del item["kind"]
            if "anchor" in item:
                item["anchor"] = clean_anchor(item["anchor"])
                if not item["anchor"]:
                    del item["anchor"]
            if "images" in item:
                item["images"] = clean_image_urls(item["images"])
                if not item["images"]:
                    del item["images"]
            with LOCK:
                data = load_feedback(slug)
                item["id"] = "fb%d" % int(time.time() * 1000)
                item["status"] = "draft"
                item["created"] = time.time()
                data["items"].append(item)
                save_feedback(slug, data)
            return self.send_json({"ok": True, "id": item["id"]})

        if len(parts) >= 3 and parts[:2] == ["api", "reply"]:
            slug = safe_slug("/".join(parts[2:]))
            body = self.read_body()
            text = (body.get("text") or "").strip()
            if not text and not clean_image_urls(body.get("images")):
                return self.send_json({"error": "empty reply"}, 400)
            with LOCK:
                data = load_feedback(slug)
                hit = False
                for i in data["items"]:
                    if i.get("id") == body.get("id"):
                        msg = {"who": "user", "text": text, "at": time.time()}
                        images = clean_image_urls(body.get("images"))
                        if images:
                            msg["images"] = images
                        i.setdefault("thread", []).append(msg)
                        i["status"] = "submitted"
                        hit = True
                if hit:
                    save_feedback(slug, data)
                    write_inbox(slug, 1, body.get("independent"))
            return self.send_json({"ok": hit})

        if len(parts) >= 4 and parts[:2] == ["api", "restore"]:
            sha = parts[2]
            slug = safe_slug("/".join(parts[3:]))
            if not SHA_RE.match(sha) or not slug:
                return self.send_json({"error": "bad request"}, 400)
            content = plan_at_commit(slug, sha)
            if content is None:
                return self.send_json({"error": "version not found"}, 404)
            if doc_kind(slug) == "prototype":
                result = restore_proto(slug, sha, content)
                return self.send_json(result, 200 if result["ok"] else 500)
            p = plan_file(slug)
            if not os.path.exists(p):
                return self.send_json({"error": "plan not found"}, 404)
            with LOCK:
                with open(p) as f:
                    cur_meta, _ = parse_front_matter(f.read())
                old_meta, old_body = parse_front_matter(content)
                try:
                    new_version = str(int(cur_meta.get("version", "1")) + 1)
                except ValueError:
                    new_version = cur_meta.get("version", "1")
                new_meta = dict(old_meta)
                new_meta["version"] = new_version
                new_meta["updated"] = time.strftime("%Y-%m-%d")
                new_text = render_meta(new_meta) + old_body
                with open(p, "w") as f:
                    f.write(new_text)
                git("add", plan_git_path(slug))
                git("commit", "-m", "%s: v%s - restored from %s" % (slug, new_version, sha[:7]))
            return self.send_json({"ok": True, "version": new_version})

        if len(parts) >= 3 and parts[:2] == ["api", "submit"]:
            slug = safe_slug("/".join(parts[2:]))
            body = self.read_body()
            with LOCK:
                data = load_feedback(slug)
                n = 0
                for i in data["items"]:
                    if i.get("status") == "draft":
                        i["status"] = "submitted"
                        n += 1
                if n:
                    data["submitted_at"] = time.time()
                    save_feedback(slug, data)
                    write_inbox(slug, n, body.get("independent"))
            return self.send_json({"ok": True, "submitted": n})

        self.send_json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4747)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("plan server on http://127.0.0.1:%d" % args.port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
