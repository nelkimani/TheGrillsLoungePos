import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn } from './ui'
import { kes, uid } from './lib'

type Row = { id: string; business_date: string; category: string; amount: number; description: string; receipt_ref: string | null; recorded_by_name: string; voided: boolean; void_reason: string | null }
const input = 'h-12 rounded-lg border border-slate-500 bg-slate-900 px-3 text-lg'
const CATS = ['Transport', 'Charcoal', 'Gas', 'Cleaning', 'Repairs', 'Airtime', 'Other']
const today = () => new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 10)

export default function Expenses({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [cat, setCat] = useState('Transport')
  const [amount, setAmount] = useState('')
  const [desc, setDesc] = useState('')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(''); const [bad, setBad] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [why, setWhy] = useState('')
  const key = useRef(uid())
  const day = today()

  const load = useCallback(async () => {
    const { data } = await supabase.from('expenses_v').select('*').eq('business_date', day).order('id')
    setRows((data ?? []) as Row[])
  }, [day])
  useEffect(() => { load() }, [load])

  const save = async () => {
    if (busy) return; setBusy(true)
    const { error } = await supabase.rpc('record_expense', { p_category: cat, p_amount: Number(amount), p_description: desc, p_ref: ref || null, p_key: key.current })
    setBusy(false)
    if (error) { setMsg(error.message); setBad(true); return }
    setMsg('Expense recorded. Take the cash from the till.'); setBad(false); setAmount(''); setDesc(''); setRef(''); key.current = uid(); load()
  }
  const doVoid = async () => {
    if (!voidId || busy) return; setBusy(true)
    const { error } = await supabase.rpc('void_expense', { p_id: voidId, p_reason: why })
    setBusy(false)
    if (error) { setMsg(error.message); setBad(true); return }
    setMsg('Expense voided.'); setBad(false); setVoidId(null); setWhy(''); load()
  }
  const total = rows.filter(r => !r.voided).reduce((s, r) => s + Number(r.amount), 0)

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center gap-3"><h2 className="mr-auto text-3xl font-bold">Cash expenses · today</h2><Btn kind="ghost" className="!h-12" onClick={onDone}>Home</Btn></div>
      {msg && <div className={`mb-3 rounded-lg p-3 text-lg font-semibold ${bad ? 'bg-red-700' : 'bg-green-700'}`}>{msg}</div>}
      {can(profile, 'expense.record') && (
        <div className="mb-6 space-y-3 rounded-xl bg-slate-800 p-4">
          <div className="flex flex-wrap gap-2">{CATS.map(c => (
            <button key={c} onClick={() => setCat(c)} className={`h-12 rounded-lg px-4 text-lg font-semibold ${cat === c ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{c}</button>))}</div>
          <div className="flex flex-wrap gap-3">
            <input className={input + ' w-40'} type="number" min="0" placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)} />
            <input className={input + ' w-96'} placeholder="What was it for?" value={desc} onChange={e => setDesc(e.target.value)} />
            <input className={input + ' w-48'} placeholder="Receipt no. (optional)" value={ref} onChange={e => setRef(e.target.value)} />
            <Btn className="!h-12" onClick={save} disabled={busy || !amount || !desc.trim()}>{busy ? 'Saving…' : 'Record expense'}</Btn>
          </div>
        </div>)}
      <div className="mb-2 text-xl">Total today: <b>{kes(total)}</b></div>
      <div className="space-y-2">
        {rows.length === 0 && <div className="text-xl text-slate-400">No expenses today.</div>}
        {rows.map(r => (
          <div key={r.id} className={`rounded-xl p-3 ${r.voided ? 'bg-slate-900 opacity-60' : 'bg-slate-800'}`}>
            <div className="flex flex-wrap items-center gap-4 text-lg">
              <b className="w-28">{r.category}</b><span className="flex-1">{r.description}{r.receipt_ref && ` · #${r.receipt_ref}`}</span>
              <b className={r.voided ? 'line-through' : ''}>{kes(r.amount)}</b><span className="text-slate-400">{r.recorded_by_name}</span>
              {r.voided ? <span className="rounded bg-red-700 px-2">VOIDED: {r.void_reason}</span>
                : can(profile, 'expense.void') && <Btn kind="ghost" className="!h-10 !px-3 !text-base" onClick={() => { setVoidId(r.id); setWhy('') }}>Void</Btn>}
            </div>
            {voidId === r.id && (
              <div className="mt-2 flex gap-3"><input className={input + ' w-96'} placeholder="Reason (required)" value={why} onChange={e => setWhy(e.target.value)} />
                <Btn kind="danger" className="!h-12" onClick={doVoid} disabled={busy || !why.trim()}>Confirm void</Btn><Btn kind="ghost" className="!h-12" onClick={() => setVoidId(null)}>Cancel</Btn></div>)}
          </div>))}
      </div>
    </div>
  )
}
