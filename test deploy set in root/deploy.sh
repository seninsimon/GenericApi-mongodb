#!/usr/bin/env bash
# Zenin ERP: one-step deployment on an always-on office computer (Linux).
#
#   ./deploy.sh                    install, or update after pulling new code
#   ./deploy.sh status             is everything running? last backup? disk space?
#   ./deploy.sh logs [service]     follow the logs (api, worker, web, db, storage)
#   ./deploy.sh backup             back up the database, uploaded files and settings now
#   ./deploy.sh restore <folder>   restore a backup folder (asks you to type RESTORE)
#   ./deploy.sh password <user>    set a new password for a user (e.g. a locked-out admin)
#   ./deploy.sh wipe               delete ALL data and files, keep the system (asks you to type WIPE)
#   ./deploy.sh demo [--size=small|medium|large]   load the demo company into an empty system
#   ./deploy.sh stop | start       stop or start the whole system
#   ./deploy.sh public [token]     make it reachable from anywhere over HTTPS (free; see DEPLOYMENT.md)
#   ./deploy.sh private            turn public access off again (office network only)
#
# Install option:  --allow-sleep   don't disable suspend/hibernate on this computer
#
# Safe to run again at any time: it keeps your data and settings, backs up the
# database first, rebuilds, and waits until everything is healthy.
# Full guide: DEPLOYMENT.md
set -Eeuo pipefail

CALLER_PWD=$PWD
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
ROOT=$PWD
PROJECT=generic-erp # must match "name:" in docker-compose.yml
CRON_FILE=/etc/cron.d/zenin-erp
BACKUP_LOG=/var/log/zenin-erp-backup.log
HELPER_IMAGE=postgres:16-alpine # already pulled for the db; has tar and gzip

if [ -t 1 ]; then
  c_blue=$'\033[1;34m' c_green=$'\033[1;32m' c_yellow=$'\033[1;33m' c_red=$'\033[1;31m' c_off=$'\033[0m'
else
  c_blue='' c_green='' c_yellow='' c_red='' c_off=''
fi
log() { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok() { printf '  %s✓%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die() {
  printf '%sError:%s %s\n' "$c_red" "$c_off" "$*" >&2
  exit 1
}
trap 'die "command failed (line $LINENO): $BASH_COMMAND"' ERR

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# letters and digits only, so values are safe in URLs and .env
random() {
  local value
  value=$(
    set +o pipefail
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-32}"
  )
  printf '%s' "$value"
}

# ---------------------------------------------------------------- .env

env_get() { # env_get KEY [default]
  local value=""
  [ -f .env ] && value=$(grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true)
  printf '%s' "${value:-${2:-}}"
}

env_set() { # env_set KEY VALUE  (values are letters/digits/paths: no sed escaping needed)
  if grep -qE "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}

port_in_use() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }

# ---------------------------------------------------------------- docker

DOCKER=(docker)

require_docker() {
  command -v docker >/dev/null || die "Docker is not installed. Run ./deploy.sh (without arguments) first."
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif [ -n "$SUDO" ] && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    die "Docker is installed but not running. Try: sudo systemctl start docker"
  fi
}

compose() { "${DOCKER[@]}" compose "$@"; }
volume_exists() { "${DOCKER[@]}" volume inspect "${PROJECT}_$1" >/dev/null 2>&1; }
container_id() { compose ps -q "$1" 2>/dev/null || true; }
running() { [ -n "$(compose ps -q --status running "$1" 2>/dev/null || true)" ]; }

install_docker() {
  if ! command -v docker >/dev/null; then
    log "Installing Docker (official installer from get.docker.com)"
    command -v curl >/dev/null || die "curl is needed to install Docker: sudo apt install curl"
    local installer
    installer=$(mktemp)
    curl -fsSL https://get.docker.com -o "$installer"
    $SUDO sh "$installer"
    rm -f "$installer"
    ok "Docker installed"
  fi
  if command -v systemctl >/dev/null; then
    # start now and on every boot; the containers restart with it
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || warn "could not enable the docker service at boot"
  fi
  require_docker
  compose version >/dev/null 2>&1 ||
    die "Docker Compose is missing. Install it: sudo apt install docker-compose-plugin"
  ok "Docker $("${DOCKER[@]}" version --format '{{.Server.Version}}' 2>/dev/null) and Compose $(compose version --short) ready"
}

# ---------------------------------------------------------------- install steps

FRESH_ENV=0
EXISTING_DB=0

create_env() {
  volume_exists pgdata && EXISTING_DB=1
  if [ -f .env ]; then
    ok "Using the existing settings in .env"
    return
  fi
  log "Creating .env with new random passwords"
  [ -f .env.example ] || die ".env.example is missing"
  cp .env.example .env
  chmod 600 .env
  FRESH_ENV=1

  env_set POSTGRES_PASSWORD "$(random 32)"
  # an existing storage volume keeps the keys it was created with, to be safe
  # (storage is only reachable inside docker and from this computer anyway)
  if ! volume_exists storage; then
    env_set S3_ACCESS_KEY "erp$(random 17)"
    env_set S3_SECRET_KEY "$(random 40)"
  fi
  env_set ADMIN_PASSWORD "$(random 16)"
  env_set COOKIE_SECURE false

  local port=80
  port_in_use 80 && port=8080
  if port_in_use "$port"; then
    die "ports 80 and 8080 are both in use. Set WEB_PORT in .env to a free port and run again."
  fi
  env_set WEB_PORT "$port"
  env_set BACKUP_DIR "$ROOT/backups"
  env_set BACKUP_KEEP_DAYS 14
  # remembered until the install succeeds, so a failed first run still shows the login later
  if [ "$EXISTING_DB" = 1 ]; then echo existing >.deploy-first-login; else echo new >.deploy-first-login; fi
  ok "Settings saved to .env (readable only by you; keep a copy somewhere safe)"
}

# An old database volume (e.g. from "docker compose up" with the default
# password) gets the new password from .env, so the API can connect.
sync_db_password() {
  [ "$FRESH_ENV" = 1 ] && [ "$EXISTING_DB" = 1 ] || return 0
  log "Existing database found: switching it to the new password"
  compose up -d --wait db >/dev/null
  local user
  user=$(env_get POSTGRES_USER postgres)
  compose exec -T db psql -q -U "$user" -d postgres \
    -c "ALTER USER \"$user\" PASSWORD '$(env_get POSTGRES_PASSWORD)'" >/dev/null
  ok "Database password updated (your data is untouched)"
}

# Ports held by other programs (e.g. a development server on 5000) would stop a
# container from starting. Internal ports (only reachable from this computer)
# move to the next free port; the web port is the address people use, so a
# clash there is reported instead.
check_ports() {
  local spec key service default port new taken=" "
  for spec in WEB_PORT:web:8080 API_PORT:api:5000 DB_PORT:db:5433 \
    STORAGE_PORT:storage:9000 STORAGE_CONSOLE_PORT:storage:9001; do
    IFS=: read -r key service default <<<"$spec"
    port=$(env_get "$key" "$default")
    # a running ERP container holds its own port: that's fine
    if running "$service" || ! port_in_use "$port"; then
      taken+="$port "
      continue
    fi
    if [ "$key" = WEB_PORT ]; then
      die "port $port is used by another program ($(port_owner "$port")). Stop it, or set WEB_PORT in .env to a free port, then run ./deploy.sh again."
    fi
    new=$((port + 1))
    while port_in_use "$new" || [[ "$taken" == *" $new "* ]]; do new=$((new + 1)); done
    env_set "$key" "$new"
    taken+="$new "
    ok "Port $port is used by another program ($(port_owner "$port")); the ERP's $service uses $new instead ($key in .env)"
  done
}

port_owner() {
  local owner
  owner=$($SUDO ss -Hltnp "sport = :$1" 2>/dev/null | grep -o '(("[^"]*"' | head -n1 | tr -d '("' || true)
  printf '%s' "${owner:-unknown}"
}

start_stack() {
  check_ports
  # where links in emails go, unless set in .env: the office address (only
  # used the first time email settings are filled in from .env)
  if [ -z "$(env_get APP_URL)" ]; then
    local port
    port=$(env_get WEB_PORT 8080)
    APP_URL="http://$(lan_ip)$([ "$port" = 80 ] || printf ':%s' "$port")"
    export APP_URL
  fi
  log "Building and starting Zenin ERP (the first build takes a few minutes)"
  compose up -d --build --remove-orphans --wait --wait-timeout 600
  recreate_outdated
  wait_healthy
}

# Compose sometimes keeps a container on its previous image after a rebuild
# (seen after a shutdown: the web app kept serving an old build). Replace any
# of our built services whose container doesn't run the image just built.
recreate_outdated() {
  local service id running_image built_image outdated=()
  for service in api worker web; do
    id=$(container_id "$service")
    [ -n "$id" ] || continue
    running_image=$("${DOCKER[@]}" inspect -f '{{.Image}}' "$id" 2>/dev/null || true)
    built_image=$("${DOCKER[@]}" image inspect -f '{{.Id}}' "${PROJECT}-$service" 2>/dev/null || true)
    [ -n "$built_image" ] && [ "$running_image" != "$built_image" ] && outdated+=("$service")
  done
  [ ${#outdated[@]} -gt 0 ] || return 0
  log "Replacing containers still on an old build: ${outdated[*]}"
  compose up -d --no-deps --force-recreate --wait --wait-timeout 300 "${outdated[@]}"
}

wait_healthy() {
  local port
  port=$(env_get WEB_PORT 8080)
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      ok "All services are running and healthy"
      return
    fi
    sleep 2
  done
  compose ps
  die "the web app does not answer on port $port. Check: ./deploy.sh logs"
}

open_firewall() {
  local port
  port=$(env_get WEB_PORT 8080)
  if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow "$port/tcp" comment "Zenin ERP" >/dev/null
    ok "Firewall (ufw): port $port opened for the network"
  elif command -v firewall-cmd >/dev/null && $SUDO firewall-cmd --state >/dev/null 2>&1; then
    $SUDO firewall-cmd -q --permanent --add-port="$port/tcp"
    $SUDO firewall-cmd -q --reload
    ok "Firewall (firewalld): port $port opened for the network"
  fi
}

keep_awake() {
  if [ "$ALLOW_SLEEP" = 1 ]; then
    warn "Sleep left enabled (--allow-sleep): the ERP is unreachable while this computer sleeps"
    return
  fi
  command -v systemctl >/dev/null || return 0
  if [ "$(systemctl is-enabled suspend.target 2>/dev/null || true)" != masked ]; then
    if $SUDO systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1; then
      ok "Suspend and hibernate disabled, so the server stays on 24x7"
    else
      warn "could not disable sleep; turn off automatic suspend in the power settings"
    fi
  else
    ok "Suspend and hibernate already disabled"
  fi
}

schedule_backups() {
  if [ ! -d /etc/cron.d ]; then
    warn "cron is not installed: nightly backups are NOT scheduled (sudo apt install cron, then run again)"
    return
  fi
  printf '%s\n' \
    "# Zenin ERP nightly backup, installed by $ROOT/deploy.sh" \
    "SHELL=/bin/bash" \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "30 2 * * * root $(printf '%q' "$ROOT/deploy.sh") backup >>$BACKUP_LOG 2>&1" |
    $SUDO tee "$CRON_FILE" >/dev/null
  $SUDO chmod 644 "$CRON_FILE"
  ok "Nightly backup scheduled at 02:30 into $(env_get BACKUP_DIR "$ROOT/backups") (kept $(env_get BACKUP_KEEP_DAYS 14) days)"
}

lan_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n1)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "${ip:-<this-computer-ip>}"
}

summary() {
  local port suffix="" ip
  port=$(env_get WEB_PORT 8080)
  [ "$port" = 80 ] || suffix=":$port"
  ip=$(lan_ip)
  printf '\n%s Zenin ERP is running.%s\n\n' "$c_green" "$c_off"
  printf '  Open it from any computer or phone on this network:\n'
  printf '      %shttp://%s%s%s\n' "$c_blue" "$ip" "$suffix" "$c_off"
  if systemctl is-active -q avahi-daemon 2>/dev/null; then
    printf '      http://%s.local%s   (also works on most networks)\n' "$(hostname)" "$suffix"
  fi
  printf '  On this computer:  http://localhost%s\n\n' "$suffix"

  case "$(cat .deploy-first-login 2>/dev/null || true)" in
  new)
    printf '  First login:   %s / %s\n' "$(env_get ADMIN_USERNAME admin)" "$(env_get ADMIN_PASSWORD)"
    printf '  (also in .env as ADMIN_PASSWORD; change it after logging in)\n\n'
    ;;
  existing)
    printf '  Your existing data and user accounts were kept: log in as before.\n'
    printf '  Forgot the admin password?  ./deploy.sh password admin\n\n'
    ;;
  esac
  rm -f .deploy-first-login
  printf '  Ask your router admin to give this computer a fixed IP (%s), so the address never changes.\n' "$ip"
  case "$(tunnel_mode)" in
  named | free) show_public || true ;;
  *) printf '  To make it reachable from anywhere over HTTPS, free:  ./deploy.sh public   (see DEPLOYMENT.md)\n' ;;
  esac
  printf '  Manage it with:  ./deploy.sh status | logs | backup | restore | password | stop | start\n\n'
}

cmd_deploy() {
  [ "$(uname -s)" = Linux ] || die "this script supports Linux servers only (see DEPLOYMENT.md)"
  [ -f docker-compose.yml ] || die "run this from the erp folder (docker-compose.yml not found)"
  command -v curl >/dev/null || die "curl is required: sudo apt install curl"
  if [ -n "$SUDO" ]; then
    log "Some steps need administrator rights; sudo may ask for your password"
    sudo -v
  fi

  install_docker
  create_env
  sync_db_password
  if running db; then
    log "Backing up the database before updating"
    BACKUP_LABEL=pre-update cmd_backup
  fi
  start_stack
  open_firewall
  keep_awake
  schedule_backups
  summary
}

# ---------------------------------------------------------------- operations

BACKUP_LABEL=""

cmd_backup() {
  require_docker
  running db || die "the database is not running (./deploy.sh start)"
  local dir keep dest user db storage_id
  dir=$(env_get BACKUP_DIR "$ROOT/backups")
  case "$dir" in /*) ;; *) dir="$ROOT/${dir#./}" ;; esac # docker needs absolute paths
  keep=$(env_get BACKUP_KEEP_DAYS 14)
  dest="$dir/$(date +%Y-%m-%d_%H%M%S)${BACKUP_LABEL:+_$BACKUP_LABEL}"
  user=$(env_get POSTGRES_USER postgres)
  db=$(env_get POSTGRES_DB generic_erp)

  $SUDO mkdir -p "$dest"
  $SUDO chmod 700 "$dir" "$dest"

  compose exec -T db pg_dump -U "$user" -Fc "$db" | $SUDO tee "$dest/database.dump" >/dev/null
  $SUDO test -s "$dest/database.dump" || die "database backup is empty"

  storage_id=$(container_id storage)
  if [ -n "$storage_id" ]; then
    "${DOCKER[@]}" run --rm --volumes-from "$storage_id:ro" -v "$dest:/backup" \
      --entrypoint tar "$HELPER_IMAGE" czf /backup/files.tar.gz -C /data .
  fi
  $SUDO cp .env "$dest/env"
  $SUDO find "$dest" -type f -exec chmod 600 {} +

  # remove old backups (only folders this script created)
  $SUDO find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]-*' -mtime "+$keep" -exec rm -rf {} + 2>/dev/null || true

  ok "Backup saved: $dest ($($SUDO du -sh "$dest" | cut -f1))"
}

cmd_restore() {
  local src=${1:-} answer user db
  [ -n "$src" ] || die "usage: ./deploy.sh restore <backup folder>   (see ./deploy.sh status for the latest)"
  case "$src" in /*) ;; *) src="$CALLER_PWD/$src" ;; esac
  src=${src%/}
  $SUDO test -s "$src/database.dump" || die "$src/database.dump not found"
  require_docker
  user=$(env_get POSTGRES_USER postgres)
  db=$(env_get POSTGRES_DB generic_erp)

  printf '\nThis REPLACES all current data and uploaded files with the backup in:\n  %s\n' "$src"
  printf 'Everyone is signed out. A backup of the current state is taken first.\n\n'
  if [ "${2:-}" != "--yes" ]; then
    read -r -p "Type RESTORE to continue: " answer
    [ "$answer" = RESTORE ] || die "nothing was changed"
  fi

  compose up -d --wait db storage >/dev/null
  BACKUP_LABEL=pre-restore cmd_backup

  log "Stopping the app"
  compose stop web worker api >/dev/null

  log "Restoring the database"
  compose exec -T db psql -q -U "$user" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\"" >/dev/null
  $SUDO cat "$src/database.dump" | compose exec -T db pg_restore -U "$user" -d "$db" --no-owner --exit-on-error
  ok "Database restored"

  if $SUDO test -s "$src/files.tar.gz"; then
    log "Restoring uploaded files"
    compose stop storage >/dev/null
    "${DOCKER[@]}" run --rm --volumes-from "$(container_id storage)" -v "$src:/backup:ro" \
      --entrypoint sh "$HELPER_IMAGE" -c 'rm -rf /data/* /data/.[!.]* /data/..?* && tar xzf /backup/files.tar.gz -C /data'
    ok "Files restored"
  else
    warn "no files.tar.gz in the backup: uploaded files were left as they are"
  fi

  log "Starting the app"
  compose up -d --wait >/dev/null
  ok "Restore complete"
}

cmd_status() {
  require_docker
  compose ps
  local port dir latest
  port=$(env_get WEB_PORT 8080)
  echo
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    ok "Web app and API answer on port $port (http://$(lan_ip)$([ "$port" = 80 ] || printf ':%s' "$port"))"
  else
    warn "Web app does not answer on port $port"
  fi
  dir=$(env_get BACKUP_DIR "$ROOT/backups")
  latest=$($SUDO find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]-*' 2>/dev/null | sort | tail -n1 || true)
  if [ -n "$latest" ]; then ok "Latest backup: $latest"; else warn "No backups yet in $dir"; fi
  if [ -f "$CRON_FILE" ]; then ok "Nightly backup is scheduled (02:30)"; else warn "Nightly backup is NOT scheduled"; fi
  local url
  case "$(tunnel_mode)" in
  named)
    if tunnel_connected; then ok "Public access: ON (Cloudflare Tunnel with your own hostname)"; else warn "Public access: ON, but the tunnel is not connected (./deploy.sh logs tunnel)"; fi
    ;;
  free)
    url=$(free_url)
    if tunnel_connected && [ -n "$url" ]; then
      ok "Public access: ON (free tunnel). Current address: $url"
      printf '    (this address changes whenever the server or tunnel restarts)\n'
    else
      warn "Public access: ON (free tunnel), but it is not connected (./deploy.sh logs tunnel-free)"
    fi
    ;;
  *) ok "Public access: off (office network only)" ;;
  esac
  df -h "$ROOT" | awk 'NR == 2 {print "  Disk: " $4 " free of " $2 " (" $5 " used)"}'
}

# public access: "named" = Cloudflare Tunnel with your own domain (token),
# "free" = Cloudflare Quick Tunnel (no account, random address), or "off"
tunnel_mode() {
  case "$(env_get COMPOSE_PROFILES)" in
  tunnel) echo named ;;
  tunnel-free) echo free ;;
  *) echo off ;;
  esac
}

tunnel_service() { if [ "$(tunnel_mode)" = free ]; then echo tunnel-free; else echo tunnel; fi; }

tunnel_connected() {
  local service
  service=$(tunnel_service)
  running "$service" || return 1
  # The latest connection event decides (it reconnects by itself after a drop).
  # Read the whole log first: "grep -q" stops early, and with pipefail the
  # cut-off "compose logs" made a connected tunnel look disconnected.
  local last
  last=$(tunnel_logs "$service" |
    grep -E "Registered tunnel connection|Unregistered tunnel connection|Serve tunnel error|Failed to dial|Retrying connection" |
    tail -n1 || true)
  [[ "$last" == *"Registered tunnel connection"* && "$last" != *Unregistered* ]]
}

# The tunnel's log since it last started. After a reboot the same container
# starts again and its log still holds the previous run's address, which is
# dead: only the current run counts.
tunnel_logs() {
  local id since
  id=$(container_id "$1")
  [ -n "$id" ] || return 0
  since=$("${DOCKER[@]}" inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null || true)
  compose logs --no-log-prefix ${since:+--since "$since"} "$1" 2>&1 || true
}

# the current address of the free tunnel
free_url() {
  tunnel_logs tunnel-free | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n1 || true
}

# Wait for the tunnel to connect (up to a minute), then print the public
# address. Returns 1 if it didn't connect.
show_public() {
  local service url
  service=$(tunnel_service)
  for _ in $(seq 1 30); do
    if tunnel_connected; then
      if [ "$service" = tunnel ]; then
        ok "Public access is ON: reachable from anywhere at the public hostname you set up in Cloudflare"
        return 0
      fi
      url=$(free_url)
      if [ -n "$url" ]; then
        ok "Public access is ON. Anyone can open the ERP from anywhere at:"
        printf '\n      %s%s%s\n\n' "$c_blue" "$url" "$c_off"
        warn "This free address CHANGES whenever the server or the tunnel restarts."
        printf '    See the current one any time with: ./deploy.sh status\n'
        return 0
      fi
    fi
    sleep 2
  done
  warn "Public access is ON, but the tunnel hasn't connected yet. Check the internet connection, then run: ./deploy.sh status"
  return 1
}

cmd_public() {
  [ -f .env ] || die "install first: ./deploy.sh"
  require_docker
  local token=${1:-} service url
  if [ "$token" = --free ]; then
    token=""
  elif [ -z "$token" ]; then
    token=$(env_get CLOUDFLARE_TUNNEL_TOKEN)
  fi

  if [ -n "$token" ]; then
    token=${token##* } # people often paste the whole "cloudflared ... install <token>" command
    [[ "$token" =~ ^[A-Za-z0-9+/=_-]{50,}$ ]] ||
      die "that doesn't look like a tunnel token (a long string that usually starts with eyJ)"
    env_set CLOUDFLARE_TUNNEL_TOKEN "$token"
    env_set COMPOSE_PROFILES tunnel
    service=tunnel
    compose --profile tunnel-free rm -sf tunnel-free >/dev/null 2>&1 || true
  else
    env_set COMPOSE_PROFILES tunnel-free
    service=tunnel-free
    compose --profile tunnel rm -sf tunnel >/dev/null 2>&1 || true
  fi

  check_ports
  log "Connecting to Cloudflare"
  compose up -d --build --wait --wait-timeout 600 >/dev/null
  if show_public; then
    printf '  Office computers can keep using the local address too. Turn it off with: ./deploy.sh private\n'
    return
  fi
  compose logs --tail=20 "$service" || true
  die "the tunnel did not connect. Check the internet connection${token:+ and the token (./deploy.sh public <token>)}."
}

cmd_private() {
  [ -f .env ] || die "install first: ./deploy.sh"
  require_docker
  env_set COMPOSE_PROFILES ""
  compose --profile tunnel --profile tunnel-free rm -sf tunnel tunnel-free >/dev/null 2>&1 || true
  ok "Public access is off: the ERP is only reachable on the office network"
  printf '  (./deploy.sh public turns it back on)\n'
}

cmd_wipe() {
  require_docker
  running api || die "the ERP is not running (./deploy.sh start)"
  local answer
  printf '\nThis permanently deletes ALL data: every table and record, user, role,\n'
  printf 'department, installed app and automation, the audit log and every\n'
  printf 'uploaded file. Everyone is signed out.\n'
  printf 'A backup is taken first. Settings (.env) and the system itself are kept.\n\n'
  if [ "${1:-}" != "--yes" ]; then
    read -r -p "Type WIPE to continue: " answer
    [ "$answer" = WIPE ] || die "nothing was changed"
  fi
  BACKUP_LABEL=pre-wipe cmd_backup
  compose exec -T api node dist/scripts/reset.js --yes --force
  log "Restarting the API and worker"
  compose restart api worker >/dev/null
  wait_healthy
  ok "Wiped. Log in as $(env_get ADMIN_USERNAME admin) with ADMIN_PASSWORD from .env: $(env_get ADMIN_PASSWORD)"
}

cmd_demo() {
  require_docker
  running api || die "the ERP is not running (./deploy.sh start)"
  warn "Demo users share the public password demo-pass-123: never load the demo on a server with real data or public access."
  compose exec -T api node dist/scripts/seed.js --force "$@"
}

cmd_password() {
  local user=${1:-} pass
  [ -n "$user" ] || die "usage: ./deploy.sh password <username>"
  require_docker
  read -r -s -p "New password for $user (at least 8 characters): " pass
  echo
  compose exec -T api node dist/scripts/resetPassword.js "$user" "$pass"
}

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------- main

ALLOW_SLEEP=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
  --allow-sleep) ALLOW_SLEEP=1 ;;
  -h | --help) usage && exit 0 ;;
  *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

command=${1:-deploy}
[ $# -gt 0 ] && shift
case "$command" in
deploy | install | update) cmd_deploy ;;
status) cmd_status ;;
public) cmd_public "$@" ;;
private) cmd_private ;;
logs)
  require_docker
  trap - ERR
  compose logs -f --tail=200 "$@" || true
  ;;
backup) cmd_backup ;;
restore) cmd_restore "$@" ;;
password) cmd_password "$@" ;;
wipe) cmd_wipe "$@" ;;
demo) cmd_demo "$@" ;;
stop) require_docker && compose stop && ok "Stopped. Start again with: ./deploy.sh start" ;;
start)
  require_docker
  check_ports
  compose up -d --wait
  recreate_outdated
  wait_healthy
  case "$(tunnel_mode)" in named | free) show_public || true ;; esac
  ;;
help) usage ;;
*) usage && exit 1 ;;
esac
