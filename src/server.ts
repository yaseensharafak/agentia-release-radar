import * as http from 'http';
import { ActionDeps, handleInteraction } from './actions';

export function createServer(d: ActionDeps): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/slack/actions') {
      d.log?.(`[radar] unexpected request ${req.method} ${req.url} (Slack's Request URL must end with /slack/actions)`);
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 100_000) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const r = handleInteraction(Buffer.concat(chunks).toString('utf8'), headers, d);
      const why =
        r.status === 401 ? ' (signature mismatch: wrong SLACK_SIGNING_SECRET, or this PC\'s clock is off by more than 5 minutes)'
        : r.status === 503 ? ' (SLACK_SIGNING_SECRET is not set in this window)'
        : r.status === 400 ? ' (bad request)'
        : '';
      d.log?.(`[radar] Slack button click received -> HTTP ${r.status}${why}`);
      res.writeHead(r.status).end(r.body);
      r.done?.catch(() => undefined);
    });
  });
}
