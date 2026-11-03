import { cleanName, nameFormatError } from '../../shared/names.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { createBirdSvg, createEggSvg } from './bird.ts';
import { h, screen } from './dom.ts';

export const oddsText = (p0: number) => `Right now: ${p0}% chance of 0, ${100 - p0}% chance of 1.`;

export function landingScreen(o: { loginUrl: string; devLogin: boolean; onDevLogin: (name: string) => void }): HTMLElement {
  const devName = h('input', { type: 'text', maxlength: 24, placeholder: 'Test name', 'aria-label': 'Dev login name' });
  return screen(
    h('h1', { class: 'title' }, 'Q-Gala'),
    h('p', { class: 'lead' }, 'A quantum aviary for Qiskit Fall Fest. Hatch a bird, explore, and play.'),
    h('a', { class: 'btn primary', href: o.loginUrl }, 'Continue with Discord'),
    h('p', { class: 'small' }, 'We store only your Discord ID, game name, bird and scores, and delete them within 14 days after the event.'),
    o.devLogin &&
      h('form', { class: 'dev', onsubmit: (e: Event) => (e.preventDefault(), o.onDevLogin(devName.value)) },
        h('p', { class: 'small' }, 'Development login (disabled in production)'),
        devName,
        h('button', { class: 'btn', type: 'submit' }, 'Dev login'),
      ),
  );
}

const LOGIN_ERRORS: Record<string, [string, string]> = {
  denied: ['Login cancelled', 'Discord sign-in was cancelled. You can try again whenever you like.'],
  expired: ['That took a while', 'The sign-in link expired. Please try again.'],
  discord_down: ["Discord isn't answering", 'We could not reach Discord just now. Please try again in a moment.'],
  network: ['Connection problem', 'We could not reach the Q-Gala server. Check your connection and try again.'],
  banned: ["You can't join Q-Gala", 'This account has been removed from the game. Contact an organizer in Discord if you think this is a mistake.'],
  missing_role: ['Almost there', 'You need the event role in the Discord server first. Ask an organizer, then try again.'],
};

export function loginErrorScreen(code: string, loginUrl: string, inviteUrl: string | null): HTMLElement {
  if (code === 'not_member') {
    return screen(
      h('h2', {}, 'Join the Fall Fest Discord first'),
      h('p', {}, 'Q-Gala is for members of the event Discord server. Join it, then come back here.'),
      inviteUrl && h('a', { class: 'btn primary', href: inviteUrl, target: '_blank', rel: 'noopener' }, 'Open the Discord invite'),
      h('a', { class: 'btn', href: loginUrl }, "I've joined, try again"),
    );
  }
  const [title, text] = LOGIN_ERRORS[code] ?? LOGIN_ERRORS.network;
  return screen(h('h2', {}, title), h('p', {}, text), code !== 'banned' && h('a', { class: 'btn primary', href: loginUrl }, 'Try again'));
}

export function messageScreen(title: string, text: string, action?: { label: string; run: () => void }): HTMLElement {
  return screen(h('h2', {}, title), h('p', {}, text), action && h('button', { class: 'btn primary', onclick: action.run }, action.label));
}

export function eggScreen(onHatch: () => void): HTMLElement {
  return screen(
    h('div', { class: 'stage' }, createEggSvg()),
    h('p', { class: 'lead' }, "Your bird hasn't hatched yet. It could be anything."),
    h('button', { class: 'btn primary', onclick: onHatch }, 'Hatch my bird'),
  );
}

/** `claim` resolves with an error message, or null on success. */
export function nameScreen(suggested: string, claim: (name: string) => Promise<string | null>): HTMLElement {
  const input = h('input', {
    type: 'text', value: suggested, minlength: TUNABLES.name.min, maxlength: TUNABLES.name.max,
    autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', id: 'name-input', 'aria-describedby': 'name-msg',
  });
  const msg = h('p', { class: 'msg', id: 'name-msg', 'aria-live': 'polite' }, `${TUNABLES.name.min} to ${TUNABLES.name.max} characters: letters, digits, spaces, _ or -. You can't change it later.`);
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'This is my name');
  const form = h('form', {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const name = cleanName(input.value);
      const err = nameFormatError(name);
      if (err) return void (msg.textContent = err, msg.classList.add('bad'));
      btn.disabled = true;
      msg.textContent = 'Checking…';
      msg.classList.remove('bad');
      const reason = await claim(name);
      btn.disabled = false;
      if (reason) {
        msg.textContent = reason;
        msg.classList.add('bad');
        input.focus();
      }
    },
  }, h('label', { for: 'name-input' }, 'Name your bird'), input, msg, btn);
  return screen(h('h2', {}, 'What should we call you?'), form);
}

/**
 * The bird creator. In `edit` mode (from the hub menu) it saves directly;
 * otherwise "Next" leads to the confirm screen.
 */
export function birdScreen(o: { p0: number; submitLabel: string; onSubmit: (p0: number) => void; onCancel?: () => void }): HTMLElement {
  let p0 = o.p0;
  let measuring = 0;
  const bird = createBirdSvg('Your bird');
  const readout = h('p', { class: 'readout', 'aria-live': 'polite' });
  const caption = h('p', { class: 'caption', 'aria-live': 'polite' });
  const slider = h('input', { type: 'range', min: 0, max: 100, step: TUNABLES.p0Step, value: p0, 'aria-label': 'Chance of 0, in percent' });

  const render = () => {
    bird.set({ p0 });
    slider.value = String(p0);
    slider.setAttribute('aria-valuetext', `${p0}% chance of 0`);
    readout.textContent = oddsText(p0);
  };
  const setP0 = (v: number) => {
    p0 = v;
    caption.textContent = '';
    render();
  };
  slider.addEventListener('input', () => setP0(Number(slider.value)));

  const measure = () => {
    // Cosmetic only, so the browser may roll the dice here.
    const outcome = Math.random() * 100 < p0 ? 0 : 1;
    bird.set({ p0, solid: outcome });
    caption.textContent = `Measured: ${outcome} (${outcome === 0 ? 'indigo' : 'violet'}). That was a measurement. The gradient shows the odds, not a blend.`;
    clearTimeout(measuring);
    measuring = window.setTimeout(() => bird.set({ p0 }), 1000);
  };

  render();
  return screen(
    h('h2', {}, 'Shape your bird'),
    h('div', { class: 'stage' }, bird.el),
    readout,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => setP0(100) }, 'Always 0'),
      h('button', { class: 'btn', onclick: () => setP0(50) }, 'Both'),
      h('button', { class: 'btn', onclick: () => setP0(0) }, 'Always 1'),
    ),
    h('div', { class: 'slider-row' }, h('span', { 'aria-hidden': 'true' }, '0'), slider, h('span', { 'aria-hidden': 'true' }, '1')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => setP0(Math.round(Math.random() * 20) * 5) }, 'Surprise me'),
      h('button', { class: 'btn', onclick: measure }, 'Measure me'),
    ),
    caption,
    h('div', { class: 'row' },
      o.onCancel && h('button', { class: 'btn', onclick: o.onCancel }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => o.onSubmit(p0) }, o.submitLabel),
    ),
  );
}

export function confirmScreen(o: { name: string; p0: number; onBack: () => void; onEnter: () => Promise<string | null> }): HTMLElement {
  const bird = createBirdSvg(`${o.name}'s bird`);
  bird.set({ p0: o.p0 });
  const msg = h('p', { class: 'msg', 'aria-live': 'polite' });
  const enter = h('button', {
    class: 'btn primary',
    onclick: async () => {
      enter.disabled = true;
      const err = await o.onEnter();
      enter.disabled = false;
      msg.textContent = err ?? '';
    },
  }, 'Enter the Aviary');
  return screen(
    h('h2', {}, 'Ready to fly?'),
    h('div', { class: 'stage' }, bird.el),
    h('p', { class: 'name-tag' }, o.name),
    h('p', { class: 'readout' }, oddsText(o.p0)),
    msg,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: o.onBack }, 'Back'), enter),
  );
}
