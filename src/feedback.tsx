import { useEffect, useState } from 'react'
import { Btn, Keypad } from './ui'

// In-app replacements for window.confirm / window.prompt, plus toasts.
// Native browser dialogs are small, ignore the theme, and are hard to hit on a touch monitor.
//   toast('Saved')                                 toast('Could not save', 'error')
//   if (await confirmDialog({ title, message })) ...
//   const pin = await promptDialog({ title, digits: 6 })   // null when cancelled

type ToastKind = 'ok' | 'error' | 'info'
type ToastItem = { id: number; kind: ToastKind; text: string }
type ConfirmOpts = { title: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean }
type PromptOpts = { title: string; message?: string; digits?: number; confirmText?: string }
type DialogState =
  | ({ type: 'confirm'; resolve: (v: boolean) => void } & ConfirmOpts)
  | ({ type: 'prompt'; resolve: (v: string | null) => void } & PromptOpts)

let nextId = 1
let toasts: ToastItem[] = []
let dialog: DialogState | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())

export function toast(text: string, kind: ToastKind = 'ok') {
  const id = nextId++
  toasts = [...toasts, { id, kind, text }].slice(-4)
  emit()
  setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4000)
}
const dismiss = (id: number) => { toasts = toasts.filter(t => t.id !== id); emit() }

export const confirmDialog = (o: ConfirmOpts) =>
  new Promise<boolean>(resolve => { dialog = { type: 'confirm', resolve, ...o }; emit() })
export const promptDialog = (o: PromptOpts) =>
  new Promise<string | null>(resolve => { dialog = { type: 'prompt', resolve, ...o }; emit() })

export function FeedbackHost() {
  const [, force] = useState(0)
  useEffect(() => { const f = () => force(x => x + 1); subs.add(f); return () => { subs.delete(f) } }, [])
  const tone: Record<ToastKind, string> = { ok: 'bg-green-700', error: 'bg-red-700', info: 'bg-slate-600' }
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
        {toasts.map(t => (
          <button key={t.id} onClick={() => dismiss(t.id)}
            className={`pointer-events-auto max-w-[min(36rem,94vw)] rounded-xl px-5 py-3 text-left text-lg font-semibold shadow-lg ${tone[t.kind]}`}>
            {t.text}
          </button>
        ))}
      </div>
      {dialog?.type === 'confirm' && <ConfirmView d={dialog} />}
      {dialog?.type === 'prompt' && <PromptView d={dialog} />}
    </>
  )
}

const close = () => { dialog = null; emit() }
const Shell = ({ title, message, children, onEscape }: { title: string; message?: string; children: React.ReactNode; onEscape: () => void }) => {
  // Drop focus from whatever opened the dialog, so a later Enter/Space can't re-press that button.
  useEffect(() => { (document.activeElement as HTMLElement | null)?.blur?.() }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onEscape() }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [onEscape])
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex w-[min(34rem,94vw)] flex-col gap-4 rounded-2xl bg-slate-800 p-6">
        <h2 className="text-2xl font-bold">{title}</h2>
        {message && <p className="text-lg text-slate-300">{message}</p>}
        {children}
      </div>
    </div>
  )
}

function ConfirmView({ d }: { d: Extract<DialogState, { type: 'confirm' }> }) {
  const answer = (v: boolean) => { close(); d.resolve(v) }
  return (
    <Shell title={d.title} message={d.message} onEscape={() => answer(false)}>
      <div className="flex gap-3">
        <Btn kind="ghost" className="flex-1" onClick={() => answer(false)}>{d.cancelText ?? 'Cancel'}</Btn>
        <Btn kind={d.danger ? 'danger' : 'primary'} className="flex-1" onClick={() => answer(true)}>{d.confirmText ?? 'OK'}</Btn>
      </div>
    </Shell>
  )
}

// Digits only, on an on-screen keypad (works with no keyboard); a physical keyboard also works.
function PromptView({ d }: { d: Extract<DialogState, { type: 'prompt' }> }) {
  const [v, setV] = useState('')
  const max = d.digits ?? 12
  const done = (r: string | null) => { close(); d.resolve(r) }
  const ready = d.digits ? v.length === d.digits : v.length > 0
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setV(s => (s + e.key).slice(0, max))
      else if (e.key === 'Backspace') setV(s => s.slice(0, -1))
      else if (e.key === 'Enter') { e.preventDefault(); if (ready) done(v) }
    }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  })
  return (
    <Shell title={d.title} message={d.message} onEscape={() => done(null)}>
      <div className="flex h-btn items-center rounded-xl border-2 border-amber-500 bg-slate-900 px-4 text-3xl font-bold tracking-widest">
        {v ? '●'.repeat(v.length) : <span className="text-xl font-normal tracking-normal text-slate-500">{d.digits ? `${d.digits} digits` : 'Enter a number'}</span>}
      </div>
      <div className="flex justify-center"><Keypad onDigit={x => setV(s => (s + x).slice(0, max))} onBack={() => setV(s => s.slice(0, -1))} onClear={() => setV('')} /></div>
      <div className="flex gap-3">
        <Btn kind="ghost" className="flex-1" onClick={() => done(null)}>Cancel</Btn>
        <Btn className="flex-1" disabled={!ready} onClick={() => done(v)}>{d.confirmText ?? 'OK'}</Btn>
      </div>
    </Shell>
  )
}
