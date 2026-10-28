import { useEffect, useState } from 'react'
import { TERMINAL_CODE } from './supabase'

// "terminal" = the 15" touch monitors (touch only, no keyboard). "desktop" = office computer and accountant laptop.
// index.html applies the same rule before first paint; this module keeps React in step with it.
export const isTerminal = TERMINAL_CODE !== 'OFFICE'
export const DEVICE: 'terminal' | 'desktop' = isTerminal ? 'terminal' : 'desktop'

export type Theme = 'dark' | 'light'
const KEY = 'pos-theme'

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

export function setTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t)
  try { localStorage.setItem(KEY, t) } catch { /* private mode: theme just won't be remembered */ }
  window.dispatchEvent(new Event('pos-theme'))
}

export function useTheme(): [Theme, () => void] {
  const [theme, set] = useState<Theme>(getTheme)
  useEffect(() => {
    const sync = () => set(getTheme())
    window.addEventListener('pos-theme', sync)
    return () => window.removeEventListener('pos-theme', sync)
  }, [])
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')]
}
