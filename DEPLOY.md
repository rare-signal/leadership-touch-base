# Deploying

The app is architected to run as a pure-static bundle: the client fetches
everything from `/public/` as CDN assets, there's no live-LLM call, and
chat input is hidden in read-only mode. That means we can host it on any
free static CDN. **Cloudflare Pages** is the current primary target;
Vercel still works if you prefer it.

## One-time: stage the public bundles

Regardless of host, first materialize the media + JSON into `app/public/`:

```bash
python3 scripts/stage-public.py
git add -A app/public/
git commit -m "Restage public bundles"
git push
```

~230 MB total, individual files under 25 MB (Cloudflare's per-file limit).
Source MP4s are the biggest (up to ~20 MB each).

## Cloudflare Pages (recommended)

Free, no egress cap, no per-month bandwidth quota, good for video-heavy
sites like this one.

### Setup

1. In the Cloudflare dashboard: **Workers & Pages → Create → Pages →
   Connect to Git** and pick this repo.
2. Build configuration:
   - **Framework preset:** None
   - **Build command:** `cd app && npm install && npm run build:static`
   - **Build output directory:** `app/out`
   - **Root directory (advanced):** leave blank (repo root)
3. Environment variable: `NEXT_PUBLIC_READ_ONLY_CHAT=1`.
4. Save and deploy.

### How the build works

`npm run build:static` runs [`app/scripts/build-static.mjs`](app/scripts/build-static.mjs),
which:

1. Temporarily renames `src/app/api` → `src/app/_api.hidden` and
   `src/app/admin` → `src/app/_admin.hidden`. These dirs only exist for
   local dev + the pipeline; several routes use `force-dynamic` or
   Request bodies that `output: "export"` rejects.
2. Runs `next build` with `STATIC_EXPORT=1`, which flips
   [`next.config.ts`](app/next.config.ts) into export mode (`output:
   "export"`, `trailingSlash: true`, `images.unoptimized: true`).
3. Restores the hidden dirs in a `finally` block so dev is never left in
   a broken state.

Output lands in `app/out/` — static HTML + JS + the entire `public/` tree
copied alongside it. The meeting page reads `?v=` / `?topic=` client-side
via `useSearchParams()`, wrapped in a Suspense boundary.

### Re-deploying after data updates

Re-run the stage script, commit, push. Cloudflare rebuilds on push.

## Vercel (fallback)

Still works out of the box as a Next.js project — you get the full
server-rendered mode, so the legacy `/api/*` routes survive (useful if
you ever want to wire live-LLM back in).

1. Import the repo into Vercel.
   - Framework: **Next.js**
   - Root directory: **`app`**
   - Environment variable: **`NEXT_PUBLIC_READ_ONLY_CHAT=1`**
2. Deploy.

The client still fetches from `/public/` directly, so `/api/*` routes are
dead weight in prod on Vercel too — they're kept alive for local dev.

## What `READ_ONLY_CHAT=1` does

- Hides the chat input + Send button in the meeting UI.
- Ambient chat poller never calls `/api/turn` (the live-LLM fallback);
  when the pre-gen pack is exhausted it wraps around and re-uses messages.
- All other interactions — Corey host actions, speak-aware listen/concur
  loops, meeting rotation, reactions — still work because they're pack-
  driven, not LLM-driven.

## Fetching directly from `public/`

The client fetches static assets without the `/api/` prefix so any CDN
serves them raw:

| Asset | Path |
| --- | --- |
| Source video | `/source/<vid>.mp4` |
| Master audio | `/clips/_audio/<vid>.m4a` |
| Per-character clip | `/clips/<char_id>/<vid>_<tile>.mp4` |
| Grunt audio | `/grunts/<char_id>/<name>.mp3` |
| Chat pack | `/chats/<vid>.json` |
| All tile docs | `/tiles.json` |
| All characters + personas + grunts | `/characters.json` |
| Clip index | `/clips-index.json` |
