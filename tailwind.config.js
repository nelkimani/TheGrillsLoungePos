// Colours come from CSS variables (see src/index.css) so every existing
// `bg-slate-800`, `text-amber-400` ... class follows the dark / light theme
// without being rewritten. Variables hold "R G B" so opacity modifiers (bg-slate-900/60) still work.
const scale = (name, shades) =>
  Object.fromEntries(shades.map(s => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]))

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: scale('slate', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        amber: scale('amber', [200, 300, 400, 500, 600, 950]),
        red: scale('red', [300, 400, 500, 600, 700, 800, 950]),
        green: scale('green', [400, 600, 700, 800]),
        // Text that sits on an amber button: dark in BOTH themes.
        'on-accent': 'rgb(var(--on-accent) / <alpha-value>)',
      },
      // Size tokens change with the device (touch terminal vs office) - see index.css.
      height: { btn: 'var(--btn-h)', topbar: 'var(--topbar-h)' },
      minHeight: { btn: 'var(--btn-h)' },
    },
  },
  plugins: [],
}
