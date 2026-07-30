/**
 * Zero-dependency static server for the dev harness.
 *
 * Why serve at all instead of opening the file directly: browsers block ES
 * module imports over file:// (CORS), and a file:// page sends `Origin: null`
 * which makes the HTTP API's CORS behaviour needlessly fiddly. Serving over
 * localhost avoids both.
 *
 * Usage: npm run harness
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "..", "apps", "harness");
const PORT = Number(process.env.PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

createServer(async (req, res) => {
  // Strip the query string and refuse traversal outside the harness directory.
  const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const rel = normalize(requested === "/" ? "/index.html" : requested);
  if (rel.includes("..")) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(PORT, () => {
  console.log(`\n  Backrow harness  ->  http://localhost:${PORT}\n`);
  console.log("  Open it in two tabs to see fan-out between clients.\n");
});
