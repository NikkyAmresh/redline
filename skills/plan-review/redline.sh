#!/bin/sh
# Start, stop or check the local Redline server. Works the same from a git
# clone (~/.claude/plan-server) and from the Claude Code plugin cache.
#   redline.sh start     start in the background unless already running
#   redline.sh stop      stop a server started by this script
#   redline.sh status    print whether it is running, and where
#   redline.sh data      print the review data directory
# REDLINE_PORT (default 4747) and REDLINE_HOME (data directory) are honoured.
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/../.." && pwd -P)
port=${REDLINE_PORT:-4747}
url="http://127.0.0.1:$port"

up() { curl -sf -m 2 "$url/api/health" >/dev/null 2>&1; }
data() { python3 "$root/server.py" --print-data; }

case "${1:-start}" in
  start)
    if up; then echo "Redline is running at $url"; exit 0; fi
    command -v python3 >/dev/null 2>&1 || { echo "Redline needs python3" >&2; exit 1; }
    python3 "$root/server.py" --port "$port" --daemon || exit 1
    i=0
    while [ $i -lt 50 ]; do
      if up; then echo "Redline started at $url"; exit 0; fi
      sleep 0.1
      i=$((i + 1))
    done
    echo "Redline did not start; see $(data)/server.log" >&2
    exit 1
    ;;
  stop)
    pidfile="$(data)/server.pid"
    if [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null; then
      rm -f "$pidfile"
      echo "Redline stopped"
    else
      echo "No Redline server started by this script is running"
    fi
    ;;
  status)
    if up; then echo "Redline is running at $url (data: $(data))"; else echo "Redline is not running (data: $(data))"; exit 1; fi
    ;;
  data)
    data
    ;;
  *)
    echo "usage: redline.sh [start|stop|status|data]" >&2
    exit 2
    ;;
esac
