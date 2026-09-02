import type { Config } from 'tailwindcss';

/**
 * Signara design tokens — see README "UI design":
 *   Primary #0F62FE  Secondary #111827  Accent #14B8A6
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#EDF3FF',
          100: '#D7E5FF',
          200: '#B3CCFF',
          300: '#84A9FF',
          400: '#5282FF',
          500: '#0F62FE',
          600: '#0B54E0',
          700: '#0A45B8',
          800: '#0A3A95',
          900: '#0B2F75',
        },
        ink: {
          50: '#F6F7F9',
          100: '#ECEEF2',
          800: '#1F2937',
          900: '#111827',
          950: '#0B1220',
        },
        accent: {
          400: '#2DD4BF',
          500: '#14B8A6',
          600: '#0D9488',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(17 24 39 / 0.06), 0 1px 2px -1px rgb(17 24 39 / 0.06)',
      },
    },
  },
  plugins: [],
};

export default config;