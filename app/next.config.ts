import type { NextConfig } from "next";

// When STATIC_EXPORT=1 we emit a pure-static `out/` bundle for Cloudflare
// Pages / GitHub Pages. Dev (`next dev`) + the legacy Vercel deploy keep
// the default server-rendered mode — the flag is off unless the
// `build:static` script sets it.
const isStaticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  // Next 16's dev-origin blocker returns "Not found" plain text when it
  // rejects a request. It wants hostnames (no protocol/port), not globs
  // with "*" alone. Allow private LAN ranges broadly for LAN dev.
  allowedDevOrigins: [
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
  ],
  ...(isStaticExport
    ? {
        output: "export" as const,
        // next/image's default loader needs a server; with a static export
        // we hand images to the browser raw. The meeting UI uses plain
        // <img> tags today, so this is belt-and-suspenders.
        images: { unoptimized: true },
        // Emit /foo/index.html instead of /foo.html so dumb static hosts
        // (GitHub Pages especially) serve clean URLs without rewrites.
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
