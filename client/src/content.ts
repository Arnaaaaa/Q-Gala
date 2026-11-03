// Player-facing text for the hub. Edit freely; no game logic lives here.
import type { LandmarkId } from '../../shared/map.ts';

export const INFO_BOARD = {
  title: 'Info board',
  sections: [
    {
      heading: 'How to play',
      lines: [
        'Tap anywhere to walk. Tap a building to visit it.',
        'Your bird’s colours show its odds of being measured as 0 (indigo) or 1 (violet).',
        'Games open at the Flight Deck. Scores reach the Top Flock board.',
      ],
    },
    {
      heading: 'Code of conduct',
      lines: [
        'Be kind and welcoming, especially to people new to quantum.',
        'Moderators can mute or remove players who spoil the fun for others.',
      ],
    },
  ],
};

export const LANDMARK_SOON: Record<LandmarkId, string> = {
  flightDeck: 'Gate Dash and Ravens and Robins will take off from here soon.',
  hall: '',
  leaderboard: 'The Top Flock leaderboard opens soon.',
  info: '',
};
