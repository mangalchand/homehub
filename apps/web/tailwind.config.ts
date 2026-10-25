import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans Variable"', '"Inter Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px hsl(230 30% 20% / 0.04), 0 8px 24px -6px hsl(230 30% 20% / 0.08)',
        lift: '0 2px 4px hsl(230 30% 20% / 0.05), 0 18px 40px -12px hsl(230 40% 25% / 0.18)',
        glow: '0 8px 30px -6px hsl(var(--primary) / 0.45)',
      },
      keyframes: {
        kenburns: { '0%': { transform: 'scale(1) translate(0,0)' }, '100%': { transform: 'scale(1.12) translate(-2%, -2%)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        wiggle: { '0%,100%': { transform: 'rotate(0)' }, '25%': { transform: 'rotate(-12deg)' }, '75%': { transform: 'rotate(12deg)' } },
      },
      animation: { kenburns: 'kenburns 14s ease-out forwards', 'fade-in': 'fade-in 1.2s ease-out' },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
    },
  },
  plugins: [animate],
} satisfies Config;
