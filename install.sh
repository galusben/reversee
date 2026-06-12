#!/bin/sh
# Reversee installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/galusben/reversee/main/install.sh | bash
# Downloads the latest release from GitHub and installs it:
#   macOS: Reversee.app into /Applications (or ~/Applications)
#   Linux: AppImage into ~/.local/bin/reversee
set -eu

REPO="galusben/reversee"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

asset_url() {
  # Prints the browser_download_url of the first asset matching $1.
  curl -fsSL "$API" | grep '"browser_download_url"' | grep -- "$1" | head -1 | sed 's/.*"\(https[^"]*\)".*/\1/'
}

OS=$(uname -s)
ARCH=$(uname -m)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) PATTERN='arm64-mac\.zip"' ;;
      x86_64) PATTERN='[0-9]-mac\.zip"' ;; # the x64 zip has no arch infix
      *) fail "unsupported macOS architecture: $ARCH" ;;
    esac
    URL=$(asset_url "$PATTERN")
    [ -n "$URL" ] || fail "could not find a macOS asset in the latest release"
    say "Downloading $URL"
    curl -fSL --progress-bar "$URL" -o "$TMP/reversee.zip"

    DEST="/Applications"
    [ -w "$DEST" ] || DEST="$HOME/Applications"
    mkdir -p "$DEST"
    rm -rf "$DEST/Reversee.app"
    ditto -x -k "$TMP/reversee.zip" "$DEST"
    say "Installed $DEST/Reversee.app"
    say "Launch it with: open '$DEST/Reversee.app'"
    ;;
  Linux)
    case "$ARCH" in
      x86_64) ;;
      *) fail "no prebuilt Linux binary for $ARCH yet (build from source: https://github.com/$REPO)" ;;
    esac
    URL=$(asset_url '\.AppImage"')
    [ -n "$URL" ] || fail "could not find a Linux AppImage in the latest release"
    say "Downloading $URL"
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    curl -fSL --progress-bar "$URL" -o "$BIN_DIR/reversee"
    chmod +x "$BIN_DIR/reversee"
    say "Installed $BIN_DIR/reversee"
    case ":$PATH:" in
      *":$BIN_DIR:"*) say "Run it with: reversee" ;;
      *) say "Note: $BIN_DIR is not on your PATH. Run it with: $BIN_DIR/reversee" ;;
    esac
    say "(AppImages need FUSE; on most distros it is preinstalled.)"
    ;;
  *)
    fail "unsupported OS: $OS (Windows builds are on https://github.com/$REPO/releases)"
    ;;
esac
