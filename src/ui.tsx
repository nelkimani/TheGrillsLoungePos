import { ReactNode, useEffect, useState } from 'react'
import { useTheme } from './device'

// Touch design tokens from UI_UX_ADDENDUM §3. Button height comes from --btn-h (index.css):
// 64-80px on the touch terminals, ~44px on the office computer and laptop.
export const Btn = ({ children, onClick, disabled, kind = 'primary', className = '' }:
  { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'ghost' | 'danger'; className?: string }) => {
  const colour = kind === 'primary' ? 'bg-amber-500 text-on-accent active:bg-amber-400'
    : kind === 'danger' ? 'bg-red-600 text-white active:bg-red-500'
    : 'bg-slate-700 text-slate-100 active:bg-slate-600'
  return (
    <button onClick={onClick} disabled={disabled}
      className={`h-btn px-6 rounded-xl text-xl font-semibold disabled:opacity-40 ${colour} ${className}`}>
      {children}
    </button>
  )
}

const Sun = () => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)
const Moon = () => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)

export function TopBar({ terminal, who, onSignOut, unsent = 0 }: { terminal: string; who?: string; onSignOut?: () => void; unsent?: number }) {
  const [now, setNow] = useState(new Date())
  const [online, setOnline] = useState(navigator.onLine)
  const [theme, toggleTheme] = useTheme()
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { clearInterval(t); window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  const control = 'h-[calc(var(--topbar-h)-1rem)] shrink-0 rounded-lg bg-slate-600 font-semibold'
  return (
    <div className="flex h-topbar items-center gap-3 bg-slate-800 px-4 text-lg">
      <span className="shrink-0 font-semibold">{terminal}</span>
      <span className="min-w-0 truncate text-slate-300">{who ?? 'Locked'}</span>
      <span className="flex-1" />
      {unsent > 0 && <span className="shrink-0 whitespace-nowrap rounded bg-red-700 px-3 py-1 font-semibold">NOT SENT: {unsent}</span>}
      <span className={`shrink-0 whitespace-nowrap rounded px-3 py-1 font-semibold ${online ? 'bg-green-700' : 'bg-red-700'}`}>
        {online ? '● Online' : '● OFFLINE – nothing is being sent'}
      </span>
      <span className="shrink-0 tabular-nums">{now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</span>
      <button onClick={toggleTheme} className={`${control} flex aspect-square items-center justify-center`}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
        {theme === 'dark' ? <Sun /> : <Moon />}
      </button>
      {onSignOut && <button onClick={onSignOut} className={`${control} px-4`}>Switch user</button>}
    </div>
  )
}

// On-screen letters + digits for staff IDs like W001 (the Windows/Mac keyboard is not relied on)
export function AlphaKeys({ onKey, onBack, onClear, withSpace }: { onKey: (k: string) => void; onBack: () => void; onClear: () => void; withSpace?: boolean }) {
  const key = 'h-[3.75rem] min-w-0 flex-1 rounded-xl bg-slate-700 text-2xl font-semibold active:bg-slate-500'
  const rows = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']
  return (
    <div className="flex w-[40rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {rows.map((r, i) => (
        <div key={r} className="flex gap-2" style={{ paddingLeft: `${i * 1.1}rem`, paddingRight: `${i * 1.1}rem` }}>
          {r.split('').map(k => <button key={k} className={key} onClick={() => onKey(k)}>{k}</button>)}
        </div>
      ))}
      <div className="flex gap-2">
        <button className={key + ' text-lg'} onClick={onClear}>Clear</button>
        {withSpace && <button className={key + ' text-lg flex-[3]'} onClick={() => onKey(' ')}>Space</button>}
        <button className={key + ' text-lg'} onClick={onBack}>⌫ Delete</button>
      </div>
    </div>
  )
}

export function Keypad({ onDigit, onBack, onClear }: { onDigit: (d: string) => void; onBack: () => void; onClear: () => void }) {
  const key = 'h-[4.5rem] w-[4.5rem] rounded-xl bg-slate-700 text-3xl font-semibold active:bg-slate-500'
  return (
    <div className="grid grid-cols-3 gap-3 w-fit">
      {['1','2','3','4','5','6','7','8','9'].map(d => <button key={d} className={key} onClick={() => onDigit(d)}>{d}</button>)}
      <button className={key + ' text-lg'} onClick={onClear}>Clear</button>
      <button className={key} onClick={() => onDigit('0')}>0</button>
      <button className={key + ' text-lg'} onClick={onBack}>⌫</button>
    </div>
  )
}
