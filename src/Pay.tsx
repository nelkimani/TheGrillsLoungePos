import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, Profile } from './supabase'
import { AlphaKeys, Btn, Keypad } from './ui'
import { isNetworkError, kes, uid } from './lib'
import { BillLine, CardRow, PaymentLines, PaymentRow, Slip } from './Receipt'

type Mode = 'cash' | 'mpesa' | 'split'
type Done = { p: PaymentRow; remaining: number; settled: boolean }

export default function Pay({ profile, tab, onBack, onDone }:
  { profile: Profile; tab: { id: string; label: string }; onBack: () => void; onDone: () => void }) {
  const [card, setCard] = useState<CardRow | null>(null)
  const [lines, setLines] = useState<BillLine[]>([])
  const [mode, setMode] = useState<Mode>('cash')
  const [target, setTarget] = useState<number | null>(null)      // null = whole balance
  const [tendered, setTendered] = useState('')
  const [code, setCode] = useState('')
  const [people, setPeople] = useState(2)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<Done | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const keyRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([
      supabase.from('tab_cards').select('*').eq('tab_id', tab.id).maybeSingle(),
      supabase.from('tab_bill_lines').select('*').eq('tab_id', tab.id).order('created_at'),
    ])
    setCard((c.data as CardRow | null) ?? null)
    if (l.data) setLines(l.data as BillLine[])
  }, [tab.id])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const balance = Number(card?.balance ?? 0)
  const pending = Number(card?.pending_total ?? 0)
  const amount = Math.min(target ?? balance, balance)
  const tend = tendered === '' ? 0 : Number(tendered)
  const applied = Math.min(amount, tend)
  const change = Math.max(0, tend - amount)
  const served = lines.filter(l => l.status === 'served')

  const pay = async (method: 'cash' | 'mpesa', amt: number, given: number | null) => {
    if (busy) return                                              // in-flight lock
    if (!navigator.onLine) { setErr('NO CONNECTION – payment NOT recorded. Reconnect and try again.'); return }
    setBusy(true); setErr('')
    if (!keyRef.current) keyRef.current = uid()
    const { data, error } = await supabase.rpc('record_payment', {
      p_tab: tab.id, p_method: method, p_amount: amt, p_mpesa_code: method === 'mpesa' ? code : null,
      p_key: keyRef.current, p_tendered: method === 'cash' ? given : null })
    if (error) {
      if (isNetworkError(error)) setErr('Could not confirm the payment. Check the connection and tap Pay again – it will not charge twice.')
      else { setErr(error.message); keyRef.current = null }
      setBusy(false); return
    }
    keyRef.current = null
    const p = data as PaymentRow
    const remaining = balance - Number(p.amount)
    setDone({ p, remaining, settled: remaining === 0 && pending === 0 })
    setBusy(false)
  }

  if (done) {
    const { p, remaining, settled } = done
    return (
      <div className="flex flex-col items-center gap-3 p-4">
        <div className="rounded-xl bg-green-700 px-8 py-3 text-4xl font-bold">Payment recorded · Receipt #{p.receipt_no}</div>
        {p.method === 'cash' && Number(p.change_given ?? 0) > 0 && (
          <div className="text-center"><div className="text-2xl text-slate-300">CHANGE DUE</div>
            <div className="text-6xl font-bold text-amber-400">{kes(p.change_given)}</div></div>
        )}
        {p.method === 'mpesa' && <div className="rounded bg-amber-600 px-4 py-1 text-xl font-semibold text-on-accent">Awaiting verification</div>}
        <div className="text-2xl">{settled ? 'Tab settled' : `Balance remaining ${kes(remaining)}`}</div>
        <Slip heading="Receipt" label={tab.label} waiter={profile.full_name} lines={served}
              total={Number(card?.bill_total ?? 0)}>
          <PaymentLines p={p} remaining={remaining} />
        </Slip>
        <div className="flex gap-3">
          <Btn kind="ghost" onClick={() => window.print()}>Print receipt</Btn>
          <Btn onClick={onDone}>Done</Btn>
        </div>
        <div className="text-sm text-slate-400">Printing only prints. It never records a second payment.</div>
      </div>
    )
  }

  const tab_ = (m: Mode, text: string) => (
    <button onClick={() => { setMode(m); setErr('') }}
      className={`h-[3.75rem] flex-1 rounded-xl text-xl font-semibold ${mode === m ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{text}</button>
  )
  const lock = !online || !card || balance <= 0

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-3 flex items-center gap-3">
        <Btn kind="ghost" onClick={onBack} className="!h-[3.75rem]">← {tab.label}</Btn>
        <div className="ml-auto grid grid-cols-3 gap-6 text-right">
          <div><div className="text-sm text-slate-400">TOTAL (served)</div><div className="text-3xl font-bold">{kes(card?.bill_total)}</div></div>
          <div><div className="text-sm text-slate-400">PAID</div><div className="text-3xl font-bold">{kes(card?.paid)}</div></div>
          <div><div className="text-sm text-slate-400">BALANCE</div><div className="text-5xl font-bold text-amber-400">{kes(balance)}</div></div>
        </div>
      </div>
      {pending > 0 && <div className="mb-2 rounded-lg bg-slate-800 p-2 text-lg">{kes(pending)} is not served yet and cannot be paid until it is served.</div>}
      {!online && <div className="mb-2 rounded-lg bg-red-700 p-3 text-xl font-semibold">NO CONNECTION – payments are blocked until the network is back.</div>}
      {err && <div className="mb-2 rounded-lg bg-red-700 p-3 text-lg font-semibold">{err}</div>}
      <div className="mb-3 flex gap-3">{tab_('cash', 'Cash')}{tab_('mpesa', 'M-Pesa')}{tab_('split', 'Split / part')}</div>

      {mode !== 'split' && (
        <div className="mb-3 text-2xl">Paying: <b>{kes(amount)}</b>
          {target !== null && <button className="ml-4 rounded-lg bg-slate-700 px-4 py-2 text-lg" onClick={() => setTarget(null)}>Pay full balance</button>}
        </div>
      )}

      {mode === 'cash' && (
        <div className="grid grid-cols-[1fr_auto] gap-8">
          <div className="flex flex-col gap-3">
            <div className="text-lg text-slate-300">Cash given by customer</div>
            <div className="h-btn rounded-xl border-2 border-amber-500 bg-slate-800 px-4 text-4xl font-bold leading-[var(--btn-h)]">{tendered ? kes(tend) : <span className="text-xl text-slate-500">Enter cash given</span>}</div>
            <div className="flex flex-wrap gap-2">
              <button className="h-[3.75rem] rounded-xl bg-slate-700 px-4 text-xl" onClick={() => setTendered(String(amount))}>Exact</button>
              {[100, 200, 500, 1000].map(n => <button key={n} className="h-[3.75rem] rounded-xl bg-slate-700 px-4 text-xl" onClick={() => setTendered(String(n))}>{n}</button>)}
            </div>
            <div className="rounded-xl bg-slate-800 p-3">
              <div className="text-lg text-slate-400">CHANGE DUE</div>
              <div className="text-5xl font-bold text-amber-400">{kes(change)}</div>
              {tend > 0 && tend < amount && <div className="text-lg text-slate-300">Part payment: {kes(applied)} applied, {kes(balance - applied)} will remain.</div>}
            </div>
            <Btn onClick={() => pay('cash', applied, tend)} disabled={busy || lock || tend <= 0}>{busy ? 'Recording…' : 'RECORD CASH PAYMENT'}</Btn>
          </div>
          <Keypad onDigit={d => setTendered(t => (t + d).replace(/^0+/, '').slice(0, 7))}
                  onBack={() => setTendered(t => t.slice(0, -1))} onClear={() => setTendered('')} />
        </div>
      )}

      {mode === 'mpesa' && (
        <div className="flex flex-col items-center gap-3">
          <div className="text-lg text-slate-300">M-Pesa transaction code from the customer's confirmation message (10 characters)</div>
          <div className="h-btn w-[min(40rem,100%)] rounded-xl border-2 border-amber-500 bg-slate-800 px-4 text-4xl font-bold tracking-widest leading-[var(--btn-h)]">
            {code || <span className="text-xl font-normal tracking-normal text-slate-500">e.g. SHK4X9ABCD</span>}
          </div>
          <AlphaKeys onKey={k => setCode(c => (c + k).slice(0, 10))} onBack={() => setCode(c => c.slice(0, -1))} onClear={() => setCode('')} />
          <Btn onClick={() => pay('mpesa', amount, null)} disabled={busy || lock || code.length !== 10 || amount <= 0} className="w-[min(40rem,100%)]">
            {busy ? 'Recording…' : `RECORD M-PESA ${kes(amount)}`}</Btn>
          <div className="text-sm text-slate-400">The accountant verifies the code against the M-Pesa statement later. A code can be used only once.</div>
        </div>
      )}

      {mode === 'split' && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl bg-slate-800 p-3">
            <div className="mb-2 text-xl font-bold">Split equally</div>
            <div className="mb-2 flex items-center gap-2">
              <button className="h-14 w-14 rounded-lg bg-slate-600 text-3xl" onClick={() => setPeople(n => Math.max(2, n - 1))}>−</button>
              <span className="w-12 text-center text-3xl">{people}</span>
              <button className="h-14 w-14 rounded-lg bg-slate-600 text-3xl" onClick={() => setPeople(n => Math.min(20, n + 1))}>+</button>
              <span className="text-lg">people</span>
            </div>
            <div className="mb-2 text-xl">One share: <b>{kes(Math.ceil(balance / people))}</b></div>
            <Btn onClick={() => { setTarget(Math.ceil(balance / people)); setTendered(''); setMode('cash') }} disabled={balance <= 0}>Pay one share</Btn>
          </div>
          <div className="rounded-xl bg-slate-800 p-3">
            <div className="mb-2 text-xl font-bold">Pay by item</div>
            <div className="mb-2 max-h-[14rem] space-y-1 overflow-y-auto">
              {served.map(l => (
                <button key={l.item_id} onClick={() => setPicked(s => { const n = new Set(s); n.has(l.item_id) ? n.delete(l.item_id) : n.add(l.item_id); return n })}
                  className={`flex w-full justify-between rounded-lg p-2 text-left text-lg ${picked.has(l.item_id) ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>
                  <span>{Number(l.qty)} × {l.product_name}</span><span>{kes(l.line_total)}</span>
                </button>
              ))}
            </div>
            {(() => {
              const sum = served.filter(l => picked.has(l.item_id)).reduce((s, l) => s + Number(l.line_total), 0)
              return <Btn onClick={() => { setTarget(Math.min(sum, balance)); setTendered(''); setMode('cash') }} disabled={sum <= 0 || balance <= 0}>Pay selected {kes(sum)}</Btn>
            })()}
          </div>
          <div className="rounded-xl bg-slate-800 p-3">
            <div className="mb-2 text-xl font-bold">Part payment</div>
            <div className="mb-2 h-14 rounded-lg bg-slate-900 px-3 text-2xl leading-[3.5rem]">{custom ? kes(Number(custom)) : <span className="text-slate-500">Amount</span>}</div>
            <div className="mb-2 scale-90 origin-top-left"><Keypad onDigit={d => setCustom(c => (c + d).replace(/^0+/, '').slice(0, 7))}
              onBack={() => setCustom(c => c.slice(0, -1))} onClear={() => setCustom('')} /></div>
            <Btn onClick={() => { setTarget(Math.min(Number(custom), balance)); setTendered(''); setMode('cash') }} disabled={!custom || Number(custom) <= 0 || balance <= 0}>Pay {custom ? kes(Number(custom)) : ''}</Btn>
          </div>
        </div>
      )}
    </div>
  )
}
