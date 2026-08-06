#!/usr/bin/env python3
"""Local plan review server.

Serves plan markdown files as reviewable HTML pages, collects inline
comments and suggested edits from the browser, and drops a signal file
in inbox/ when the user submits a batch so Claude can pick it up.

Stdlib only. Run: python3 server.py [--port 4747]
"""
import argparse
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
PLANS_DIR = os.path.join(ROOT, "plans")
FEEDBACK_DIR = os.path.join(ROOT, "feedback")
INBOX_DIR = os.path.join(ROOT, "inbox")
VENDOR_DIR = os.path.join(ROOT, "vendor")

LOCK = threading.Lock()

for d in (PLANS_DIR, FEEDBACK_DIR, INBOX_DIR, VENDOR_DIR):
    os.makedirs(d, exist_ok=True)


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
    return re.sub(r"[^a-zA-Z0-9_-]", "", unquote(raw))


def plan_file(slug):
    return os.path.join(PLANS_DIR, slug + ".md")


def feedback_file(slug):
    return os.path.join(FEEDBACK_DIR, slug + ".json")


def load_feedback(slug):
    path = feedback_file(slug)
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"items": []}


def save_feedback(slug, data):
    with open(feedback_file(slug), "w") as f:
        json.dump(data, f, indent=2)


def list_plans():
    plans = []
    for name in os.listdir(PLANS_DIR):
        if not name.endswith(".md"):
            continue
        slug = name[:-3]
        path = os.path.join(PLANS_DIR, name)
        with open(path) as f:
            meta, _ = parse_front_matter(f.read())
        counts = {"draft": 0, "submitted": 0, "resolved": 0}
        for item in load_feedback(slug)["items"]:
            counts[item.get("status", "draft")] = counts.get(item.get("status", "draft"), 0) + 1
        plans.append({
            "slug": slug,
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
.t {{ font-size:19px; }}
.meta {{ color:var(--muted); font:12px ui-monospace, Menlo, monospace; margin-top:6px; }}
.empty {{ color:var(--muted); font-style:italic; }}
</style></head><body><main>
<h1>Plans</h1>
<div class="sub">plan review server, port {port}</div>
{rows}
</main></body></html>"""


def render_index(port):
    plans = list_plans()
    if not plans:
        rows = '<p class="empty">No plans yet. Claude will write the first one to plans/.</p>'
    else:
        rows = ""
        for p in plans:
            c = p["counts"]
            fb = "%d draft, %d waiting, %d resolved" % (c["draft"], c["submitted"], c["resolved"])
            rows += (
                '<a class="card" href="/plan/%s"><div class="t">%s</div>'
                '<div class="meta">v%s &middot; %s &middot; updated %s &middot; %s</div></a>'
                % (p["slug"], p["title"], p["version"], p["status"], p["updated"], fb)
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
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def do_GET(self):
        try:
            self.route_get()
        except BrokenPipeError:
            pass
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        try:
            self.route_post()
        except BrokenPipeError:
            pass
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def route_get(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self.send_json({"ok": True, "time": time.time()})
        if path in ("/", "/index.html"):
            return self.send_bytes(render_index(self.server.server_address[1]).encode(), "text/html")
        if path.startswith("/vendor/"):
            name = os.path.basename(path)
            return self.send_file(os.path.join(VENDOR_DIR, name), "application/javascript")
        if path.startswith("/plan/"):
            return self.send_file(os.path.join(ROOT, "viewer.html"), "text/html")
        if path.startswith("/api/plan/"):
            slug = safe_slug(path.rsplit("/", 1)[1])
            p = plan_file(slug)
            if not os.path.exists(p):
                return self.send_json({"error": "not found"}, 404)
            with open(p) as f:
                meta, body = parse_front_matter(f.read())
            return self.send_json({"slug": slug, "meta": meta, "markdown": body,
                                   "mtime": os.path.getmtime(p)})
        if path.startswith("/api/feedback/"):
            slug = safe_slug(path.rsplit("/", 1)[1])
            return self.send_json(load_feedback(slug))
        self.send_json({"error": "not found"}, 404)

    def route_post(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]

        if len(parts) == 4 and parts[:2] == ["api", "feedback"] and parts[3] == "delete":
            slug = safe_slug(parts[2])
            body = self.read_body()
            with LOCK:
                data = load_feedback(slug)
                data["items"] = [i for i in data["items"]
                                 if not (i.get("id") == body.get("id")
                                         and i.get("status") == "draft")]
                save_feedback(slug, data)
            return self.send_json({"ok": True})

        if len(parts) == 3 and parts[:2] == ["api", "feedback"]:
            slug = safe_slug(parts[2])
            item = self.read_body()
            allowed = {"type", "quote", "prefix", "suffix", "section",
                       "comment", "suggested_text"}
            item = {k: v for k, v in item.items() if k in allowed}
            with LOCK:
                data = load_feedback(slug)
                item["id"] = "fb%d" % int(time.time() * 1000)
                item["status"] = "draft"
                item["created"] = time.time()
                data["items"].append(item)
                save_feedback(slug, data)
            return self.send_json({"ok": True, "id": item["id"]})

        if len(parts) == 3 and parts[:2] == ["api", "submit"]:
            slug = safe_slug(parts[2])
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
                    with open(os.path.join(INBOX_DIR, slug + ".json"), "w") as f:
                        json.dump({"slug": slug, "count": n, "at": time.time()}, f)
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
