#!/bin/sh
# dshgo-vmbridge installer
# Usage: curl -fsSL <raw-url>/install.sh | sh
set -e

REPO="dshgo-vmbridge"
NAME="dshgo-vmbridge"
DIR_NAME="local-vmbridge"
BRANCH="main"

log()  { printf '\033[36m[vmbridge]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[vmbridge]\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[31m[vmbridge]\033[0m %s\n' "$1" >&2; exit 1; }

log "installing $REPO"

# --- locate DSH_HOME -------------------------------------------------------
if [ -z "$DSH_HOME" ]; then
  for c in "$HOME/.dsh" "/root/.dsh" "$HOME/Library/Application Support/dsh"; do
    [ -d "$c" ] && DSH_HOME="$c" && break
  done
fi
[ -n "$DSH_HOME" ] || die "cannot find DSH_HOME; export it and retry"
log "DSH_HOME = $DSH_HOME"

PLUGIN_DIR="$DSH_HOME/dsh-go/plugins"
[ -d "$PLUGIN_DIR" ] || die "$PLUGIN_DIR not found — is DSH Go installed?"
mkdir -p "$PLUGIN_DIR"

TARGET="$PLUGIN_DIR/$DIR_NAME"

# --- fetch ----------------------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

URL="https://codeload.github.com/xqe-bkflda/$REPO/tar.gz/refs/heads/$BRANCH"
log "downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP/repo.tar.gz" || die "download failed"
else
  wget -qO "$TMP/repo.tar.gz" "$URL" || die "download failed"
fi

tar xzf "$TMP/repo.tar.gz" -C "$TMP" || die "extract failed"
SRC=$(find "$TMP" -maxdepth 1 -type d -name "$REPO-*" | head -1)
[ -n "$SRC" ] || die "unexpected archive layout"

rm -rf "$TARGET"
mv "$SRC" "$TARGET"
log "installed to $TARGET"

# --- register with the dsh engine ------------------------------------------
if command -v dsh >/dev/null 2>&1; then
  log "registering with dsh (profile: web)"
  dsh plugin --profile web add "$TARGET" || warn "dsh plugin add failed — add it manually from the app"
else
  warn "dsh CLI not found — copy $TARGET into the app's plugin manager by hand"
fi

# --- optional: install the Shot helper into the VM -------------------------
if command -v adb >/dev/null 2>&1; then
  if adb devices 2>/dev/null | grep -qE '^127\.0\.0\.1:[0-9]+\s+device'; then
    log "an adb device is connected — installing Shot.apk"
    adb -s "$(adb devices | awk '/^127\.0\.0\.1:[0-9]+/ {print $1; exit}')" \
        install -r -g "$TARGET/Shot.apk" >/dev/null 2>&1 \
      && log "Shot.apk installed" \
      || warn "Shot.apk install failed — run vm_shot_setup(reinstall=true) in the app"
  else
    log "no AndVM adb device detected — run vm_shot_setup(reinstall=true) later"
  fi
else
  log "adb not found in PATH — run vm_shot_setup(reinstall=true) later"
fi

cat <<'EOF'

  Done.

  Next:
    1. Restart the engine:  sidebar -> Engine -> Restart engine
    2. Open the plugin page and start it
    3. Check connectivity:  vm_status

  Docs: https://github.com/xqe-bkflda/dshgo-vmbridge#readme

EOF
