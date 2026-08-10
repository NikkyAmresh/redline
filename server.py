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
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
PLANS_DIR = os.path.join(ROOT, "plans")
FEEDBACK_DIR = os.path.join(ROOT, "feedback")
INBOX_DIR = os.path.join(ROOT, "inbox")
VENDOR_DIR = os.path.join(ROOT, "vendor")
UPLOADS_DIR = os.path.join(ROOT, "uploads")

LOCK = threading.RLock()

# The server is local-only by design. Rejecting foreign Host headers stops
# DNS rebinding, where a malicious page resolves its own domain to 127.0.0.1
# to read plans or post feedback through the visitor's browser.
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]"}

MAX_BODY = 32 * 1024 * 1024  # fits a 15 MB image as a base64 JSON field

for d in (PLANS_DIR, FEEDBACK_DIR, INBOX_DIR, VENDOR_DIR, UPLOADS_DIR):
    os.makedirs(d, exist_ok=True)

IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg",
               "image/webp": "webp", "image/gif": "gif"}


def clean_image_urls(value):
    if not isinstance(value, list):
        return []
    return [u for u in value
            if isinstance(u, str) and re.match(r"^/uploads/[\w.-]+$", u)]


def parse_front_matter(text):
    meta = {}
    body = text
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        body = text[m.end():]
    return meta, body


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


def list_plans():
    plans = []
    for dirpath, _, files in os.walk(PLANS_DIR):
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, PLANS_DIR)
            slug = rel[:-3].replace(os.sep, "/")
            with open(path) as f:
                meta, _ = parse_front_matter(f.read())
            counts = {"draft": 0, "submitted": 0, "answered": 0, "resolved": 0}
            for item in load_feedback(slug)["items"]:
                counts[item.get("status", "draft")] = counts.get(item.get("status", "draft"), 0) + 1
            plans.append({
                "slug": slug,
                "workspace": slug.rsplit("/", 1)[0] if "/" in slug else "",
                "title": meta.get("title", slug),
                "version": meta.get("version", "1"),
                "status": meta.get("status", "draft"),
                "updated": meta.get("updated", ""),
                "mtime": os.path.getmtime(path),
                "counts": counts,
            })
    plans.sort(key=lambda p: -p["mtime"])
    return plans


INDEX_TEMPLATE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plans</title>
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
.trow {{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; }}
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
</style></head><body><main>
<h1>Plans</h1>
<div class="sub">plan review server, port {port}</div>
{rows}
</main></body></html>"""


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
                rows += (
                    '<a class="card" href="/plan/%s">'
                    '<div class="trow"><div class="t">%s</div>'
                    '<span class="chip %s">%s</span></div>'
                    '<div class="meta">v%s &middot; updated %s &middot; %s</div></a>'
                    % (esc(p["slug"]), esc(p["title"]), status_class(p["status"]),
                       esc(p["status"]), esc(p["version"]), esc(p["updated"]), fb)
                )
    return INDEX_TEMPLATE.format(port=port, rows=rows)


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
            if self.host_allowed():
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
        if path.startswith("/plan/"):
            return self.send_file(os.path.join(ROOT, "viewer.html"), "text/html")
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
                       "comment", "suggested_text", "images"}
            item = {k: v for k, v in item.items() if k in allowed}
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
                    mode = "independent" if body.get("independent") else "inline"
                    with open(inbox_file(slug), "w") as f:
                        json.dump({"slug": slug, "count": 1, "at": time.time(),
                                   "mode": mode}, f)
            return self.send_json({"ok": hit})

        if len(parts) >= 3 and parts[:2] == ["api", "submit"]:
            slug = safe_slug("/".join(parts[2:]))
            body = self.read_body()
            mode = "independent" if body.get("independent") else "inline"
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
                    with open(inbox_file(slug), "w") as f:
                        json.dump({"slug": slug, "count": n, "at": time.time(),
                                   "mode": mode}, f)
            return self.send_json({"ok": True, "submitted": n})

        self.send_json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4747)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("plan server on http://localhost:%d" % args.port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
