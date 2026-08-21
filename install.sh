#!/bin/sh
# QMS store installer — the whole of a technician's job on a mini PC.
#
#   ./install.sh              install or update, then start
#   ./install.sh --no-pull    start what is already on disk (fully offline)
#
# Written in POSIX sh rather than as a scripts/*.mjs like everything else in
# this repo, because Docker is the only runtime dependency a store machine is
# promised to have. Node is not installed there.
#
# Safe to re-run: every step is idempotent.
set -eu

cd "$(dirname "$0")"

PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$1"; }
warn() { printf '   ! %s\n' "$1" >&2; }

# --- Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "install.sh: Docker is not installed. Install Docker Engine first." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "install.sh: 'docker compose' is unavailable. Install the Compose plugin." >&2
  exit 1
fi

# --- Host fingerprint mount ----------------------------------------------
# Linux only: macOS has no /sys, and an absent mount degrades to "fingerprint
# unavailable", which never blocks anything.
say "Host identity"
if [ "$(uname -s)" = "Linux" ]; then
  ln -sf docker-compose.prod.yml docker-compose.override.yml
  echo "   fingerprint mount enabled (docker-compose.override.yml)"

  UUID_FILE=/sys/class/dmi/id/product_uuid
  if [ -r "$UUID_FILE" ]; then
    UUID=$(tr '[:upper:]' '[:lower:]' < "$UUID_FILE" | tr -d '[:space:]')
    case "$UUID" in
      ''|'default string'|'to be filled by o.e.m.'|03000200-0400-0500-0006-000700080009)
        warn "this board reports a placeholder identity, not its own."
        warn "Tell the vendor: this unit needs a licence issued without host binding."
        ;;
      *) echo "   board identity readable" ;;
    esac
  else
    warn "cannot read $UUID_FILE (are you root?). Host binding will not be enforced."
  fi
else
  echo "   not Linux — skipping the fingerprint mount (development machine)"
  # Only ever removes the link this script created. A developer's own
  # docker-compose.override.yml is their file, and deleting it because they ran
  # the installer once on a laptop would be a nasty surprise.
  if [ -L docker-compose.override.yml ] &&
     [ "$(readlink docker-compose.override.yml)" = "docker-compose.prod.yml" ]; then
    rm -f docker-compose.override.yml
  fi
fi

# --- Images ---------------------------------------------------------------
if [ "$PULL" -eq 1 ]; then
  say "Downloading images"
  # Docker's own message here is accurate but bare ("repository does not
  # exist"), and the two real causes look nothing like that to a technician
  # standing at a counter.
  if ! docker compose pull; then
    warn ""
    warn "Could not download the images. Usually one of:"
    warn "  * this machine has no internet yet, or"
    warn "  * .env is missing or QMS_REGISTRY is not set (copy .env.example), or"
    warn "  * this machine is not logged in: docker login <registry>"
    warn ""
    warn "If the images are already on this machine, run: ./install.sh --no-pull"
    exit 1
  fi
else
  say "Skipping download (--no-pull)"
fi

# --- Start ----------------------------------------------------------------
say "Starting"
docker compose up -d

cat <<'NEXT'

== Done

Open http://antrian.local/ on any device on the shop network
(or http://<this machine's IP>/ if that name does not resolve).

The activation page opens by itself. Enter the Activation Key from the vendor.

  Activation needs the internet ONCE. If this machine has no connection,
  plug in a LAN cable with internet or share a phone hotspot first — after
  activation the system runs entirely offline and never calls out again.
NEXT
