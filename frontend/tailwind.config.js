/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          gold:        '#06b6d4',
          'gold-light':'#22d3ee',
          'gold-dark': '#0891b2',
          'gold-glow': 'rgba(6,182,212,0.15)',
          navy:        '#061019',
          'navy-mid':  '#0a1a26',
          'navy-card': '#0e2230',
          'navy-border':'#173447',
          'navy-hover':'#132b3b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'gold': '0 0 20px rgba(6,182,212,0.25)',
        'gold-sm': '0 0 10px rgba(6,182,212,0.15)',
        'card': '0 4px 24px rgba(0,0,0,0.4)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #061019 0%, #0a1a26 50%, #081521 100%)',
        'gold-gradient':  'linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%)',
        'gold-subtle':    'linear-gradient(135deg, rgba(6,182,212,0.12) 0%, rgba(6,182,212,0.04) 100%)',
      },
    },
  },
  plugins: [],
}
