#!/usr/bin/env bash
# One-shot: raw videos -> meeting-ready cast. Idempotent.
# Requires: yt-dlp, ffmpeg, uv, ANTHROPIC_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/6 ingest from @VersoJobs"
./scripts/ingest.sh

pushd pipeline >/dev/null
echo "==> 2/6 transcribe"
uv run larp-pipeline transcribe

echo "==> 3/6 keyframes"
uv run larp-pipeline keyframes --per-video 6

echo "==> 4/6 characters (Claude vision)"
uv run larp-pipeline characters

echo "==> 5/6 personas"
uv run larp-pipeline personas

echo "==> 6/6 grunts"
uv run larp-pipeline grunts

echo "==> status"
uv run larp-pipeline status
popd >/dev/null

echo "==> done. From app/: pnpm dev, then open http://localhost:3000"
