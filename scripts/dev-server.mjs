// Local development server: serves /public and routes /api/* to the Netlify function.
// Usage: APP_SECRET=... ADMIN_PASSWORD=... npm run dev   (data is kept in ./.local-data)
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.LOCAL_BLOBS_DIR ||= path.join(root, '.local-data');
process.env.APP_SECRET ||= 'local-development-secret-change-me-0123456789';
process.env.ADMIN_PASSWORD ||= 'local-admin-pass';

const { default: handler } = await import('../netlify/functions/api.mjs');
const PORT = Number(process.env.PORT || 8888);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const request = new Request(url, { method: req.method, headers: req.headers, body });
      const response = await handler(request, { ip: req.socket.remoteAddress });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let p = url.pathname;
    if (p.startsWith('/e/')) p = '/form.html';
    else if (p === '/admin' || p === '/admin/') p = '/admin.html';
    else if (p.endsWith('/')) p += 'index.html';
    const filePath = path.join(root, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(e.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}).listen(PORT, () => console.log(`AWA Redirection app running at http://localhost:${PORT}  (admin: /admin)`));
