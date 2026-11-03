// Local development entry (Node). Production runs on Cloudflare: see worker.ts.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config, discordConfigured } from './config.ts';
import { Db } from './db.ts';
import { Game } from './game.ts';
import { createHttpHandler } from './http.ts';
import { nodeSqlite } from './sqlite-node.ts';

const db = new Db(nodeSqlite(config.dbPath));
const game = new Game(db);
const handle = createHttpHandler(db, game);

// Bridges Node's request/response objects to the fetch-style handler.
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) return void res.writeHead(413).end();
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const response = await handle(
    new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4096,
  // Only the Pages site may open browser connections.
  verifyClient: (info: { origin: string }) => config.allowedOrigins.includes(info.origin),
});
wss.on('connection', (ws) => {
  const events = game.onConnection({
    get open() {
      return ws.readyState === ws.OPEN;
    },
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    ping: () => ws.ping(),
    terminate: () => ws.terminate(),
  });
  ws.on('pong', events.pong);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) events.message(data.toString());
  });
  ws.on('close', events.close);
  ws.on('error', () => ws.terminate());
});

server.listen(config.port, () => {
  console.log(`Q-Gala server on :${config.port} (origin ${config.allowedOrigins.join(', ')})`);
  if (config.devLogin) console.warn('DEV_LOGIN is on. Never enable it in production.');
  if (!discordConfigured()) console.warn('Discord OAuth is not configured.');
});

function shutdown(): void {
  game.shutdown();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
