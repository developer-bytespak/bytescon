/** @type {import('tailwindcss').Config} */

// =============================================================
// Bytescon app theme — "Obsidian", light and dark.
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

// Every scale below resolves through a CSS variable (defined in
// src/index.css) so the palette follows the operating system's light /
// dark setting. Light mode runs the scales inverted — 950 is the app
// background, 900 the card surface, 100 body text — so the pages, written
// against a dark ground, need no edits. Dark mode uses the original values.
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const scale = (name) =>
  Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`]))

module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        gray: scale('neutral'),
        slate: scale('neutral'),
        zinc: scale('neutral'),
        neutral: scale('neutral'),
        stone: scale('neutral'),
        blue: scale('accent'),
        cyan: scale('accent'),
        sky: scale('accent'),
        yellow: scale('amber'),
        amber: scale('amber'),
        red: scale('red'),
        rose: scale('rose'),
        pink: scale('pink'),
        orange: scale('orange'),
        green: scale('green'),
        emerald: scale('emerald'),
        teal: scale('teal'),
        lime: scale('lime'),
        purple: scale('purple'),
        violet: scale('violet'),
        indigo: scale('indigo'),
        fuchsia: scale('fuchsia'),
        // Translucent hover / hairline tint: white on dark, ink on light.
        ink: 'rgb(var(--ink) / <alpha-value>)',
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
