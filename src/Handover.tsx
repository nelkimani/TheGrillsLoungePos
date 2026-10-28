import { useRef, useState } from 'react'
import { supabase } from './supabase'
import { Btn, Keypad } from './ui'
import { isNetworkError, kes, uid } from './lib'

// Blind hand-in: the person declares the cash they are handing over without seeing what the system expects.
export default function Handover({ onDone }: { onDone: () => void }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<number | null>(null)
  const key = useRef(uid())

  const submit = async () => {
    if (busy || amount === '') return
    if (!navigator.onLine) { setErr('NO CONNECTION – not recorded. Reconnect and try again.'); return }
    setBusy(true); setErr('')
    const { error } = await supabase.rpc('declare_handover', { p_amount: Number(amount), p_notes: null, p_key: key.current })
    setBusy(false)
    if (error) { setErr(isNetworkError(error) ? 'Could not confirm. Check the connection and tap again – it will not record twice.' : error.message); return }
    setDone(Number(amount))
  }

  if (done !== null) {
    return (
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <div className="rounded-xl bg-green-700 px-8 py-4 text-4xl font-bold">Hand-in recorded: {kes(done)}</div>
        <div className="max-w-xl text-xl text-slate-300">Give the cash to the accountant. They will count it and confirm the amount.</div>
        <Btn onClick={onDone}>Done</Btn>
      </div>
    )
  }
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 p-6">
      <h2 className="text-3xl font-bold">Hand in cash</h2>
      <div className="text-lg text-slate-300">Enter the total cash you are handing over (not M-Pesa).</div>
      <div className="h-btn w-full rounded-xl border-2 border-amber-500 bg-slate-900 px-4 text-4xl font-bold leading-[var(--btn-h)]">
        {amount ? kes(Number(amount)) : <span className="text-xl font-normal text-slate-500">Amount</span>}
      </div>
      <Keypad onDigit={d => setAmount(v => (v + d).replace(/^0+(?=\d)/, '').slice(0, 7))}
              onBack={() => setAmount(v => v.slice(0, -1))} onClear={() => setAmount('')} />
      {err && <div className="w-full rounded-lg bg-red-700 p-3 font-semibold">{err}</div>}
      <div className="flex gap-3">
        <Btn kind="ghost" onClick={onDone}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || amount === ''}>{busy ? 'Saving…' : 'Confirm hand-in'}</Btn>
      </div>
    </div>
  )
}
