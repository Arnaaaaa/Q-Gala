// Simulates many players walking in the hub. Needs a server running with DEV_LOGIN=1.
// Usage: node tools/loadtest.ts [clients=200] [seconds=60] [server=http://localhost:8080] [origin=http://localhost:5173]
import WebSocket from 'ws';
import { isWalkable, WORLD } from '../../shared/map.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

const [n = '200', secs = '60', server = 'http://localhost:8080', origin = 'http://localhost:5173'] = process.argv.slice(2);
const N = Number(n), DURATION = Number(secs) * 1000;

let bytes = 0, msgs = 0, joined = 0, errors = 0;
const latencies: number[] = [];

function randomDest(): { x: number; y: number } {
  for (;;) {
    const x = Math.round(Math.random() * WORLD.w), y = Math.round(Math.random() * WORLD.h);
    if (isWalkable(x, y)) return { x, y };
  }
}

async function bot(i: number): Promise<void> {
  const res = await fetch(`${server}/auth/dev-token`, { method: 'POST', body: JSON.stringify({ id: `loadbot${i}` }) });
  const { token } = (await res.json()) as { token: string };
  const ws = new WebSocket(server.replace(/^http/, 'ws') + '/ws', { origin });
  let moveSentAt = 0;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
  ws.on('error', () => errors++);
  ws.on('message', (data) => {
    bytes += (data as Buffer).length;
    msgs++;
    const m = JSON.parse(data.toString()) as ServerMsg;
    if (m.t === 'welcome') {
      if (!m.profile.name) ws.send(JSON.stringify({ t: 'claimName', name: `Bot ${i}` }));
      else if (m.profile.p0 === null) ws.send(JSON.stringify({ t: 'setBird', p0: 50 }));
      else ws.send(JSON.stringify({ t: 'joinHub' }));
    } else if (m.t === 'nameResult') {
      if (m.ok) ws.send(JSON.stringify({ t: 'setBird', p0: (i * 5) % 105 }));
      else ws.send(JSON.stringify({ t: 'claimName', name: `Bot ${Math.random().toString(36).slice(2, 10)}` }));
    }
    else if (m.t === 'birdResult') ws.send(JSON.stringify({ t: 'joinHub' }));
    else if (m.t === 'hubState') {
      joined++;
      const walk = () => {
        if (ws.readyState !== ws.OPEN) return;
        moveSentAt = performance.now();
        ws.send(JSON.stringify({ t: 'move', ...randomDest() }));
        setTimeout(walk, 2000 + Math.random() * 4000);
      };
      setTimeout(walk, Math.random() * 3000);
    } else if (m.t === 'moved' && moveSentAt) {
      latencies.push(performance.now() - moveSentAt);
      moveSentAt = 0;
    }
  });
  setTimeout(() => ws.close(), DURATION);
}

const start = Date.now();
await Promise.all(Array.from({ length: N }, (_, i) => new Promise((r) => setTimeout(r, i * 15)).then(() => bot(i))));
const timer = setInterval(() => {
  const s = (Date.now() - start) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(sorted.length * q)]?.toFixed(1) ?? '-';
  console.log(
    `t=${s.toFixed(0)}s joined=${joined}/${N} errors=${errors} ` +
      `down=${(bytes / 1024 / s / Math.max(joined, 1)).toFixed(2)} KB/s per client, ${(msgs / s / Math.max(joined, 1)).toFixed(1)} msg/s per client, ` +
      `move echo p50=${p(0.5)}ms p99=${p(0.99)}ms`,
  );
}, 5000);
setTimeout(() => {
  clearInterval(timer);
  process.exit(0);
}, DURATION + 1000);
