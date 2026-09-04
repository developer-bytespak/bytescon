/** @type {import('tailwindcss').Config} */

// =============================================================
// Bytescon app theme — "Obsidian".
//
// The app's pages lean on Tailwind's gray / slate / blue / cyan / yellow
// utilities thousands of times. Rather than edit every page, the scales
// are remapped here so the whole product shares one palette:
//   gray, slate  → warm obsidian neutrals (surfaces + text)
//   blue, cyan, sky → ultramarine, the single interactive accent
//   yellow       → the same warm amber used for warnings
// Semantic families (red, emerald, green, amber, orange, purple, violet)
// keep their Tailwind defaults.
// =============================================================

// Warm neutral scale. 950 is the app background; 100 is body text.
const neutral = {
  50:  '#f5f2ec',
  100: '#ece8df',
  200: '#d3cfd6',
  300: '#b3aebb',
  400: '#8f8a99',
  500: '#7d7889',
  600: '#5a5666',
  700: '#2b2933',
  800: '#1a1a20',
  900: '#131318',
  950: '#0b0b0f',
}

// Ultramarine accent scale.
const accent = {
  50:  '#eef1ff',
  100: '#dfe4ff',
  200: '#c3ccff',
  300: '#a3b1ff',
  400: '#7b8fff',
  500: '#5b74ff',
  600: '#4258f0',
  700: '#3446c4',
  800: '#2a389a',
  900: '#222d74',
  950: '#141a45',
}

// Champagne gold — the emphasis colour (scores, pins, warnings). Shared by
// the amber and yellow utilities so pages that used either now agree.
const amber = {
  50:  '#fbf6ea',
  100: '#f6ecd0',
  200: '#f0d493',
  300: '#eac97a',
  400: '#e2b660',
  500: '#d3a54a',
  600: '#b8892f',
  700: '#8f6a24',
  800: '#6b4f1d',
  900: '#4d3916',
  950: '#2d200b',
}

module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        gray: neutral,
        slate: neutral,
        blue: accent,
        cyan: accent,
        sky: accent,
        yellow: amber,
        amber,
        gold: {
          300: '#f0d493',
          400: '#e2b660',
          500: '#d3a54a',
        },
        // Legacy brand keys used by a handful of components.
        brand: {
          gold:        '#5b74ff',
          'gold-light':'#7b8fff',
          'gold-dark': '#4258f0',
          'gold-glow': 'rgba(91,116,255,0.15)',
          navy:        '#0b0b0f',
          'navy-mid':  '#131318',
          'navy-card': '#1a1a20',
          'navy-border':'#2b2933',
          'navy-hover':'#1f1f26',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
      },
      boxShadow: {
        'gold': '0 0 0 1px rgba(91,116,255,0.35)',
        'gold-sm': '0 0 0 1px rgba(91,116,255,0.2)',
        'card': '0 1px 0 rgba(255,255,255,0.03) inset',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(180deg, #0b0b0f 0%, #131318 100%)',
        'gold-gradient':  'linear-gradient(135deg, #5b74ff 0%, #7b8fff 100%)',
        'gold-subtle':    'linear-gradient(135deg, rgba(91,116,255,0.12) 0%, rgba(91,116,255,0.04) 100%)',
      },
    },
  },
  plugins: [],
}
