// A tiny static server, run as its own process by startServer() in g4-env.ts (what `python3 -m http.server` was in the bash suites).
// usage: node g4-static-server.ts <dir> <port|0>   — prints "port N" once it listens.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 0);
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };

const server = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const rel = decodeURIComponent(u.pathname);
  let f = path.join(root, rel);
  if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    let st = statSync(f);
    if (st.isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: `${rel}/${u.search}` }).end(); return; }
      f = path.join(f, 'index.html');
      st = statSync(f);
    }
    const body = readFileSync(f);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<!doctype html><title>404</title><h1>Not Found</h1>');
  }
});
server.listen(port, () => {
  process.stdout.write(`port ${(server.address() as { port: number }).port}\n`);
});
