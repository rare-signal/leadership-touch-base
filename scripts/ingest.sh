#!/usr/bin/env bash
# Download every short from @VersoJobs with full metadata.
# Idempotent: yt-dlp --download-archive skips already-fetched ids.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data/raw

yt-dlp \
  --download-archive data/raw/.archive.txt \
  --write-info-json \
  --write-description \
  --write-auto-subs \
  --write-subs \
  --sub-langs "en.*" \
  --convert-subs srt \
  --write-thumbnail \
  --convert-thumbnails jpg \
  --format "bestvideo*+bestaudio/best" \
  --merge-output-format mp4 \
  -o "data/raw/%(id)s/%(id)s.%(ext)s" \
  --sleep-requests 1 \
  --sleep-interval 2 \
  --max-sleep-interval 5 \
  --ignore-errors \
  "https://www.youtube.com/@VersoJobs/shorts" \
  "$@"
