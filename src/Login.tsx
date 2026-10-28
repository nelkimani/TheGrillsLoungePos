import { useState } from 'react'
import { supabase, TERMINAL_CODE } from './supabase'
import { AlphaKeys, Btn, Keypad } from './ui'

// Terminals: staff ID + 6-digit PIN on a big keypad. Office: email + password (MFA to be added).
export default function Login() {
  const isOffice = TERMINAL_CODE === 'OFFICE'
  return isOffice ? <OfficeLogin /> : <PinLogin />
}

function PinLogin() {
  const [staffNo, setStaffNo] = useState('')
  const [pin, setPin] = useState('')
  const [field, setField] = useState<'id' | 'pin'>('id')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const digit = (d: string) => {
    setErr('')
    if (field === 'id') setStaffNo(s => (s + d).slice(0, 20))
    else setPin(p => (p + d).slice(0, 6))
  }
  const back = () => field === 'id' ? setStaffNo(s => s.slice(0, -1)) : setPin(p => p.slice(0, -1))
  const clear = () => field === 'id' ? setStaffNo('') : setPin('')

  const submit = async () => {
    if (busy) return
    setBusy(true); setErr('')
    const { data, error } = await supabase.functions.invoke('pin-login', {
      body: { staff_no: staffNo, pin, terminal: TERMINAL_CODE } })
    if (error || !data?.token_hash) {
      let msg = 'Invalid staff ID or PIN'
      try { const b = await (error as any)?.context?.json?.(); if (b?.error) msg = b.error } catch { /* keep default */ }
      setErr(msg); setPin(''); setBusy(false); return
    }
    const { error: verr } = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' })
    if (verr) setErr('Could not sign in. Try again.')
    setBusy(false)
  }

  const box = (active: boolean) =>
    `h-btn flex items-center px-4 rounded-xl text-3xl tracking-widest border-2 ${active ? 'border-amber-500 bg-slate-800' : 'border-slate-700 bg-slate-800/60'}`
  return (
    <div className="flex flex-col items-center gap-6 pt-10">
      <h1 className="text-3xl font-bold">Sign in</h1>
      <div className="flex items-start gap-6">
        <div className="flex w-[min(18rem,30vw)] flex-col gap-4">
          <button className={box(field === 'id')} onClick={() => setField('id')}>
            {staffNo || <span className="text-slate-500 text-xl">Staff ID</span>}
          </button>
          <button className={box(field === 'pin')} onClick={() => setField('pin')}>
            {pin ? '●'.repeat(pin.length) : <span className="text-slate-500 text-xl">6-digit PIN</span>}
          </button>
          {err && <div className="rounded-lg bg-red-700 p-3 text-lg font-semibold">{err}</div>}
          <Btn onClick={field === 'id' ? () => setField('pin') : submit}
               disabled={busy || (field === 'id' ? !staffNo : pin.length !== 6)}>
            {busy ? 'Signing in…' : field === 'id' ? 'Next' : 'Sign in'}
          </Btn>
        </div>
        {field === 'id'
          ? <AlphaKeys onKey={digit} onBack={back} onClear={clear} />
          : <Keypad onDigit={digit} onBack={back} onClear={clear} />}
      </div>
      <p className="text-slate-400 text-base">Staff ID is the letters/numbers your manager gave you (e.g. W001).</p>
    </div>
  )
}

function OfficeLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setErr('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setErr('Wrong email or password')
    setBusy(false)
  }
  const input = 'h-14 rounded-xl bg-slate-800 border-2 border-slate-700 px-4 text-xl w-full'
  return (
    <form onSubmit={submit} className="mx-auto mt-16 flex w-96 flex-col gap-4">
      <h1 className="text-3xl font-bold">Office sign in</h1>
      <input className={input} type="email" placeholder="Email" autoComplete="username"
             value={email} onChange={e => setEmail(e.target.value)} />
      <input className={input} type="password" placeholder="Password" autoComplete="current-password"
             value={password} onChange={e => setPassword(e.target.value)} />
      {err && <div className="rounded-lg bg-red-700 p-3 font-semibold">{err}</div>}
      <button type="submit" disabled={busy || !email || !password}
              className="h-btn rounded-xl bg-amber-500 text-xl font-semibold text-on-accent disabled:opacity-40">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
