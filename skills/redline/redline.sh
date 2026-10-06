#!/bin/sh
# Start, find, check or stop the local Redline server. Works the same from a
# git clone and from the Claude Code plugin cache. There is only ever one
# server per data directory: start and url reuse a running one.
#   redline.sh start     start in the background unless already running
#   redline.sh url       print the server's URL (starting it if needed)
#   redline.sh status    say whether it is running, and where
#   redline.sh stop      stop it
#   redline.sh data      print the review data directory
# REDLINE_PORT (preferred port) and REDLINE_HOME (data directory) are honoured.
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/../.." && pwd -P)
command -v python3 >/dev/null 2>&1 || { echo "Redline needs python3" >&2; exit 1; }

case "${1:-start}" in
  start)  exec python3 "$root/server.py" --daemon ;;
  url)    exec python3 "$root/server.py" --url ;;
  status) exec python3 "$root/server.py" --status ;;
  stop)   exec python3 "$root/server.py" --stop ;;
  data)   exec python3 "$root/server.py" --print-data ;;
  *)      echo "usage: redline.sh [start|url|status|stop|data]" >&2; exit 2 ;;
esac
