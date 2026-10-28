import { useCallback, useEffect, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn, Keypad } from './ui'
import { isNetworkError, uid } from './lib'

type Row = { product_id: string; name: string; base_unit: string; category: string | null; reorder_level: number | null; on_hand: number; low: boolean; negative: boolean }
type Mode = 'menu' | 'count' | 'in' | 'out'

const OUT_TYPES: [string, string][] = [['wastage', 'Wastage'], ['breakage', 'Breakage'], ['complimentary', 'Complimentary'], ['staff_meal', 'Staff meal']]
const OUT_REASONS = ['Broken bottle', 'Spilled', 'Expired', 'Customer complaint', 'Manager sample', 'Other']
const COUNT_REASONS = ['Miscount earlier', 'Breakage not recorded', 'Spillage', 'Unknown', 'Other']

export default function BarStock({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [sel, setSel] = useState<Row | null>(null)
  const [mode, setMode] = useState<Mode>('menu')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [outType, setOutType] = useState('wastage')
  const [inType, setInType] = useState('purchase')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [bad, setBad] = useState(false)
  const key = useState(() => ({ k: uid() }))[0]

  const load = useCallback(async () => {
    const { data } = await supabase.from('bar_stock').select('*').order('name')
    if (data) setRows(data as Row[])
  }, [])
  useEffect(() => { load() }, [load])

  const reset = () => { setQty(''); setReason(''); key.k = uid() }
  const open = (m: Mode) => { setMode(m); reset(); setMsg('') }
  const q = qty === '' ? 0 : Number(qty)
  const canIn = can(profile, 'goods.receive') || can(profile, 'stock.adjust')
  const direct = can(profile, 'stock.adjust')

  const run = async () => {
    if (!sel || busy) return
    setBusy(true); setMsg(''); setBad(false)
    let error: { code?: string; message: string } | null = null
    let ok = ''
    if (mode === 'count') {
      ({ error } = await supabase.rpc('record_stock_count', { p_product: sel.product_id, p_counted: q, p_explanation: reason || null }))
      ok = 'Count recorded.'
    } else if (mode === 'in') {
      ({ error } = await supabase.rpc('stock_in', { p_product: sel.product_id, p_qty: q, p_type: inType, p_note: reason || null, p_key: key.k }))
      ok = 'Stock added.'
    } else if (mode === 'out') {
      if (direct) {
        ({ error } = await supabase.rpc('post_stock_out', { p_product: sel.product_id, p_qty: q, p_type: outType, p_reason: reason, p_key: key.k }))
        ok = 'Recorded.'
      } else {
        ({ error } = await supabase.rpc('request_stock_out', { p_product: sel.product_id, p_qty: q, p_type: outType, p_reason: reason, p_key: key.k }))
        ok = 'Sent to the manager for approval. Stock changes only after they approve.'
      }
    }
    setBusy(false)
    if (error) { setBad(true); setMsg(isNetworkError(error) ? 'No connection – NOT recorded. Try again.' : error.message); return }
    setMsg(ok); reset(); setMode('menu'); load()
  }

  const chip = (t: string, on: boolean, f: () => void) => (
    <button key={t} onClick={f} className={`h-[3.75rem] rounded-xl px-4 text-lg font-semibold ${on ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{t}</button>
  )

  return (
    <div className="grid grid-cols-[1fr_460px] gap-4 p-4">
      <div>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="mr-auto text-3xl font-bold">Bar stock</h2>
          <Btn kind="ghost" onClick={onDone}>Home</Btn>
        </div>
        <div className="space-y-2">
          {rows.map(r => (
            <button key={r.product_id} onClick={() => { setSel(r); open('menu') }}
              className={`flex w-full items-center gap-3 rounded-xl p-3 text-left text-xl ${sel?.product_id === r.product_id ? 'bg-amber-600 text-on-accent' : 'bg-slate-800'}`}>
              <span className="flex-1">{r.name}<span className="ml-2 text-base opacity-70">{r.category}</span></span>
              {r.negative && <span className="rounded bg-red-700 px-2 py-1 text-base font-bold text-white">NEGATIVE</span>}
              {r.low && !r.negative && <span className="rounded bg-amber-500 px-2 py-1 text-base font-bold text-on-accent">LOW</span>}
              <span className="w-32 text-right text-3xl font-bold tabular-nums">{Number(r.on_hand)} <span className="text-base font-normal">{r.base_unit}</span></span>
            </button>
          ))}
          {rows.length === 0 && <div className="text-xl text-slate-400">No bar products yet.</div>}
        </div>
      </div>

      <div className="rounded-xl bg-slate-800 p-4">
        {msg && <div className={`mb-3 rounded-lg p-3 text-lg font-semibold ${bad ? 'bg-red-700' : 'bg-green-700'}`}>{msg}</div>}
        {!sel && <div className="text-xl text-slate-400">Choose a product to count it, add stock or record wastage.</div>}
        {sel && mode === 'menu' && (
          <div className="flex flex-col gap-3">
            <div className="text-2xl font-bold">{sel.name}</div>
            <div className="text-lg text-slate-300">In the bar now: {Number(sel.on_hand)} {sel.base_unit}</div>
            {can(profile, 'stock.count') && <Btn onClick={() => open('count')}>Count stock</Btn>}
            {canIn && <Btn kind="ghost" onClick={() => open('in')}>Add stock (delivery / opening)</Btn>}
            {(direct || can(profile, 'station.bar')) && <Btn kind="ghost" onClick={() => open('out')}>{direct ? 'Wastage / breakage / complimentary' : 'Request wastage / breakage'}</Btn>}
          </div>
        )}
        {sel && mode !== 'menu' && (
          <div className="flex flex-col gap-3">
            <div className="text-2xl font-bold">{sel.name} — {mode === 'count' ? 'count' : mode === 'in' ? 'add stock' : direct ? 'stock out' : 'request stock out'}</div>
            {mode === 'out' && <div className="flex flex-wrap gap-2">{OUT_TYPES.map(([c, n]) => chip(n, outType === c, () => setOutType(c)))}</div>}
            {mode === 'in' && <div className="flex gap-2">{chip('Delivery', inType === 'purchase', () => setInType('purchase'))}
              {can(profile, 'stock.adjust') && chip('Opening stock', inType === 'opening', () => setInType('opening'))}</div>}
            <div className="h-btn rounded-xl border-2 border-amber-500 bg-slate-900 px-4 text-4xl font-bold leading-[var(--btn-h)]">
              {qty ? `${q} ${sel.base_unit}` : <span className="text-xl font-normal text-slate-500">{mode === 'count' ? 'Quantity counted' : 'Quantity'}</span>}</div>
            <Keypad onDigit={d => setQty(v => (v + d).replace(/^0+(?=\d)/, '').slice(0, 6))} onBack={() => setQty(v => v.slice(0, -1))} onClear={() => setQty('')} />
            {(mode === 'out' || mode === 'count') && (
              <div className="flex flex-wrap gap-2">{(mode === 'out' ? OUT_REASONS : COUNT_REASONS).map(r => chip(r, reason === r, () => setReason(r)))}</div>
            )}
            <div className="flex gap-3">
              <Btn kind="ghost" onClick={() => open('menu')}>Cancel</Btn>
              <Btn onClick={run} disabled={busy || (mode !== 'count' && q <= 0) || (mode === 'count' && qty === '') || (mode === 'out' && !reason)}>
                {busy ? 'Saving…' : mode === 'count' ? 'Save count' : mode === 'out' && !direct ? 'Send for approval' : 'Save'}</Btn>
            </div>
            {mode === 'count' && <div className="text-sm text-slate-400">If your count differs from the book, pick a reason. The difference is recorded and the book is corrected.</div>}
          </div>
        )}
      </div>
    </div>
  )
}
