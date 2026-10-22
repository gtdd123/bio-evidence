import { createServer } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/webui/dist-demo');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2', '.json':'application/json; charset=utf-8' };
export async function startDemoServer(port = 5176) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid demo preview port');
  const directory = realpathSync(root);
  const server = createServer((request,response) => {
    const reject = code => { response.writeHead(code); response.end(); };
    try {
      if (!['GET','HEAD'].includes(request.method)) { reject(405); return; }
      const raw = (request.url ?? '/').split('?')[0];
      if (raw.includes('..') || /%2e|%2f|%5c|\\/i.test(raw)) { reject(404); return; }
      const name = decodeURIComponent(raw), path = realpathSync(resolve(directory, name === '/' ? 'index.html' : '.' + name)), offset = relative(directory,path);
      if (!offset || offset.startsWith('..') || isAbsolute(offset) || !statSync(path).isFile()) { reject(404); return; }
      const body = readFileSync(path);
      response.writeHead(200, { 'Content-Type':types[extname(path)] ?? 'application/octet-stream', 'Content-Length':body.length, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { reject(404); }
  });
  await new Promise((done,reject) => { server.once('error',reject);server.listen(port,'127.0.0.1',done); });
  return { server, origin:`http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, origin } = await startDemoServer();
  console.log(`BioEvidence static demo: ${origin} (no backend, no model requests)`);
  const stop = () => server.close(); process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
