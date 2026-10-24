#!/bin/sh
# TopCited CLI installer.
#
#   curl -fsSL https://topcited.ai/install.sh | sh
#
# Downloads the release binary for this OS/arch from GitHub Releases, verifies
# its SHA-256 against the release's SHA256SUMS, and installs it as `topcited`.
#
# Environment:
#   TOPCITED_VERSION        release tag to install (default: latest), e.g. v0.1.0
#   TOPCITED_INSTALL_DIR    install directory (default: ~/.local/bin)
#   TOPCITED_DOWNLOAD_BASE  override the download base URL (mirrors, tests)
set -eu

REPO="TopCited/topcited-cli"
INSTALL_DIR="${TOPCITED_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    MINGW* | MSYS* | CYGWIN*) die "on Windows, install with npm: npm i -g @topcited/cli" ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  arch="$(uname -m)"
  # An x64 shell under Rosetta on Apple silicon: install the native arm64 build.
  if [ "$arch" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch=arm64
  fi
  case "$arch" in
    x86_64 | amd64) echo x64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) die "unsupported architecture: $arch" ;;
  esac
}

download() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "need curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "need sha256sum or shasum to verify the download"
  fi
}

main() {
  os="$(detect_os)"
  arch="$(detect_arch)"
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    die "musl libc (e.g. Alpine) is not supported yet; use npm i -g @topcited/cli on a glibc image"
  fi
  asset="topcited-$os-$arch"

  if [ -n "${TOPCITED_DOWNLOAD_BASE:-}" ]; then
    base="$TOPCITED_DOWNLOAD_BASE"
  elif [ -n "${TOPCITED_VERSION:-}" ]; then
    base="https://github.com/$REPO/releases/download/$TOPCITED_VERSION"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading $asset ..."
  download "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

  expected="$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || die "no checksum for $asset in SHA256SUMS"
  actual="$(sha256 "$tmp/$asset")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"

  mkdir -p "$INSTALL_DIR"
  chmod 755 "$tmp/$asset"
  mv "$tmp/$asset" "$INSTALL_DIR/topcited"
  say "Installed topcited $("$INSTALL_DIR/topcited" --version 2>/dev/null || echo '') to $INSTALL_DIR/topcited"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) say "" && say "$INSTALL_DIR is not on your PATH. Add it with:" && say "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac
  say "" && say "Next: topcited auth login"
}

main "$@"
