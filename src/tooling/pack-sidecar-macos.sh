#!/usr/bin/env bash
# Assembles the macOS sidecar under dist/sidecar/ (fork-only; upstream ships Windows only).
#   node-<triple>   bundled Node (Tauri externalBin)
#   server/         server bundle + production deps (better-sqlite3 ships darwin prebuilds)
#   bin/            yt-dlp, ffmpeg, ffprobe, deno for macOS
#   fonts/          Noto Sans SC Regular + OFL
#   legal/          LICENSE + SOURCE note
# Usage: bash src/tooling/pack-sidecar-macos.sh <arm64|x64>
set -euo pipefail
ARCH="${1:-arm64}"
NODE_VERSION=24.21.0
YTDLP_VERSION=2026.08.19
DENO_VERSION=2.9.7
RUNTIME_ASSETS=runtime-assets-2026.10.21
case "$ARCH" in
  arm64)
    TRIPLE=aarch64-apple-darwin
    FFMPEG_BASE=https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2
    FFMPEG_SHA=c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924
    FFPROBE_SHA=fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6
    ;;
  x64)
    TRIPLE=x86_64-apple-darwin
    FFMPEG_BASE=https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2
    FFMPEG_SHA=""
    FFPROBE_SHA=""
    ;;
  *) echo "unknown arch $ARCH" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist/sidecar"
DL="$ROOT/.macos-downloads"
mkdir -p "$DL"
rm -rf "$OUT"
mkdir -p "$OUT/server" "$OUT/bin" "$OUT/fonts" "$OUT/legal"

fetch() { # url dest [sha256]
  if [ ! -s "$2" ]; then curl -fsSL --retry 3 -o "$2" "$1"; fi
  if [ -n "${3:-}" ]; then echo "$3  $2" | shasum -a 256 -c -; fi
}

test -f "$ROOT/dist/server/server.js" || { echo "run pnpm build first" >&2; exit 1; }

# server + production dependencies
cp "$ROOT/dist/server/server.js" "$OUT/server/server.js"
cp "$ROOT/dist/server/uninstall-data.js" "$OUT/server/uninstall-data.js"
cp "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$OUT/server/"
(cd "$OUT/server" && CI=true pnpm install --prod --frozen-lockfile --config.node-linker=hoisted)
rm -rf "$OUT/server/node_modules/.bin"
test -s "$OUT/server/node_modules/better-sqlite3/prebuilds/darwin-$ARCH.node"

# node
NODE_TGZ="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ" "$DL/$NODE_TGZ"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $NODE_TGZ\$" | (cd "$DL" && shasum -a 256 -c -)
tar -xzf "$DL/$NODE_TGZ" -C "$DL" "node-v$NODE_VERSION-darwin-$ARCH/bin/node"
cp "$DL/node-v$NODE_VERSION-darwin-$ARCH/bin/node" "$OUT/node-$TRIPLE"

# yt-dlp (universal2)
fetch "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp_macos" "$DL/yt-dlp_macos"
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/SHA2-256SUMS" | grep " yt-dlp_macos\$" | (cd "$DL" && shasum -a 256 -c -)
cp "$DL/yt-dlp_macos" "$OUT/bin/yt-dlp"

# deno
DENO_ZIP="deno-$TRIPLE.zip"
fetch "https://github.com/denoland/deno/releases/download/v$DENO_VERSION/$DENO_ZIP" "$DL/$DENO_ZIP"
DENO_SHA=$(curl -fsSL "https://github.com/denoland/deno/releases/download/v$DENO_VERSION/$DENO_ZIP.sha256sum" | awk '{print $1}')
echo "$DENO_SHA  $DL/$DENO_ZIP" | shasum -a 256 -c -
unzip -o -q "$DL/$DENO_ZIP" deno -d "$OUT/bin"

# ffmpeg / ffprobe (static GPL builds by Martin Riedl, n9.0.2)
for tool in ffmpeg ffprobe; do
  sha_var=$( [ "$tool" = ffmpeg ] && echo "$FFMPEG_SHA" || echo "$FFPROBE_SHA" )
  fetch "$FFMPEG_BASE/$tool.zip" "$DL/$tool-$ARCH.zip" "$sha_var"
  unzip -o -q "$DL/$tool-$ARCH.zip" "$tool" -d "$OUT/bin"
done

# fonts (from the upstream pinned Runtime Assets release)
RA_URL="https://github.com/lifefindsitsway/amber-runtime-assets/releases/download/$RUNTIME_ASSETS"
fetch "$RA_URL/18_NotoSansSC.zip" "$DL/18_NotoSansSC.zip" 4d107c09ada479d3e48b6e78c83835773cbd9214bf6e12cdb7b60f8e068292ec
fetch "$RA_URL/OFL.txt" "$DL/OFL.txt" 6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2
unzip -o -q -j "$DL/18_NotoSansSC.zip" NotoSansSC-Regular.otf -d "$OUT/fonts"
cp "$DL/OFL.txt" "$OUT/fonts/OFL.txt"

# legal
cp "$ROOT/LICENSE" "$OUT/legal/LICENSE"
cat > "$OUT/legal/SOURCE.md" <<NOTE
Amber (macOS community build) is licensed AGPL-3.0-only.
Source: https://github.com/lifefindsitsway/Amber (upstream) plus the macOS build changes in this fork.
Bundled: Node.js $NODE_VERSION (MIT), yt-dlp $YTDLP_VERSION (Unlicense), Deno $DENO_VERSION (MIT),
FFmpeg 9.0.2 GPL static build by Martin Riedl (https://ffmpeg.martin-riedl.de, GPL-3.0-or-later),
Noto Sans SC (OFL-1.1).
NOTE

chmod +x "$OUT/node-$TRIPLE" "$OUT"/bin/*
# Drop quarantine/provenance attributes picked up from downloads.
xattr -cr "$OUT" 2>/dev/null || true
echo "sidecar ready: $OUT ($TRIPLE)"
ls -la "$OUT" "$OUT/bin"
