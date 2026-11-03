# Q-Gala

A Club Penguin–style browser game for Qiskit Fall Fest (9 November 2026). Players hatch a bird whose colours show the odds of measuring |0⟩ (indigo) or |1⟩ (violet), then walk around a shared hub.

**Status: build plan Nov 1–3 step done.** Login, names, the bird creator, the shared hub, chat and emotes, Gate Dash (now with 3-gate levels), Ravens and Robins with practice bots, the Hall of Pioneers, the leaderboard and learning cards all work. Still to come: the status banner, admin tools, backups and the runbook (see [Progress](#progress)).

## Architecture

```
client/  Static site (Vite + TypeScript, Canvas 2D) → GitHub Pages
server/  HTTPS API + WebSocket game server → Cloudflare Worker + one Durable Object (Node 24 locally)
shared/  Code used by both: message types, map, name rules, tunables, colours
```

- **Server authority.** The client sends only intentions (a name to claim, a P0 value, a walk destination). The server validates each one and decides the outcome.
- **One authoritative instance.** In production the Worker forwards every request to a single Durable Object named `world` ([server/src/worker.ts](server/src/worker.ts)). It holds the hub, the matches and every WebSocket in memory, just as one Node process does, so the game code is the same on both runtimes.
- **Storage.** SQLite: the Durable Object's built-in SQLite storage in production, and Node's `node:sqlite` ([server/src/sqlite-node.ts](server/src/sqlite-node.ts)) locally and in tests. `Db` talks to either one through a small driver interface.
- **No build step on the server.** Node 24 runs the `.ts` files directly using its built-in type stripping, and wrangler bundles the same files for Cloudflare.
- **Hub networking.** A move sends one `move` message with the destination. The server broadcasts `moved` (start point and target) to players within `viewRadius`, and clients animate the walk at a shared constant speed. Every 500 ms the server recomputes who sees whom: each player gets the nearest 59 birds and receives `enter`/`leave` events as birds come and go. A corrective `sync` runs every 4 s.
- **Portability.** Only `worker.ts` and `wrangler.jsonc` are Cloudflare-specific. The Node entry ([server/src/index.ts](server/src/index.ts)) can still run the server on any Linux host behind a TLS proxy.

All tunable numbers live in [shared/tunables.ts](shared/tunables.ts). Secrets and deployment settings come from environment variables, never from the repository (see [server/.env.example](server/.env.example)).

### Login flow and the Discord membership check

1. The browser goes to `GET /auth/discord/start`. The server stores a random `state` value and redirects the browser to Discord.
2. Discord sends the browser back to `GET /auth/discord/callback`. The server exchanges the code using the client secret, which only the server holds.
3. The server checks membership with **`GET /users/@me/guilds/{guild.id}/member`** under the scopes **`identify guilds.members.read`**. This endpoint reveals only the player's membership of the one event server: their nickname, roles and user ID. It does not reveal their full server list, which the `guilds` scope would. A 404 means the player is not a member. If `DISCORD_REQUIRED_ROLE_ID` is set, that role is also required. **[DECISION]** The organizers still need to approve this method.
4. The server revokes the Discord access token right away and never stores it.
5. The server creates a Q-Gala session, signed with HMAC and valid for 12 h, and redirects to the Pages site with a one-time, 60-second **ticket** in the URL fragment. The client exchanges the ticket for the session token with `POST /auth/exchange`, then strips the fragment from the address bar.
6. **One session per player.** Each login replaces the stored `session_id`, so older tokens stop working and any live connection is closed with "Playing somewhere else?". A second tab using the same token also replaces the first.

## Local development

Node 24 or later is required.

```sh
npm install
cp server/.env.example server/.env      # DEV_LOGIN=1 is already set
npm run dev:server                      # http://localhost:8080 (Node)
npm run dev:client                      # http://localhost:5173
```

To run on the real Cloudflare runtime instead:
1. Create `server/.dev.vars` with `PUBLIC_URL=http://localhost:8787`, `CLIENT_URL=http://localhost:5173` and `DEV_LOGIN=1`.
2. Run `npm -w server run cf:dev`, which serves on port 8787.
3. Start the client with `VITE_API_URL=http://localhost:8787`.

With `DEV_LOGIN=1`, the landing page shows a **Dev login** box that skips Discord. Each name you type becomes its own test user. To try two players, open a second browser profile or a private window, because a second tab in the same profile replaces the first by design.

```sh
npm test                                # server unit tests
npm run typecheck
npm run loadtest -- 200 60              # 200 bots walking for 60 s (server must have DEV_LOGIN=1)
```

Load test result from 23 Oct 2026, on a laptop with the server and bots on the same machine: 200 of 200 joined with 0 errors, about 3 KB/s and about 35 messages/s down per client, and a move round trip of p50 0.7 ms and p99 about 60 ms. Every bot spawned in the plaza, so each one saw the maximum 59 others, which is the worst case for this test.

## Deployment

### Discord application
1. At discord.com/developers, create an application. Under **OAuth2**, add the redirect `https://<api-domain>/auth/discord/callback`.
2. Keep the client ID and secret for the server secrets below. You also need the event server's ID (Developer Mode → right-click the server → Copy ID) and an invite link that does not expire.

### Server (Cloudflare Worker + Durable Object)
1. Create a Cloudflare account, then run `npx -w server wrangler login`. The Workers Free plan includes SQLite-backed Durable Objects.
2. Edit the `vars` in [server/wrangler.jsonc](server/wrangler.jsonc). Set `PUBLIC_URL` to the Worker's https address, `CLIENT_URL` to the Pages site, and `DISCORD_INVITE_URL`; `ADMIN_IDS` and `RESERVED_NAMES` come later. These values are not secret.
3. Set the secrets from `server/`. Cloudflare stores them encrypted, and they never go in the repo:
   ```sh
   npx wrangler secret put SESSION_SECRET          # 64 random hex characters
   npx wrangler secret put DISCORD_CLIENT_ID
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put DISCORD_GUILD_ID
   ```
   `DEV_LOGIN` must **not** be set in production.
4. Deploy with `npm -w server run deploy`, or let [.github/workflows/worker.yml](.github/workflows/worker.yml) deploy each push to `main`. The workflow needs two repository secrets:
   - `CLOUDFLARE_API_TOKEN`, created from the "Edit Cloudflare Workers" template
   - `CLOUDFLARE_ACCOUNT_ID`
5. Optional custom domain: once the domain's DNS is on Cloudflare, uncomment `routes` in `wrangler.jsonc`. Cloudflare handles TLS and WebSocket upgrades, so there is no proxy to run.
6. Point the uptime monitor at the health check, `https://<api-domain>/health`.

Notes for the event:
- **Restarts.** A deploy restarts the Durable Object. Players reconnect automatically, but any match in progress is lost, so don't deploy during the event.
- **Cost.** On the free plan, two limits matter: 100,000 requests a day, where every 20 incoming WebSocket messages count as one request, and 13,000 GB-s a day of Durable Object duration. Before 9 Nov, compare the event-day load test with the usage shown in the dashboard. If it comes close to either limit, the $5/month Workers Paid plan removes the problem.
- **Backups.** Durable Object SQLite automatically keeps 30 days of point-in-time recovery. A scheduled export is part of D12.

### Client (GitHub Pages)
In the repository settings, set Pages → Source to **GitHub Actions** and add the repository variable `API_URL=https://<api-domain>`. Each push to `main` then deploys through [.github/workflows/pages.yml](.github/workflows/pages.yml).

## Assumptions (recorded per spec §1)

- **Names** allow ASCII letters only, plus digits, spaces, `_` and `-`. Allowing all Unicode letters would bring look-alikes such as Cyrillic "а" that are hard to catch. Runs of spaces are collapsed, and leading or trailing spaces are trimmed.
- **Look-alike folding** for uniqueness: case, spaces, `_` and `-` are ignored. Also folded: 0→o, 1/i→l, 3→e, 4→a, 5→s, 7→t, 8→b, 9→g, 2→z, rn→m, vv→w.
- **Reserved words** of 4 or more characters also block any name that contains them (for example "Qiskit Fan"). Shorter ones, such as `mod` and `ibm`, block only an exact match. Team members' names go in `RESERVED_NAMES`. The profanity list is in [server/src/blocklist.ts](server/src/blocklist.ts).
- **Avatar change limit.** Saving the first bird counts as a change, so "My bird" can be changed again 60 s after hatching.
- **Gradient direction.** The bird runs from indigo at the top to violet at the bottom, and the boundary sits at P0 % of its height.
- **Colours.** Indigo is IBM Purple 80 `#491d8b` and violet is IBM Purple 40 `#be95ff`, with a contrast ratio of about 5:1 between them. The accent is IBM Yellow 30 `#f1c21b`.
- **Walkability.** The server checks only the destination: it must be inside the map and outside the buildings. Walks are straight lines.
- **Gate Dash 3-gate levels.** X, H and Z join the four states in a ring (|0⟩–|1⟩–|−⟩–|+⟩–|0⟩), so with all three gates any target is at most 2 gates away. A level that genuinely needs 3 gates therefore allows only two of them. With only H and Z, |0⟩→|1⟩ needs H Z H, which teaches that HZH acts as X. With only X and H, |+⟩→|−⟩ needs H X H. Locked gates are shown greyed out with 🔒, and the server rejects them. Levels 1–3 need 1 gate, and levels 4–7 need 1 or 2. From level 8, half the levels (`gateDash.threeGateShare`) are 3-gate puzzles; the rest need 1 or 2 gates with all three available.
- **Gate Dash anti-cheat.** For each level, the client sends the gates tapped since the level appeared (or since the last reset) and the time between taps. The server replays the gates. It rejects the solve if any gap is under 150 ms or the claimed time is longer than the real time since the level was sent (plus 1 s slack). A rejected level restarts. The client ignores taps closer than 150 ms, so honest players never hit this. A perfect bot scored about 1,800 in a test; a human is far slower.
- **Gate Dash practice.** The 3-level guided practice runs in the browser and is unscored. Whether it has been done is remembered per device.
- **Quitting a Gate Dash run** (✕, disconnect, closing the tab) still saves the score so far. Only a new personal best changes anything.
- **Leaderboard.** Players with a total of 0 are not ranked. The Top 10 is cached for 30 s but refreshed as soon as anyone sets a new best. Test accounts (`TEST_ACCOUNT_IDS`, and dev logins) are never ranked.
- **Emotes.** The server draws the Collapse outcome, so everyone sees the same result. Superpose alternates colours 2.5 times a second, under the limit of 3. With reduce motion on it shows a static "0+1" instead, and Flap doesn't bob.
- **Hall of Pioneers.** Cards come from [client/public/content/pioneers.json](client/public/content/pioneers.json). The spec supplies only the one-line "Known for" texts and forbids inventing facts, so each card's `story` field (up to 60 words) is **empty for the organizers to write**. Until then, the detail view shows the "Known for" line. Badges are original bird icons with the person's initials, so no images are downloaded. **[DECISION]** A reviewer still needs to check the text.
- **Learning cards** live in [client/public/content/cards.json](client/public/content/cards.json). Editing that file and redeploying the static site changes them, with no code change. **[DECISION]** A mentor still needs to review them.

## Ravens and Robins

The server code is in [server/src/ravens.ts](server/src/ravens.ts). The round rules (`fly`, `score` and the bot decisions) are pure functions, shared by the game, the tests and the calibration tool.

- **Queue.** Players join from the Flight Deck. The server forms a trio as soon as three are waiting. If fewer are waiting after 20 s, practice bots (named "Practice bot …") fill the empty seats. Before a player's first match there are 5 skippable intro cards, remembered per device.
- **Rounds.** A match has 3 rounds, and roles rotate so each player is Sender, Receiver and Raven once. The phases are launch (3 s), choose (20 s), compare (15 s), verdict (20 s) and result (9 s). The server enforces every timer and applies the default when one runs out: random winds, no intercepts, a sample of 6, and Abort if no verdict is given. The choose phase ends early once both the Receiver and the Raven have pressed Done.
- **Information rules.** Each message goes only to the roles allowed to see it:
  - the Sender's bits and winds go to the Sender only (`rrSecret`)
  - the Raven's readings go to the Raven only (`rrRead`)
  - the Sender's reaction goes to the Receiver only (`rrReaction`)
  - everything else is public

  This is checked for every role in every round in [server/test/ravens.test.ts](server/test/ravens.test.ts). The browser test of a real match showed the same: the client received `rrSecret` once (in its Sender round) and `rrRead` once (in its Raven round).
- **Disconnects.** A practice bot takes the seat and the match continues. Everyone still in the match has their score saved the moment it ends. The player who left gets nothing for that match.
- **No chat during a match.** Phrases and emotes are blocked on the server; the two reaction buttons are the only channel. Bird changes are also blocked during a match.

### Calibration (`npm -w server run calibrate`, 100,000 rounds per row, 23 Oct 2026)

| Raven intercepts | Storm | ≥1 checked note disagrees | Bot Receiver aborts | Raven out-scores Robins |
|---|---|---|---|---|
| 0 | random | 15.9 % | 7.0 % | 7.0 % |
| 4 | none | 17.8 % | 17.8 % | 3.8 % |
| 4 | random | 30.6 % | 19.4 % | 3.6 % |
| 8 | random | 42.9 % | 30.4 % | 14.0 % |
| 16 | none | 55.9 % | 55.9 % | 27.0 % |
| 16 | random | 61.9 % | 48.6 % | 31.2 % |

- **16 intercepts** cause a checked disagreement in 56–62 % of rounds. The target is 50–70 %. ✓
- **4 intercepts** cause one in 18 % of rounds on their own. The target is under 30 %. ✓ With storms added the rate is 31 %, but the extra comes from weather, not the Raven.
- **Balance.** With the spec's score of 2 points per learned key bit, the Raven out-scored the Robins in only about 4 % of bot-vs-bot rounds, so the Robins won nearly every round. Raising it to **4** (`rr.points.ravenPerLearnedBit`) brings that to about 15 %, and to 31 % for a bold Raven who intercepts 16 notes. Detection rates are unchanged. **Approved by the organizers on 30 Oct 2026.**

## Progress

| # | Deliverable | State |
|---|---|---|
| D1 | Login and access | Done. Needs a real Discord application to test end to end. |
| D2 | Unique names | Done |
| D3 | Avatar creator | Done. The bird is placeholder vector art and can be replaced. |
| D4 | Hub | Done: tap to move, view radius, 250 cap, idle fade/kick, spawn in plaza |
| D5 | Preset chat and emotes | Done: 25 phrases, 6 emotes, 1 per 2 s enforced by the server, mute check, phrase log |
| D6 | Gate Dash | Done: practice, 60 s server-timed run, replay validation, personal best, 3-gate levels with locked gates |
| D7 | Ravens and Robins | Done: queue, practice bots, 3 rotating rounds, server timers, information rules, disconnect → bot, calibration |
| D8 | Leaderboard | Done: Top 10 plus own rank, on the hub board and in the menu. Admin removal comes with D11. |
| D9 | Learning cards | Done for the avatar and Gate Dash. The Ravens and Robins card text is ready for when the game exists. |
| D10 | Resilience | Partly done: jittered reconnect and `/health`. Not yet: status file banner, Discord webhook alerts. |
| D15 | Hall of Pioneers | Done: 14 cards from a content file, detail view, "Find it in Q-Gala" tags. Stories still to be written by the organizers. |
| D11–D14 | Admin, backups, accessibility pass, runbook | Not started |
| — | Hosting moved from Oracle to Cloudflare (Worker + Durable Object); avatar redrawn from the organisers' outline | Done; full match tested on `wrangler dev` |
