import { useCallback, useEffect, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn } from './ui'
import { kes } from './lib'

type Row = { product_id: string; name: string; base_unit: string; location_kind: string; qty: number; reorder_level: number | null; purchase_cost: number | null }
const input = 'h-12 rounded-lg border border-slate-500 bg-slate-900 px-3 text-lg'
const LOCS: [string, string][] = [['store', 'Store'], ['kitchen', 'Kitchen'], ['choma', 'Choma']]

export default function StockRoom({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [loc, setLoc] = useState('store')
  const [rows, setRows] = useState<Row[]>([])
  const [sel, setSel] = useState<Row | null>(null)
  const [counted, setCounted] = useState('')
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(''); const [bad, setBad] = useState(false)
  const load = useCallback(async () => {
    const { data } = await supabase.from('stock_room').select('*').eq('location_kind', loc).order('name')
    setRows((data ?? []) as Row[])
  }, [loc])
  useEffect(() => { load(); setSel(null) }, [load])

  const save = async () => {
    if (!sel || busy) return; setBusy(true)
    const { error } = await supabase.rpc('record_location_count', { p_kind: loc, p_product: sel.product_id, p_counted: Number(counted), p_explanation: why || null })
    setBusy(false)
    if (error) { setMsg(error.message); setBad(true); return }
    setMsg('Count recorded.'); setBad(false); setSel(null); setCounted(''); setWhy(''); load()
  }
  const value = rows.reduce((s, r) => s + Number(r.qty) * Number(r.purchase_cost ?? 0), 0)
  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="mr-4 text-3xl font-bold">Stock room</h2>
        {LOCS.map(([c, n]) => <button key={c} onClick={() => setLoc(c)} className={`h-14 rounded-xl px-6 text-xl font-semibold ${loc === c ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{n}</button>)}
        <Btn kind="ghost" className="ml-auto !h-12" onClick={onDone}>Home</Btn>
      </div>
      {msg && <div className={`mb-3 rounded-lg p-3 text-lg font-semibold ${bad ? 'bg-red-700' : 'bg-green-700'}`}>{msg}</div>}
      <div className="mb-2 text-lg text-slate-300">Stock value at latest cost: <b>{kes(value)}</b> · stock arrives through Purchasing → Receive goods</div>
      <div className="space-y-2">
        {rows.length === 0 && <div className="text-xl text-slate-400">Nothing recorded here yet.</div>}
        {rows.map(r => (
          <div key={r.product_id} className="rounded-xl bg-slate-800 p-3">
            <div className="flex flex-wrap items-center gap-4 text-xl">
              <span className="flex-1 font-semibold">{r.name}</span>
              {Number(r.qty) < 0 && <span className="rounded bg-red-700 px-2 text-base font-bold">NEGATIVE</span>}
              {r.reorder_level != null && Number(r.qty) <= Number(r.reorder_level) && Number(r.qty) >= 0 && <span className="rounded bg-amber-500 px-2 text-base font-bold text-on-accent">LOW</span>}
              <b className="w-40 text-right text-2xl tabular-nums">{Number(r.qty)} <span className="text-base font-normal">{r.base_unit}</span></b>
              {can(profile, 'stock.count') && <Btn kind="ghost" className="!h-12" onClick={() => { setSel(r); setCounted(''); setWhy('') }}>Count</Btn>}
            </div>
            {sel?.product_id === r.product_id && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input className={input + ' w-44'} type="number" min="0" placeholder="Counted" value={counted} onChange={e => setCounted(e.target.value)} />
                <input className={input + ' w-96'} placeholder="Reason if different from the book" value={why} onChange={e => setWhy(e.target.value)} />
                <Btn className="!h-12" onClick={save} disabled={busy || counted === ''}>Save count</Btn><Btn kind="ghost" className="!h-12" onClick={() => setSel(null)}>Cancel</Btn>
              </div>)}
          </div>))}
      </div>
    </div>
  )
}
