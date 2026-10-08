#!/usr/bin/env bash
# Copy the wallet core's browser build into wasm/ and record where it came from.
#
#   tools/import-wasm.sh <jetsam repo checkout> [build dir]
#
# Builds jetsam_wallet_wasm with the repository's own build script
# (jetsam_wallet_wasm/build.sh: stable toolchain, wasm-bindgen 0.2.122,
# no-modules glue for classic Workers, build paths remapped), then copies
# the module and its glue here with their SHA-256 and the source commit in
# wasm/SOURCE.txt. Rebuilding the same commit gives the same bytes; the
# static tests check the hashes recorded here.
set -euo pipefail
src="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${2:-$(mktemp -d)}"
commit="$(git -C "$src" rev-parse HEAD)"
if [ -n "$(git -C "$src" status --porcelain -- jetsam_core jetsam_poseidon2b jetsam_tx jetsam_gkr jetsam_wallet_core jetsam_wallet_wasm Cargo.lock)" ]; then
  echo "uncommitted changes in the wallet core sources: commit first" >&2
  exit 1
fi
"$src/jetsam_wallet_wasm/build.sh" "$out"
cp "$out/web/jetsam_wallet_wasm_bg.wasm" "$out/web/jetsam_wallet_wasm.js" "$here/wasm/"
{
  echo "Source: jetsam repository, commit $commit"
  echo "Built with: jetsam_wallet_wasm/build.sh ($(rustc +stable --version), wasm-bindgen $("${WASM_BINDGEN:-wasm-bindgen}" --version | awk '{print $2}'))"
  echo
  (cd "$here/wasm" && sha256sum jetsam_wallet_wasm_bg.wasm jetsam_wallet_wasm.js)
} > "$here/wasm/SOURCE.txt"
cat "$here/wasm/SOURCE.txt"
