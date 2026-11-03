import type { ClientMsg, KickCode, ServerMsg } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';

type Status = 'connecting' | 'open' | 'reconnecting';

/** One WebSocket to the game server, with jittered exponential reconnect. */
export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<(m: ServerMsg) => void>();
  private attempt = 0;
  private timer = 0;
  private stopped = false;
  private url: string;
  private token: string;
  onStatus: (s: Status) => void = () => {};
  onKicked: (code: KickCode) => void = () => {};

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  connect(): void {
    if (this.stopped) return;
    this.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token } satisfies ClientMsg));
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        this.attempt = 0;
        this.onStatus('open');
      }
      if (m.t === 'kicked') {
        this.stop();
        this.onKicked(m.code);
        return;
      }
      for (const fn of this.handlers) fn(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  /** Delay starts at a random 1–3 s and doubles up to 30 s, so a server restart doesn't get a stampede. */
  private scheduleReconnect(): void {
    const { baseMinMs, baseMaxMs, capMs } = TUNABLES.reconnect;
    const base = baseMinMs + Math.random() * (baseMaxMs - baseMinMs);
    const delay = Math.min(capMs, base * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.onStatus('reconnecting');
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(fn: (m: ServerMsg) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  /** Resolves with the next message of type `t`, or rejects after `ms`. */
  waitFor<T extends ServerMsg['t']>(t: T, ms = 8000): Promise<Extract<ServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        off();
        reject(new Error('timeout'));
      }, ms);
      const off = this.on((m) => {
        if (m.t !== t) return;
        clearTimeout(timeout);
        off();
        resolve(m as Extract<ServerMsg, { t: T }>);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
