#!/usr/bin/env bash
# Build static Linux releases. Optional output directory keeps acceptance builds isolated.
set -euo pipefail
cd "$(dirname "$0")/.."
build_version="$(cat VERSION)"
[[ "$build_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$ ]] || { echo 'invalid VERSION' >&2; exit 1; }
output_dir="${1:-$PWD/dist}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
build_temp="$(mktemp -d)"
trap 'rm -rf "$build_temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
go run scripts/build-assets.go "$build_temp"
for release_arch in x64 arm64; do
  go_arch="$release_arch"
  [ "$release_arch" != x64 ] || go_arch=amd64
  artifact="convorel-$build_version-linux-$release_arch"
  stage="$build_temp/$artifact"
  mkdir -p "$stage/bin"
  CGO_ENABLED=0 GOOS=linux GOARCH="$go_arch" go build -overlay "$build_temp/overlay.json" -trimpath \
    -ldflags "-s -w -X github.com/MarioJames/convorel/internal/service.Version=$build_version" \
    -o "$stage/bin/convorel" ./cmd/convorel
  cp LICENSE NOTICE THIRD_PARTY_LICENSES.md "$stage/"
  # License notices for linked Go modules, including transitive dependencies.
  mkdir -p "$stage/licenses"
  go list -m -f '{{if .Dir}}{{.Dir}}{{end}}' all > "$build_temp/modules"
  while IFS= read -r module_dir; do
    [ -n "$module_dir" ] || continue
    [ "$module_dir" != "$PWD" ] || continue
    license_index="$(printf '%s' "$module_dir" | sha256sum | cut -c1-16)"
    for notice_file in "$module_dir"/LICENSE* "$module_dir"/COPYING* "$module_dir"/NOTICE*; do
      [ -f "$notice_file" ] || continue
      cp "$notice_file" "$stage/licenses/$license_index-$(basename "$notice_file")"
    done
    printf '%s %s\n' "$license_index" "${module_dir##*/pkg/mod/}" >> "$stage/licenses/modules.txt"
  done < "$build_temp/modules"
  tar -czf "$output_dir/$artifact.tar.gz" -C "$build_temp" "$artifact"
done
(cd "$output_dir" && sha256sum "convorel-$build_version-linux-x64.tar.gz" "convorel-$build_version-linux-arm64.tar.gz" > sha256sums.txt)
