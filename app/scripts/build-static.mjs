#!/usr/bin/env node
// Build a pure-static export for Cloudflare Pages / GitHub Pages.
//
// Why the shuffle: `output: "export"` forbids dynamic Route Handlers
// (Request bodies, force-dynamic, [dynamic] segments w/o
// generateStaticParams). Our /api and /admin dirs exist only for local
// dev + the data pipeline, and several of them hit those restrictions.
// Rather than rewriting them to be static-compatible, we rename them
// out of the app tree for the build and put them back when done.
//
// Safe against Ctrl-C / build failure: the finally block restores every
// move we made. Idempotent — re-running after a crash is fine because we
// skip any move whose source is already gone.
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

const HIDE = [
  ["src/app/api", "src/app/_api.hidden"],
  ["src/app/admin", "src/app/_admin.hidden"],
];

function move(from, to) {
  const abs = (p) => resolve(appRoot, p);
  if (!existsSync(abs(from))) return false;
  if (existsSync(abs(to))) {
    throw new Error(
      `refusing to overwrite ${to} — leftover from a prior aborted run; ` +
        `move it back to ${from} manually and retry.`
    );
  }
  renameSync(abs(from), abs(to));
  return true;
}

const moved = [];
let exitCode = 0;
try {
  for (const [from, to] of HIDE) {
    if (move(from, to)) moved.push([to, from]); // reverse pair for restore
  }
  const result = spawnSync("next", ["build"], {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env, STATIC_EXPORT: "1" },
    shell: false,
  });
  exitCode = result.status ?? 1;
} finally {
  // Restore in reverse order so nested moves (none today, but future-proof)
  // unwind cleanly.
  for (const [from, to] of moved.reverse()) {
    try {
      move(from, to);
    } catch (err) {
      console.error(`failed to restore ${from} -> ${to}:`, err);
      exitCode = exitCode || 1;
    }
  }
}
process.exit(exitCode);
