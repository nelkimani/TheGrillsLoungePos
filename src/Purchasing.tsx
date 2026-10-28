import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn } from './ui'
import { kes, uid } from './lib'

type Supplier = { supplier_id: string; name: string; kind: string; is_big: boolean; phone: string | null; invoiced: number; paid: number; owed: number }
type Product = { id: string; name: string; base_unit: string }
type Line = { product_id: string; name: string; unit: string; location: string; packs: string; pack_size: string; cost_per_pack: string }
type Receipt = { id: string; receipt_no: number; business_date: string; delivery_note: string; supplier_name: string; total_cost: number; received_by_name: string; lines: number }
const input = 'h-12 rounded-lg border border-slate-500 bg-slate-900 px-3 text-lg'
const LOCS: [string, string][] = [['store', 'Store'], ['kitchen', 'Kitchen'], ['choma', 'Choma'], ['main_bar', 'Bar']]

export default function Purchasing({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [tab, setTab] = useState<'receive' | 'suppliers' | 'history'>('receive')
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [msg, setMsg] = useState(''); const [bad, setBad] = useState(false)
  const flash = (m: string, b = false) => { setMsg(m); setBad(b) }

  const load = useCallback(async () => {
    const [s, p, r] = await Promise.all([
      supabase.from('supplier_balances').select('*').order('name'),
      supabase.from('products').select('id, name, base_unit').order('name'),
      supabase.from('receipts_v').select('*').order('receipt_no', { ascending: false }).limit(40)])
    setSuppliers((s.data ?? []) as Supplier[]); setProducts((p.data ?? []) as Product[]); setReceipts((r.data ?? []) as Receipt[])
  }, [])
  useEffect(() => { load() }, [load])

  const t = (k: typeof tab, n: string) => (
    <button key={k} onClick={() => { setTab(k); setMsg('') }} className={`h-14 rounded-xl px-6 text-xl font-semibold ${tab === k ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{n}</button>)
  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="mr-4 text-3xl font-bold">Purchasing</h2>
        {t('receive', 'Receive goods')}{t('suppliers', 'Suppliers')}{t('history', 'Deliveries')}
        <Btn kind="ghost" className="ml-auto !h-12" onClick={onDone}>Home</Btn>
      </div>
      {msg && <div className={`mb-3 rounded-lg p-3 text-lg font-semibold ${bad ? 'bg-red-700' : 'bg-green-700'}`}>{msg}</div>}
      {tab === 'receive' && <Receive suppliers={suppliers} products={products} flash={flash} reload={load} />}
      {tab === 'suppliers' && <Suppliers suppliers={suppliers} profile={profile} flash={flash} reload={load} />}
      {tab === 'history' && (
        <div className="space-y-2">
          {receipts.length === 0 && <div className="text-xl text-slate-400">No deliveries yet.</div>}
          {receipts.map(r => (
            <div key={r.id} className="flex flex-wrap gap-4 rounded-xl bg-slate-800 p-3 text-lg">
              <b className="w-16">#{r.receipt_no}</b><span className="w-28">{r.business_date}</span>
              <span className="w-56 font-semibold">{r.supplier_name}</span><span className="w-40">Note {r.delivery_note}</span>
              <span className="w-24">{r.lines} item(s)</span><b className="w-36">{kes(r.total_cost)}</b>
              <span className="text-slate-300">by {r.received_by_name}</span>
            </div>))}
        </div>)}
    </div>
  )
}

function Receive({ suppliers, products, flash, reload }: { suppliers: Supplier[]; products: Product[]; flash: (m: string, b?: boolean) => void; reload: () => void }) {
  const [supplier, setSupplier] = useState('')
  const [noteNo, setNoteNo] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [pick, setPick] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const key = useRef(uid())

  const add = () => {
    const p = products.find(x => x.id === pick); if (!p) return
    setLines(l => [...l, { product_id: p.id, name: p.name, unit: p.base_unit, location: 'store', packs: '', pack_size: '1', cost_per_pack: '' }]); setPick(''); setQ('')
  }
  const set = (i: number, patch: Partial<Line>) => setLines(l => l.map((x, j) => j === i ? { ...x, ...patch } : x))
  const qtyBase = (l: Line) => Number(l.packs || 0) * Number(l.pack_size || 1)
  const costBase = (l: Line) => qtyBase(l) > 0 ? Number(l.cost_per_pack || 0) * Number(l.packs || 0) / qtyBase(l) : 0
  const total = lines.reduce((s, l) => s + Number(l.packs || 0) * Number(l.cost_per_pack || 0), 0)
  const valid = supplier && noteNo.trim() && lines.length > 0 && lines.every(l => qtyBase(l) > 0 && l.cost_per_pack !== '')

  const submit = async () => {
    if (busy || !valid) return
    setBusy(true)
    const { error } = await supabase.rpc('receive_goods', { p_supplier: supplier, p_note_no: noteNo, p_note: note || null, p_key: key.current,
      p_lines: lines.map(l => ({ product_id: l.product_id, location: l.location, qty: qtyBase(l), unit_cost: Math.round(costBase(l) * 100) / 100 })) })
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash(`Delivery recorded (${kes(total)}).`); setLines([]); setNoteNo(''); setNote(''); setSupplier(''); key.current = uid(); reload()
  }
  const matches = products.filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 60)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <select className={input + ' w-72'} value={supplier} onChange={e => setSupplier(e.target.value)}>
          <option value="">Supplier…</option>{suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.name}</option>)}</select>
        <input className={input + ' w-56'} placeholder="Delivery note no." value={noteNo} onChange={e => setNoteNo(e.target.value)} />
        <input className={input + ' w-96'} placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input className={input + ' w-64'} placeholder="Search product…" value={q} onChange={e => setQ(e.target.value)} />
        <select className={input + ' w-80'} value={pick} onChange={e => setPick(e.target.value)}>
          <option value="">Choose product…</option>{matches.map(p => <option key={p.id} value={p.id}>{p.name} ({p.base_unit})</option>)}</select>
        <Btn className="!h-12" onClick={add} disabled={!pick}>Add line</Btn>
      </div>
      {lines.length > 0 && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_130px_110px_110px_130px_130px_40px] gap-2 text-sm text-slate-400">
            <span>Product</span><span>Goes to</span><span>Packs</span><span>Units per pack</span><span>Cost per pack</span><span>Line total</span><span /></div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_130px_110px_110px_130px_130px_40px] items-center gap-2 rounded-lg bg-slate-800 p-2">
              <div className="text-lg font-semibold">{l.name}<div className="text-sm font-normal text-slate-400">= {qtyBase(l)} {l.unit} · {kes(costBase(l))} per {l.unit}</div></div>
              <select className={input + ' !px-1'} value={l.location} onChange={e => set(i, { location: e.target.value })}>{LOCS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
              <input className={input} type="number" min="0" value={l.packs} onChange={e => set(i, { packs: e.target.value })} />
              <input className={input} type="number" min="1" value={l.pack_size} onChange={e => set(i, { pack_size: e.target.value })} />
              <input className={input} type="number" min="0" value={l.cost_per_pack} onChange={e => set(i, { cost_per_pack: e.target.value })} />
              <b className="text-lg">{kes(Number(l.packs || 0) * Number(l.cost_per_pack || 0))}</b>
              <button className="h-10 rounded bg-slate-600" onClick={() => setLines(x => x.filter((_, j) => j !== i))}>✕</button>
            </div>))}
          <div className="flex items-center justify-between pt-2">
            <div className="text-3xl font-bold">Total {kes(total)}</div>
            <Btn onClick={submit} disabled={busy || !valid}>{busy ? 'Saving…' : 'Record delivery'}</Btn>
          </div>
        </div>)}
      <div className="text-sm text-slate-400">Example: 5 crates of beer, 24 bottles per crate, KES 2,400 per crate → Packs 5, Units per pack 24, Cost per pack 2400. For single items leave Units per pack at 1.</div>
    </div>
  )
}

function Suppliers({ suppliers, profile, flash, reload }: { suppliers: Supplier[]; profile: Profile; flash: (m: string, b?: boolean) => void; reload: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', kind: 'kitchen', big: false })
  const [pay, setPay] = useState<string | null>(null)
  const [p, setP] = useState({ amount: '', method: 'mpesa', ref: '' })
  const [busy, setBusy] = useState(false)
  const key = useRef(uid())
  const add = async () => {
    if (busy) return; setBusy(true)
    const { error } = await supabase.rpc('add_supplier', { p_name: f.name, p_phone: f.phone, p_kind: f.kind, p_big: f.big })
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash('Supplier added.'); setF({ name: '', phone: '', kind: 'kitchen', big: false }); reload()
  }
  const payNow = async (s: Supplier) => {
    if (busy) return; setBusy(true)
    const { error } = await supabase.rpc('record_supplier_payment', { p_supplier: s.supplier_id, p_amount: Number(p.amount), p_method: p.method, p_ref: p.ref || null, p_report: null, p_key: key.current })
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash('Payment recorded.'); setPay(null); setP({ amount: '', method: 'mpesa', ref: '' }); key.current = uid(); reload()
  }
  return (
    <div className="space-y-4">
      {can(profile, 'supplier.manage') && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-800 p-3">
          <input className={input + ' w-64'} placeholder="Supplier name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
          <input className={input + ' w-44'} placeholder="Phone" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} />
          <select className={input} value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
            <option value="kitchen">Kitchen</option><option value="drinks">Drinks</option><option value="maintenance">Maintenance</option><option value="other">Other</option></select>
          <label className="flex items-center gap-2 text-lg"><input type="checkbox" className="h-6 w-6" checked={f.big} onChange={e => setF({ ...f, big: e.target.checked })} />Big supplier (director pays)</label>
          <Btn className="!h-12" onClick={add} disabled={busy || !f.name.trim()}>Add supplier</Btn>
        </div>)}
      <div className="space-y-2">
        {suppliers.map(s => (
          <div key={s.supplier_id} className="rounded-xl bg-slate-800 p-3">
            <div className="flex flex-wrap items-center gap-4 text-lg">
              <div className="w-64 text-xl font-semibold">{s.name}{s.is_big && <span className="ml-2 rounded bg-amber-600 px-2 text-sm text-on-accent">BIG</span>}</div>
              <span className="w-28 text-slate-300">{s.kind}</span>
              <span className="w-44">Invoiced <b>{kes(s.invoiced)}</b></span><span className="w-40">Paid <b>{kes(s.paid)}</b></span>
              <span className={`w-48 text-xl font-bold ${Number(s.owed) > 0 ? 'text-amber-400' : ''}`}>Owed {kes(s.owed)}</span>
              {!s.is_big && Number(s.owed) > 0 && <Btn className="ml-auto !h-12" kind="ghost" onClick={() => { setPay(s.supplier_id); setP({ amount: String(s.owed), method: 'mpesa', ref: '' }) }}>Record payment</Btn>}
            </div>
            {pay === s.supplier_id && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input className={input + ' w-40'} type="number" value={p.amount} onChange={e => setP({ ...p, amount: e.target.value })} />
                <select className={input} value={p.method} onChange={e => setP({ ...p, method: e.target.value })}><option value="mpesa">M-Pesa</option><option value="cash">Cash from till</option><option value="bank">Bank</option><option value="cheque">Cheque</option></select>
                <input className={input + ' w-64'} placeholder="Reference (not needed for cash)" value={p.ref} onChange={e => setP({ ...p, ref: e.target.value })} />
                <Btn className="!h-12" onClick={() => payNow(s)} disabled={busy || !p.amount}>Confirm</Btn>
                <Btn kind="ghost" className="!h-12" onClick={() => setPay(null)}>Cancel</Btn>
              </div>)}
          </div>))}
        {suppliers.length === 0 && <div className="text-xl text-slate-400">No suppliers yet.</div>}
      </div>
      <div className="text-sm text-slate-400">Big suppliers are paid by the director after he signs off the report (Reports screen).</div>
    </div>
  )
}
