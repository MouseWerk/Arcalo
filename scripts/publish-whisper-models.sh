#!/usr/bin/env bash
# Publishes the Whisper models of voice notes as assets of the release `whisper-models-v1`
# (the default download source of Arcalo). Downloads each file from Hugging Face, checks its
# SHA-256 against crates/annalo-core/src/voice/models.rs and uploads it with the GitHub CLI.
#
#   scripts/publish-whisper-models.sh            # all models
#   REPO=owner/name scripts/publish-whisper-models.sh
#
# Needs: curl, sha256sum (or shasum), gh (logged in with write access to the repository).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-MouseWerk/Arcalo}"
TAG="whisper-models-v1"
SOURCE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
REGISTRY="crates/annalo-core/src/voice/models.rs"
WORK="${WORK:-$(mktemp -d)}"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# file<TAB>sha256 of every model in the registry.
models=$(awk '/file: "/ { gsub(/[",]/, "", $2); f = $2 } /sha256: "/ { gsub(/[",]/, "", $2); print f "\t" $2 }' "$REGISTRY")
[ -n "$models" ] || { echo "no models found in $REGISTRY" >&2; exit 1; }

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$REPO" --title "Whisper models (voice notes)" \
    --notes "Whisper models for Arcalo's voice notes (whisper.cpp ggml format), mirrored from Hugging Face (ggerganov/whisper.cpp). Arcalo checks every file against the SHA-256 in its source code." \
    --latest=false
fi

while IFS=$'\t' read -r file sum; do
  echo "== $file"
  curl -fL --retry 3 -C - -o "$WORK/$file" "$SOURCE/$file"
  got=$(sha256 "$WORK/$file")
  if [ "$got" != "$sum" ]; then
    echo "checksum mismatch for $file: $got (expected $sum)" >&2
    exit 1
  fi
  gh release upload "$TAG" "$WORK/$file" --repo "$REPO" --clobber
done <<< "$models"

echo "Published to https://github.com/$REPO/releases/tag/$TAG"
