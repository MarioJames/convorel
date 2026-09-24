#!/usr/bin/env bash
# Install or remove the Convorel standalone executable from a GitHub Release.
#   curl -fsSL https://raw.githubusercontent.com/MarioJames/convorel/main/install.sh | bash
# Nothing here needs Bun, Node or a source checkout, and no command uses sudo.
set -euo pipefail

owner="MarioJames"
repository="convorel"
version=latest
install_dir="$HOME/.local/lib/convorel"
bin_dir="$HOME/.local/bin"
# A directory of built artifacts, for an offline install or a release acceptance run.
dist_dir=""
release_base="https://github.com/$owner/$repository/releases"
action=install

say() { printf '%s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
install.sh [--version TAG] [--prefix DIR] [--bin-dir DIR] [--release-base URL] [--uninstall]
  --version TAG     install a specific tag, e.g. v0.2.0 (default: latest release)
  --prefix DIR      installation directory (default: ~/.local/lib/convorel)
  --bin-dir DIR     directory to place the convorel link
  --dist-dir DIR    use already built artifacts from DIR instead of downloading
  --release-base URL  release download base (default: GitHub Releases)
  --uninstall       remove the installed executables only
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
    --release-base)
      [ $# -ge 2 ] && [ -n "$2" ] || die "--release-base requires a value"
      release_base="${2%/}"
      shift 2
      ;;
    --release-base=*)
      release_base="${1#*=}"
      [ -n "$release_base" ] || die "--release-base requires a value"
      release_base="${release_base%/}"
      shift
      ;;
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
# Canonical paths make ownership checks independent of symlinked parent directories.
install_dir="$(realpath -m -- "$install_dir")"
bin_dir="$(realpath -m -- "$bin_dir")"
[ "$install_dir" != / ] && [ "$bin_dir" != / ] || die "INSTALL_PATH_INVALID: root is not an installation directory"
case "$install_dir$bin_dir" in *[$'\001'-$'\037']*) die "INSTALL_PATH_INVALID: control characters in path" ;; esac
case "$bin_dir/" in "$install_dir/versions/"*|"$install_dir/parts/"*) die "INSTALL_PATH_INVALID: bin directory overlaps managed releases" ;; esac
valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$ ]]; }
if [ "$version" != latest ]; then
  version="${version#v}"
  valid_version "$version" || die "VERSION_INVALID: expected a release version"
fi

command -v flock >/dev/null || die "INSTALL_LOCK_UNAVAILABLE: install util-linux (flock)"
# Keep the same inode outside the removable installation tree. The kernel
# releases ownership on exit (including SIGKILL); never unlink a flock file.
mkdir -p "$(dirname "$install_dir")"
exec 9>"$install_dir.install.lock"
flock -n 9 || die "INSTALL_BUSY: another install or uninstall is in progress"

manifest="$install_dir/.convorel-owned"
[ ! -L "$manifest" ] || die "INSTALL_OWNERSHIP_INVALID: manifest must not be a symlink"
if [ -e "$manifest" ]; then
  [ -f "$manifest" ] || die "INSTALL_OWNERSHIP_INVALID: manifest must be a regular file"
  { IFS= read -r -d '' kind && IFS= read -r -d '' marker && IFS= read -r -d '' path &&
    [ "$kind" = v ] && [ "$marker" = convorel-owned-v1 ] && [ "$path" = "$install_dir" ]; } < "$manifest" ||
    die "INSTALL_OWNERSHIP_INVALID: refusing an unrecognized manifest"
fi
hash_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "NO_HASH_TOOL: install coreutils or perl-shasum"
  fi
}
# NUL-delimited triples: kind, fingerprint, absolute path. Never follow replaced
# parent directories, remove changed files, or recursively delete a prefix.
safe_owned_path() {
  case "$1" in "$install_dir"|"$install_dir"/*|"$bin_dir/convorel"|"$bin_dir/agent-browser") ;; *) return 1 ;; esac
  [ "$(realpath -ms -- "$1")" = "$1" ] || return 1
  [ "$(realpath -m -- "$(dirname "$1")")" = "$(dirname "$1")" ]
}
owned_entry() {
  [ -f "$manifest" ] || return 1
  local kind fingerprint path
  while IFS= read -r -d '' kind && IFS= read -r -d '' fingerprint && IFS= read -r -d '' path; do
    [ "$path" = "$2" ] && [ "$kind" = "$1" ] || continue
    safe_owned_path "$path" || continue
    case "$kind" in
      l) [ -L "$path" ] && [ "$(readlink -- "$path")" = "$fingerprint" ] && return 0 ;;
      f) [ ! -L "$path" ] && [ -f "$path" ] && [ "$(hash_of "$path")" = "$fingerprint" ] && return 0 ;;
    esac
  done < "$manifest"
  return 1
}
owned_link() { owned_entry l "$1"; }

if [ "$action" = uninstall ]; then
  removed=0
  for name in convorel agent-browser; do
    if owned_link "$bin_dir/$name"; then
      rm -f "$bin_dir/$name"
      say "removed $bin_dir/$name"
      removed=1
    fi
  done
  if [ -f "$manifest" ]; then
    while IFS= read -r -d '' kind && IFS= read -r -d '' fingerprint && IFS= read -r -d '' path; do
      safe_owned_path "$path" || continue
      if [ "$kind" = f ] && [ ! -L "$path" ] && [ -f "$path" ] && [ "$(hash_of "$path")" = "$fingerprint" ]; then
        rm -f -- "$path"
      fi
    done < "$manifest"
    # Directory records are written deepest first, after their files.
    remove_prefix=0
    remove_versions=0
    while IFS= read -r -d '' kind && IFS= read -r -d '' fingerprint && IFS= read -r -d '' path; do
      [ "$kind" = d ] && safe_owned_path "$path" && [ ! -L "$path" ] || continue
      [ "$path" != "$install_dir" ] || remove_prefix=1
      [ "$path" != "$install_dir/versions" ] || remove_versions=1
      rmdir -- "$path" 2>/dev/null || true
    done < "$manifest"
    rm -f -- "$manifest"
    if [ "$remove_versions" = 1 ]; then rmdir -- "$install_dir/versions" 2>/dev/null || true; fi
    if [ "$remove_prefix" = 1 ]; then rmdir -- "$install_dir" 2>/dev/null || true; fi
    say "removed verified installation files; kept unknown or modified content"
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

fetch() {
  if command -v curl >/dev/null; then curl -fsSL --connect-timeout 15 --max-time 180 --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null; then wget -q --timeout=180 --tries=4 -O "$2" "$1"
  else die "NO_DOWNLOAD_TOOL: install curl or wget"
  fi
}

# Validate all destinations before any download or change to an active link.
created_prefix=0
created_versions=0
[ -d "$install_dir" ] || created_prefix=1
[ -d "$install_dir/versions" ] || created_versions=1
mkdir -p "$install_dir" "$bin_dir"
[ ! -e "$install_dir/layout.json" ] && [ ! -L "$install_dir/layout.json" ] || owned_entry f "$install_dir/layout.json" || die "INSTALL_OWNERSHIP_UNKNOWN: layout.json is not owned by this installer"
[ ! -L "$install_dir/versions" ] || die "INSTALL_PATH_INVALID: versions must not be a symlink"
link="$bin_dir/convorel"
if [ -e "$link" ] || [ -L "$link" ]; then
  owned_link "$link" || die "LINK_NOT_OWNED: refusing to replace $link"
fi
staging=""
source_dir=""
target=""
link_staging=""
committed=0
switched=0
old_convorel=""
[ ! -L "$bin_dir/convorel" ] || old_convorel="$(readlink "$bin_dir/convorel")"
cleanup() {
  status=$?
  trap - EXIT
  if [ "$committed" = 0 ]; then
    if [ "$switched" = 1 ]; then
      for name in convorel; do
        old="$old_convorel"
        if [ -n "$old" ]; then
          ln -s -- "$old" "$link_staging/rollback-$name"
          mv -Tf -- "$link_staging/rollback-$name" "$bin_dir/$name"
        else
          rm -f -- "$bin_dir/$name"
        fi
      done
    fi
    [ -z "$target" ] || rm -rf -- "$target"
  fi
  [ -z "$link_staging" ] || rm -rf -- "$link_staging"
  [ -z "$staging" ] || rm -rf -- "$staging"
  if [ -z "$dist_dir" ] && [ -n "$source_dir" ]; then rm -rf -- "$source_dir"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "$dist_dir" ]; then
  source_dir="$dist_dir"
  [ -f "$source_dir/sha256sums.txt" ] || die "CHECKSUMS_MISSING: $source_dir/sha256sums.txt"
else
  source_dir="$(mktemp -d)"
  case "$version" in
    latest) reference="latest/download" ;;
    *) reference="download/v$version" ;;
  esac
  fetch "$release_base/$reference/sha256sums.txt" "$source_dir/sha256sums.txt"
fi

# Exactly one safe artifact name per platform, with a validated version and digest.
mapfile -t lines < <(grep -e "-$platform\.tar\.gz$" "$source_dir/sha256sums.txt" || true)
[ "${#lines[@]}" -gt 0 ] || die "ARTIFACT_MISSING: no $platform build is published"
[ "${#lines[@]}" = 1 ] || die "MANIFEST_INVALID: multiple artifacts for $platform"
line="${lines[0]}"
[[ "$line" =~ ^([a-f0-9]{64})[[:space:]]+(convorel-([^/[:space:]]+)-$platform\.tar\.gz)$ ]] || die "MANIFEST_INVALID: invalid checksum entry"
want="${BASH_REMATCH[1]}"
archive="${BASH_REMATCH[2]}"
release="${BASH_REMATCH[3]}"
valid_version "$release" || die "MANIFEST_INVALID: invalid release version"
[ "$version" = latest ] || [ "$release" = "$version" ] || die "VERSION_MISMATCH: manifest does not match requested version"
[ -n "$dist_dir" ] || fetch "$release_base/$reference/$archive" "$source_dir/$archive"
[ -f "$source_dir/$archive" ] || die "ARTIFACT_MISSING: $source_dir/$archive"
[ "$(hash_of "$source_dir/$archive")" = "$want" ] || die "CHECKSUM_MISMATCH: refusing an artifact that does not match sha256sums.txt"

mkdir -p "$install_dir/versions"
staging="$(mktemp -d "$install_dir/parts.XXXXXXXX")"
# Reject traversal, links and special files before extracting even a checksum-valid archive.
tar -tzf "$source_dir/$archive" > "$staging/members"
while IFS= read -r member; do
  case "$member" in
    "${archive%.tar.gz}"|"${archive%.tar.gz}/"*) ;;
    *) die "ARTIFACT_INVALID: unexpected archive path" ;;
  esac
  case "$member" in *[$'\001'-$'\037']*) die "ARTIFACT_INVALID: control characters in archive path" ;; esac
  case "/$member/" in */../*|*/./*|*\\*) die "ARTIFACT_INVALID: unsafe archive path" ;; esac
done < "$staging/members"
tar -tvzf "$source_dir/$archive" > "$staging/types"
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {exit 1}' "$staging/types" || die "ARTIFACT_INVALID: archive contains links or special files"
tar -xzf "$source_dir/$archive" -C "$staging" --no-same-owner --no-same-permissions
extracted="$staging/${archive%.tar.gz}"
[ -f "$extracted/bin/convorel" ] && [ -x "$extracted/bin/convorel" ] ||
  die "ARTIFACT_INVALID: the archive does not contain bin/convorel"
installed="$(timeout 30 "$extracted/bin/convorel" --version)" || die "VERSION_MISMATCH: downloaded binary could not report its version"
[ "$installed" = "$release" ] || die "VERSION_MISMATCH: downloaded binary reports $installed, expected $release"

# Every attempt gets an immutable directory: reinstall/downgrade never removes history.
target="$(mktemp -d "$install_dir/versions/$release-$platform.XXXXXXXX")"
shopt -s dotglob nullglob
mv -- "$extracted"/* "$target/"
json_escape() { local value="$1"; value="${value//\\/\\\\}"; value="${value//\"/\\\"}"; printf '%s' "$value"; }
printf '{"version":1,"binDir":"%s"}\n' "$(json_escape "$bin_dir")" > "$staging/layout.json"
link_staging="$(mktemp -d "$bin_dir/.convorel-links.XXXXXXXX")"
ln -s -- "$target/bin/convorel" "$link_staging/convorel"
switched=1
mv -Tf -- "$link_staging/convorel" "$bin_dir/convorel"
installed="$(timeout 30 "$bin_dir/convorel" --version)" || die "UPGRADE_UNVERIFIED: installed binary failed"
[ "$installed" = "$release" ] || die "UPGRADE_UNVERIFIED: installed binary version differs"
# Build the next ownership ledger before publishing. Prior release files stay
# owned across upgrades; stale fingerprints never authorize deleting edits.
if [ -f "$manifest" ]; then cat -- "$manifest" > "$staging/owned"
else printf 'v\0convorel-owned-v1\0%s\0' "$install_dir" > "$staging/owned"; fi
while IFS= read -r -d '' file; do
  printf 'f\0%s\0%s\0' "$(hash_of "$file")" "$file" >> "$staging/owned"
done < <(find "$target" -type f -print0)
while IFS= read -r -d '' directory; do
  printf 'd\0\0%s\0' "$directory" >> "$staging/owned"
done < <(find "$target" -depth -type d -print0)
if [ "$created_versions" = 1 ]; then printf 'd\0\0%s\0' "$install_dir/versions" >> "$staging/owned"; fi
if [ "$created_prefix" = 1 ]; then printf 'd\0\0%s\0' "$install_dir" >> "$staging/owned"; fi
printf 'l\0%s\0%s\0' "$target/bin/convorel" "$bin_dir/convorel" >> "$staging/owned"
printf 'f\0%s\0%s\0' "$(hash_of "$staging/layout.json")" "$install_dir/layout.json" >> "$staging/owned"
mv -Tf -- "$staging/layout.json" "$install_dir/layout.json"
mv -Tf -- "$staging/owned" "$manifest"
committed=1
if owned_link "$bin_dir/agent-browser"; then
  rm -f -- "$bin_dir/agent-browser"
  say "removed the previously bundled agent-browser link"
fi
[ -z "$old_convorel" ] || say "previous release retained at $old_convorel"
say "installed convorel $installed -> $bin_dir/convorel"
say "install agent-browser separately; init records the command it finds on PATH"
case ":$PATH:" in *":$bin_dir:"*) ;; *)
  say "add it to PATH with: export PATH=\"$bin_dir:\$PATH\""
  ;;
esac
say "next: start Chrome with --remote-debugging-port, then run convorel setup"
say "see https://github.com/$owner/$repository/blob/main/docs/quickstart.md"
