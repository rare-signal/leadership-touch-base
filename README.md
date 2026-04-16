# LARP Meeting

> Join a Zoom call with the cast of **[@VersoJobs](https://www.youtube.com/@VersoJobs/shorts)**.

An unofficial tribute project. One actor, many characters — turned into a meeting you can actually attend.

## Status

Early kickoff. See `data/ingest.log` for live channel download.

## How it works

1. **Ingest** — `yt-dlp` pulls every short from the channel: video, subs, thumbnail, metadata.
2. **Transcribe** — `faster-whisper` produces word-level transcripts.
3. **Character detection** — CLIP embeddings on keyframes → cluster → multimodal Claude labels each cluster with role, costume, mannerisms. One actor, many characters, so voice biometrics don't help — vision does.
4. **Persona synthesis** — Claude reads each character's lines and produces a roleplay system prompt.
5. **Grunt extraction** — short non-verbal ad-libs per character, normalized into an audio sprite.
6. **Meeting app** — Next.js + shadcn Zoom clone. You chat, the cast responds in-character with text + grunt.

## Running

```bash
./scripts/ingest.sh                        # download channel
cd pipeline && uv run larp-pipeline all    # transcribe → cluster → personas → grunts
cd ../app && pnpm dev                      # meeting at http://localhost:3000
```

## Credits

Tribute to the work of [@VersoJobs](https://www.youtube.com/@VersoJobs). No affiliation. No redistribution of full videos; only derivative metadata and short ad-lib audio clips used under fair use for commentary and parody.

## License

MIT
