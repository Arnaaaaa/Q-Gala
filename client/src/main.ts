import './style.css';
import type { KickCode, Profile, ServerMsg } from '../../shared/protocol.ts';
import { suggestName } from '../../shared/names.ts';
import { cardView, getCard } from './cards.ts';
import { h, mount, screen } from './dom.ts';
import { HubView } from './hub.ts';
import { Net } from './net.ts';
import { applyPrefs, store } from './prefs.ts';
import { birdScreen, confirmScreen, eggScreen, loginErrorScreen, landingScreen, messageScreen, nameScreen } from './screens.ts';

const API = ((import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:8080').replace(/\/$/, '');
const WS_URL = API.replace(/^http/, 'ws') + '/ws';
const LOGIN_URL = `${API}/auth/discord/start`;
const TOKEN_KEY = 'qg.token';
const SUGGEST_KEY = 'qg.suggest';

type PublicCfg = { inviteUrl: string | null; devLogin: boolean };

let net: Net | null = null;
let hub: HubView | null = null;
let profile: Profile = { name: null, p0: null };
let publicCfg: PublicCfg | null = null;
const overlay = document.getElementById('overlay')!;

async function getPublicCfg(): Promise<PublicCfg> {
  if (publicCfg) return publicCfg;
  try {
    const res = await fetch(`${API}/api/public`);
    publicCfg = (await res.json()) as PublicCfg;
  } catch {
    return { inviteUrl: null, devLogin: false };
  }
  return publicCfg;
}

async function boot(): Promise<void> {
  applyPrefs();
  const hash = new URLSearchParams(location.hash.slice(1));
  // Never leave login tickets or error codes in the address bar.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  const ticket = hash.get('ticket');
  const error = hash.get('error');
  if (error) return showLoginError(error);
  if (ticket) {
    try {
      const res = await fetch(`${API}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
      });
      if (!res.ok) return showLoginError('expired');
      const { token, suggestedName } = (await res.json()) as { token: string; suggestedName: string };
      store.set(TOKEN_KEY, token);
      store.set(SUGGEST_KEY, suggestName(suggestedName));
    } catch {
      return showLoginError('network');
    }
  }
  if (store.get(TOKEN_KEY)) startSession();
  else showLanding();
}

async function showLanding(): Promise<void> {
  mount(messageScreen('Q-Gala', 'Loading…'));
  const cfg = await getPublicCfg();
  mount(
    landingScreen({
      loginUrl: LOGIN_URL,
      devLogin: cfg.devLogin,
      onDevLogin: (name) => location.assign(`${API}/auth/dev?name=${encodeURIComponent(name)}`),
    }),
  );
}

async function showLoginError(code: string): Promise<void> {
  const cfg = code === 'not_member' ? await getPublicCfg() : null;
  mount(loginErrorScreen(code, LOGIN_URL, cfg?.inviteUrl ?? null));
}

function startSession(): void {
  mount(messageScreen('Q-Gala', 'Connecting to the Aviary…'));
  net = new Net(WS_URL, store.get(TOKEN_KEY)!);
  net.onStatus = (s) => {
    overlay.hidden = s !== 'reconnecting';
    overlay.replaceChildren(
      h('div', { class: 'card', role: 'status' }, h('h2', {}, 'Reconnecting…'), h('p', {}, 'Hold tight. Your name, bird and scores are saved.')),
    );
  };
  net.onKicked = onKicked;
  net.on(onMessage);
  net.connect();
}

function onMessage(m: ServerMsg): void {
  if (m.t === 'welcome') {
    profile = m.profile;
    // After a reconnect, drop straight back into the hub.
    if (hub) net!.send({ t: 'joinHub' });
    else route();
    return;
  }
  if (m.t === 'hubState' && !hub) enterHub();
  hub?.handle(m);
}

/** Sends a first-time player through egg → name → bird → confirm, or a returning one to the hub. */
function route(): void {
  if (!profile.name) return mount(eggScreen(showName));
  if (profile.p0 === null) return showBird(50);
  net!.send({ t: 'joinHub' });
}

function showName(): void {
  mount(
    nameScreen(store.get(SUGGEST_KEY) ?? '', async (name) => {
      net!.send({ t: 'claimName', name });
      try {
        const r = await net!.waitFor('nameResult');
        if (!r.ok) return r.reason;
        profile.name = r.name;
        showBird(50);
        return null;
      } catch {
        return 'No answer from the server. Please try again.';
      }
    }),
  );
}

function showBird(p0: number): void {
  mount(birdScreen({ p0, submitLabel: 'Next', onSubmit: showConfirm }));
}

function showConfirm(p0: number): void {
  mount(
    confirmScreen({
      name: profile.name!,
      p0,
      onBack: () => showBird(p0),
      onEnter: async () => {
        net!.send({ t: 'setBird', p0 });
        try {
          const r = await net!.waitFor('birdResult');
          if (!r.ok) return r.reason;
          profile.p0 = r.p0;
          await showAvatarCard();
          return null;
        } catch {
          return 'No answer from the server. Please try again.';
        }
      },
    }),
  );
}

async function showAvatarCard(): Promise<void> {
  const card = await getCard('avatar');
  if (!card) return net!.send({ t: 'joinHub' });
  mount(screen(cardView(card), h('button', { class: 'btn primary', onclick: () => net!.send({ t: 'joinHub' }) }, 'Enter the Aviary')));
}

// Must stay synchronous: the hubState message that triggers it is handed to the hub right after.
function enterHub(): void {
  hub = new HubView(net!, { isAdmin: () => profile.admin === true, inviteUrl: () => publicCfg?.inviteUrl ?? null, onMyBird: editBird, onSignOut: signOut });
  mount(hub.root);
  hub.start();
  void getPublicCfg();
}

function editBird(): void {
  const view = hub!;
  const editor = birdScreen({
    p0: profile.p0 ?? 50,
    submitLabel: 'Save',
    onCancel: () => view.closePanel(),
    onSubmit: async (p0) => {
      net!.send({ t: 'setBird', p0 });
      try {
        const r = await net!.waitFor('birdResult');
        if (r.ok) {
          profile.p0 = r.p0;
          view.closePanel();
        } else {
          const secs = r.retryInMs ? ` Try again in ${Math.ceil(r.retryInMs / 1000)} s.` : '';
          editor.querySelector('.caption')!.textContent = r.reason + secs;
        }
      } catch {
        editor.querySelector('.caption')!.textContent = 'No answer from the server. Please try again.';
      }
    },
  });
  view.showDialog(editor);
}

function leaveSession(): void {
  net?.stop();
  net = null;
  hub?.destroy();
  hub = null;
  overlay.hidden = true;
}

function signOut(): void {
  leaveSession();
  store.del(TOKEN_KEY);
  showLanding();
}

const KICK_TEXT: Record<KickCode, [string, string, string]> = {
  replaced: ['Playing somewhere else?', 'You opened Q-Gala in another tab or device, so this one was disconnected.', 'Play here instead'],
  idle: ['Your bird flew home', 'You were idle for a while, so we disconnected you to make room.', 'Come back'],
  full: ['The Aviary is full', 'The Aviary is full, try again in a minute.', 'Try again'],
  kicked: ['Disconnected', 'A moderator disconnected you.', 'Reconnect'],
  banned: ["You can't join Q-Gala", 'This account has been removed from the game.', ''],
  auth: ['Please sign in again', 'Your session has ended.', 'Sign in'],
};

function onKicked(code: KickCode): void {
  leaveSession();
  if (code === 'auth') {
    store.del(TOKEN_KEY);
    return void showLanding();
  }
  const [title, text, label] = KICK_TEXT[code];
  mount(messageScreen(title, text, label ? { label, run: startSession } : undefined));
}

boot();
