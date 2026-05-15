/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#2C3E50',
          50: '#ECF0F2',
          100: '#D5DCE0',
          500: '#2C3E50',
          700: '#1C2A38',
        },
        accent: {
          DEFAULT: '#F39C12',
          500: '#F39C12',
        },
      },
      borderRadius: {
        DEFAULT: '8px',
        card: '12px',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['SF Mono', 'JetBrains Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
