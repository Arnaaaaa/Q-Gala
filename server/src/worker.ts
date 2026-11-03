// Cloudflare entry. The Worker forwards every request to one Durable Object, "world",
// which plays the part of the single Node process: it owns the hub, the matches,
// every WebSocket and the SQLite database (Durable Object storage).
import type { Db, SqlDriver, SqlValue } from './db.ts';
import type { Game } from './game.ts';

// Minimal slices of the Workers runtime types, so the server keeps one tsconfig with Node types.
type SqlCursor = { toArray(): Record<string, SqlValue>[]; readonly rowsWritten: number };
type DurableObjectState = {
  storage: { sql: { exec(query: string, ...bindings: SqlValue[]): SqlCursor } };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
};
type DurableObjectStub = { fetch(req: Request): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub };
type Env = Record<string, unknown> & { WORLD: Namespace };
type WorkerSocket = WebSocket & { accept(): void };
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WorkerSocket } };

const MAX_MESSAGE = 4096;

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return env.WORLD.get(env.WORLD.idFromName('world')).fetch(req);
  },
};

function durableSql(state: DurableObjectState): SqlDriver {
  const sql = state.storage.sql;
  return {
    exec: (q) => void sql.exec(q).toArray(),
    run: (q, ...a) => {
      const c = sql.exec(q, ...a);
      c.toArray();
      return { changes: c.rowsWritten };
    },
    get: <T>(q: string, ...a: SqlValue[]) => sql.exec(q, ...a).toArray()[0] as T | undefined,
    all: <T>(q: string, ...a: SqlValue[]) => sql.exec(q, ...a).toArray() as T[],
  };
}

export class World {
  private handle!: (req: Request) => Promise<Response>;
  private game!: Game;
  private originAllowed!: (req: Request) => boolean;

  constructor(state: DurableObjectState, env: Env) {
    // config.ts reads process.env when first imported, so fill it before importing the game.
    for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
    void state.blockConcurrencyWhile(async () => {
      const [{ Db }, { Game }, http] = await Promise.all([import('./db.ts'), import('./game.ts'), import('./http.ts')]);
      const db: Db = new Db(durableSql(state));
      this.game = new Game(db);
      this.handle = http.createHttpHandler(db, this.game);
      this.originAllowed = http.originAllowed;
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== '/ws') return this.handle(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    // Only the Pages site may open browser connections.
    if (!this.originAllowed(req)) return new Response('forbidden', { status: 403 });
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    const events = this.game.onConnection({
      get open() {
        return ws.readyState === WebSocket.OPEN;
      },
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
    });
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      if (e.data.length > MAX_MESSAGE) return ws.close(1009, 'too big');
      events.message(e.data);
    });
    ws.addEventListener('close', events.close);
    ws.addEventListener('error', events.close);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
}
