#!/usr/bin/env bash
# particle local dev — docker compose on OrbStack, port 4747
# Commands: start | stop | restart | status. Non-interactive,
# start refuses an occupied port, logs land in .dev/.
set -euo pipefail
cd "$(dirname "$0")"

PORT=4747
mkdir -p .dev

log() { echo "[dev.sh] $*"; }

port_holder() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

is_ours() {
  # true when the port is held by our compose service (docker-proxy or OrbStack vm)
  docker compose ps --status running --format '{{.Name}}' 2>/dev/null | grep -q '^particle$'
}

start() {
  if [[ -n "$(port_holder)" ]]; then
    if is_ours; then
      log "particle already running on :$PORT"
      exit 0
    fi
    log "refusing to start: port $PORT is held by another process (pid $(port_holder))"
    log "run './dev.sh restart' if a stale particle container holds it, or free the port"
    exit 1
  fi
  log "building + starting particle on :$PORT"
  docker compose up -d --build
  log "started — http://localhost:$PORT"
}

stop() {
  log "stopping particle"
  docker compose down --remove-orphans
  log "stopped"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    docker compose down --remove-orphans 2>/dev/null || true
    # the dying docker-proxy can hold the port for a beat after `down`
    for _ in $(seq 1 20); do [[ -z "$(port_holder)" ]] && break; sleep 0.5; done
    start
    ;;
  status)
    if is_ours; then log "running — http://localhost:$PORT"; else log "not running"; fi
    ;;
  # ./dev.sh logs            → follow everything
  # ./dev.sh logs screenshot  → follow only lines mentioning screenshots
  logs)
    if [[ -n "${2:-}" ]]; then
      docker compose logs -f --tail 200 particle | grep --line-buffered -i "$2"
    else
      docker compose logs -f --tail 200 particle
    fi
    ;;
  *) echo "usage: ./dev.sh {start|stop|restart|status|logs [filter]}" >&2; exit 2 ;;
esac
