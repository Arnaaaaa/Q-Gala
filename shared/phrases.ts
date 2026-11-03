// Preset chat (spec §7). Players send an index, never text. Append new phrases at the end
// so logged phrase IDs keep their meaning.
export const PHRASE_GROUPS: { label: string; phrases: string[] }[] = [
  { label: 'Greetings', phrases: ['Hello!', "Hi, I'm new here", 'Good morning!', 'See you later!'] },
  {
    label: 'Social',
    phrases: ['Want to team up?', 'Can you help me?', 'Thank you!', 'Nice bird!', 'Good luck!', 'Good game!', "Let's play!", 'Wait for me', 'Ready!', 'One more round?'],
  },
  { label: 'Quantum fun', phrases: ['Are you a 0 or a 1?', "I'm in superposition", 'Time to collapse!', "I'm entangled with you", 'Quantum is cool!'] },
  { label: 'Reactions', phrases: ['Wow!', 'Haha', 'Oops!', 'That was close!', 'Which game should we try?', 'Where is the Flight Deck?'] },
];

export const PHRASES: string[] = PHRASE_GROUPS.flatMap((g) => g.phrases);

export const EMOTES = ['wave', 'clap', 'heart', 'flap', 'collapse', 'superpose'] as const;
export type Emote = (typeof EMOTES)[number];
