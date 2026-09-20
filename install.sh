#!/usr/bin/env bash
# Install or remove the Convorel standalone executable from a GitHub Release.
#   curl -fsSL https://raw.githubusercontent.com/MarioJames/convorel/main/install.sh | bash
# Nothing here needs Bun, Node or a source checkout, and no command uses sudo.
set -euo pipefail

owner="MarioJames"
repository="convorel"
version="${CONVOREL_VERSION:-latest}"
install_dir="${CONVOREL_INSTALL_DIR:-$HOME/.local/lib/convorel}"
bin_dir="${CONVOREL_BIN_DIR:-$HOME/.local/bin}"
# A directory of built artifacts, for an offline install or a release acceptance run.
dist_dir="${CONVOREL_DIST_DIR:-}"
action=install

say() { printf '%s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
install.sh [--version TAG] [--prefix DIR] [--bin-dir DIR] [--uninstall]
  --version TAG     install a specific tag, e.g. v0.2.0 (default: latest release)
  --prefix DIR      installation directory (default: ~/.local/lib/convorel)
  --bin-dir DIR     directory to place the convorel and agent-browser links
  --dist-dir DIR    use already built artifacts from DIR instead of downloading
  --uninstall       remove the installed executables only
Environment: CONVOREL_INSTALL_DIR, CONVOREL_BIN_DIR, CONVOREL_DIST_DIR, CONVOREL_VERSION
Conversation state, the browser profile and installed skills are never removed.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version requires a value"
      version="$2"
      shift 2
      ;;
    --version=*) version="${1#*=}"; shift ;;
    --prefix)
      [ $# -ge 2 ] || die "--prefix requires a value"
      install_dir="$2"
      shift 2
      ;;
    --prefix=*) install_dir="${1#*=}"; shift ;;
    --bin-dir)
      [ $# -ge 2 ] || die "--bin-dir requires a value"
      bin_dir="$2"
      shift 2
      ;;
    --bin-dir=*) bin_dir="${1#*=}"; shift ;;
    --dist-dir)
      [ $# -ge 2 ] || die "--dist-dir requires a value"
      dist_dir="$2"
      shift 2
      ;;
    --dist-dir=*) dist_dir="${1#*=}"; shift ;;
    --uninstall) action=uninstall; shift ;;
    --help | -h) usage; exit 0 ;;
    *)
      usage >&2
      die "UNKNOWN_ARGUMENT: $1"
      ;;
  esac
done
for path in "$install_dir" "$bin_dir"; do
  case "$path" in /*) ;; *) die "ABSOLUTE_PATH_REQUIRED: $path" ;; esac
done

owned_link() {
  # Only touch a link this installer created, never a package manager's or a hand-made one.
  [ -L "$1" ] || return 1
  case "$(readlink -f "$1" 2>/dev/null || echo)" in
  "$install_dir"/*) return 0 ;;
  esac
  return 1
}

if [ "$action" = uninstall ]; then
  removed=0
  for name in convorel agent-browser; do
    if owned_link "$bin_dir/$name"; then
      rm -f "$bin_dir/$name"
      say "removed $bin_dir/$name"
      removed=1
    fi
  done
  if [ -d "$install_dir" ]; then
    rm -rf "$install_dir"
    say "removed $install_dir"
  fi
  say "kept $HOME/.local/share/convorel, $HOME/.local/share/convorel-tunnels and $HOME/.config/convorel"
  say "kept installed skills under $HOME/.agents/skills, $HOME/.codex/skills and $HOME/.claude/skills"
  [ "$removed" = 1 ] || say "note: no convorel link was found in $bin_dir"
  exit 0
fi

[ "$(uname -s)" = Linux ] ||
  die "PLATFORM_UNSUPPORTED: this release ships Linux builds; install from source instead"
case "$(uname -m)" in
  x86_64 | amd64) platform=linux-x64 ;;
  aarch64 | arm64) platform=linux-arm64 ;;
  *) die "UNSUPPORTED_ARCHITECTURE: $(uname -m)" ;;
esac
if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] ||
  { ldd --version 2>&1 | grep -qi musl; }; then
  die "LIBC_UNSUPPORTED: this release ships glibc builds; on Alpine install convorel from source"
fi

hash_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "NO_HASH_TOOL: install coreutils or perl-shasum"
  fi
}
fetch() {
  if command -v curl >/dev/null; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null; then wget -q -O "$2" "$1"
  else die "NO_DOWNLOAD_TOOL: install curl or wget"
  fi
}

if [ -n "$dist_dir" ]; then
  source_dir="$dist_dir"
  [ -f "$source_dir/sha256sums.txt" ] ||
    die "CHECKSUMS_MISSING: $source_dir/sha256sums.txt"
else
  source_dir="$(mktemp -d)"
  trap 'rm -rf "$source_dir"' EXIT
  case "$version" in
    latest) reference="latest/download" ;;
    *) reference="download/$version" ;;
  esac
  say "downloading from github.com/$owner/$repository"
  fetch "https://github.com/$owner/$repository/releases/$reference/sha256sums.txt" \
    "$source_dir/sha256sums.txt"
fi

# The checksum list names the artifact, so `latest` needs no release API lookup.
line="$(grep -e "-$platform\.tar\.gz$" "$source_dir/sha256sums.txt" | head -n1 || true)"
[ -n "$line" ] || die "ARTIFACT_MISSING: no $platform build is published"
want="${line%% *}"
archive="${line##* }"
say "using $archive"
[ -n "$dist_dir" ] ||
  fetch "https://github.com/$owner/$repository/releases/$reference/$archive" \
    "$source_dir/$archive"
[ -f "$source_dir/$archive" ] || die "ARTIFACT_MISSING: $source_dir/$archive"
[ "$(hash_of "$source_dir/$archive")" = "$want" ] ||
  die "CHECKSUM_MISMATCH: refusing an artifact that does not match sha256sums.txt"

release="${archive#convorel-}"
release="${release%%-*}"
staging="$install_dir/parts/$archive"
rm -rf "$staging"
mkdir -p "$install_dir/versions" "$bin_dir" "$staging"
tar -xzf "$source_dir/$archive" -C "$staging"
extracted="$staging/${archive%.tar.gz}"
[ -x "$extracted/bin/convorel" ] && [ -x "$extracted/bin/agent-browser" ] ||
  die "ARTIFACT_INVALID: the archive does not contain both executables"
# readlink -f prints a path even for a missing target, so check existence first.
previous=""
if [ -e "$bin_dir/convorel" ]; then
  previous="$(readlink -f "$bin_dir/convorel")"
fi
target="$install_dir/versions/$release-$platform"
rm -rf "$target"
mv "$extracted" "$target"
rmdir "$staging" "$install_dir/parts" 2>/dev/null || true
# Absolute targets, because --bin-dir and --prefix need not share a parent.
ln -sfn "$target/bin/convorel" "$bin_dir/convorel"
ln -sfn "$target/bin/agent-browser" "$bin_dir/agent-browser"
if [ -n "$previous" ] && [ "$previous" != "$(readlink -f "$bin_dir/convorel")" ]; then
  say "previous release retained at ${previous%/bin/*} for reference"
fi

installed="$("$bin_dir/convorel" --version)"
[ "$installed" = "$release" ] ||
  die "VERSION_MISMATCH: installed binary reports $installed, expected $release"
say "installed convorel $installed -> $bin_dir/convorel"
case ":$PATH:" in *":$bin_dir:"*) ;; *)
  say "add it to PATH with: export PATH=\"$bin_dir:\$PATH\""
  ;;
esac
say "next: start Chrome with --remote-debugging-port, then run convorel setup"
say "see https://github.com/$owner/$repository/blob/main/docs/quickstart.md"
