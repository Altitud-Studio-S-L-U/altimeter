import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pdf': 'application/pdf',
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface StaticSite {
  readonly origin: string;
  close(): Promise<void>;
}

/** A request target in origin form (`/a?b`, where `//a` is a path and not a host) or in absolute form. */
function requestUrl(target: string): URL {
  return new URL(target.startsWith('/') ? `http://localhost${target}` : target);
}

/**
 * Serves a static build the way common static hosts do: `/path/` serves `path/index.html`, `/path` redirects to
 * `/path/` when it is a folder or serves `path.html`, and unknown paths, including those with an empty segment such
 * as `//path`, answer 404 with `404.html` when present. Requests can never read outside `root`.
 */
export async function serveStatic(root: string): Promise<StaticSite> {
  const base = resolve(root);
  if (!(await isDirectory(base))) throw new Error(`${root} is not a folder`);
  const server: Server = createServer((req, res) => {
    void (async () => {
      let url: URL;
      let path: string;
      try {
        url = requestUrl(req.url ?? '/');
        path = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const target = resolve(base, `.${path}`);
      if (target !== base && !target.startsWith(base + sep)) {
        res.writeHead(403).end();
        return;
      }
      const send = (file: string, status = 200) => {
        res.writeHead(status, { 'content-type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream' });
        if (req.method === 'HEAD') res.end();
        else createReadStream(file).pipe(res);
      };
      const notFound = async () => {
        const page = join(base, '404.html');
        if (await isFile(page)) return send(page, 404);
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      };
      // No file of the build has an empty name, so `//about` is unknown rather than `/about`.
      if (path.includes('//')) return notFound();
      if (path.endsWith('/')) {
        const index = join(target, 'index.html');
        if (await isFile(index)) return send(index);
      } else if (await isFile(target)) {
        return send(target);
      } else if (await isDirectory(target) && await isFile(join(target, 'index.html'))) {
        res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
        return;
      } else if (await isFile(`${target}.html`)) {
        return send(`${target}.html`);
      }
      return notFound();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
