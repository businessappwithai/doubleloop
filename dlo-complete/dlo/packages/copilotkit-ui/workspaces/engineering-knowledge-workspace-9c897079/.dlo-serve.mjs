// DLO deploy bootstrap for TanStack Start (srvx build target).
import { serve } from "srvx";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import server from "./dist/server/ssr.js";

const CLIENT_DIR = join(process.cwd(), "dist/client");
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

serve({
  port: Number(process.env.PORT) || 3001,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/" && !url.pathname.endsWith("/")) {
      const filePath = join(CLIENT_DIR, url.pathname);
      try {
        const s = await stat(filePath);
        if (s.isFile()) {
          const body = await readFile(filePath);
          return new Response(body, { headers: { "content-type": TYPES[extname(filePath)] || "application/octet-stream", "cache-control": "public, max-age=31536000" } });
        }
      } catch { /* fall through to SSR */ }
    }
    return server.fetch(req);
  },
});
console.log("[DLO] app serving on :" + (Number(process.env.PORT) || 3001));
