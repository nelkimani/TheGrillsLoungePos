import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn } from './ui'
import { kes } from './lib'

type Tab = 'sales' | 'profit' | 'stock' | 'cash'
type Row = Record<string, string | number | null>
type Col = { key: string; label: string; fmt?: 'kes' | 'num' | 'pct' | 'text'; wide?: boolean }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any

const input = 'h-12 rounded-lg border border-slate-500 bg-slate-900 px-3 text-lg'
// The trading day rolls over at 05:00 Nairobi (UTC+3), which is 02:00 UTC.
const today = () => new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 10)
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10)
const monthStart = (d: string) => d.slice(0, 8) + '01'
const weekStart = (d: string) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7))   // Monday
const num = (n: unknown) => Number(n ?? 0).toLocaleString('en-KE', { maximumFractionDigits: 3 })
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—')
const n = (v: unknown) => Number(v ?? 0)
const LOC: Record<string, string> = { main_bar: 'Bar', store: 'Store', kitchen: 'Kitchen', choma: 'Choma', waiter: 'With waiters' }
const LOSS: Record<string, string> = { wastage: 'Wastage', breakage: 'Breakage', complimentary: 'Complimentary (free)', staff_meal: 'Staff meal', count_difference: 'Stock count difference' }
const ADJ: Record<string, string> = { discount: 'Discounts', void: 'Voids', complimentary: 'Complimentary', refund: 'Refunds' }

const show = (v: string | number | null | undefined, f: Col['fmt']) =>
  v === null || v === undefined || v === '' ? '—' : f === 'kes' ? kes(Number(v)) : f === 'num' ? num(v) : f === 'pct' ? String(v) : String(v)

function csv(name: string, cols: Col[], rows: Row[]) {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const text = [cols.map(c => esc(c.label)).join(','), ...rows.map(r => cols.map(c => esc(r[c.key])).join(','))].join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name + '.csv'; a.click(); URL.revokeObjectURL(url)
}

function Table({ title, cols, rows, file, total, empty = 'Nothing for this period.' }:
  { title: string; cols: Col[]; rows: Row[]; file: string; total?: Row; empty?: string }) {
  return (
    <div className="rounded-xl bg-slate-800 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <div className="mr-auto text-2xl font-bold">{title}</div>
        {rows.length > 0 && <Btn kind="ghost" className="!h-10 !px-4 !text-base" onClick={() => csv(file, cols, total ? [...rows, total] : rows)}>Download CSV</Btn>}
      </div>
      {rows.length === 0 ? <div className="text-xl text-slate-400">{empty}</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-lg">
            <thead><tr className="border-b border-slate-600 text-left text-base text-slate-300">
              {cols.map(c => <th key={c.key} className={`px-2 py-2 font-semibold ${c.fmt && c.fmt !== 'text' ? 'text-right' : ''}`}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-700 last:border-0">
                  {cols.map(c => <td key={c.key} className={`px-2 py-2 ${c.fmt && c.fmt !== 'text' ? 'text-right tabular-nums whitespace-nowrap' : ''}`}>{show(r[c.key], c.fmt)}</td>)}
                </tr>))}
              {total && (
                <tr className="border-t-2 border-slate-500 font-bold">
                  {cols.map(c => <td key={c.key} className={`px-2 py-2 ${c.fmt && c.fmt !== 'text' ? 'text-right tabular-nums whitespace-nowrap' : ''}`}>{show(total[c.key], c.fmt)}</td>)}
                </tr>)}
            </tbody>
          </table>
        </div>)}
    </div>
  )
}

const Card = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'good' | 'warn' }) => (
  <div className="min-w-[200px] flex-1 rounded-xl bg-slate-800 p-4">
    <div className="text-base text-slate-300">{label}</div>
    <div className={`text-3xl font-bold tabular-nums ${tone === 'bad' ? 'text-red-400' : tone === 'good' ? 'text-green-400' : tone === 'warn' ? 'text-amber-300' : ''}`}>{value}</div>
    {sub && <div className="text-base text-slate-400">{sub}</div>}
  </div>)

const Warn = ({ children }: { children: ReactNode }) => (
  <div className="rounded-xl border border-amber-500 bg-amber-950/60 p-3 text-lg text-amber-200">{children}</div>)

export default function OwnerReports({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const seeSales = can(profile, 'report.sales'), seeProfit = can(profile, 'report.profit')
  const [tab, setTab] = useState<Tab>(seeSales ? 'sales' : 'profit')
  const [start, setStart] = useState(monthStart(today())); const [end, setEnd] = useState(today())
  const [loaded, setLoaded] = useState<{ tab: Tab; d: Data } | null>(null)
  const data = loaded && loaded.tab === tab ? loaded.d : null   // never show one report's numbers under another tab
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const req = useRef(0)

  const load = useCallback(async () => {
    const id = ++req.current
    if (!start || !end) return
    if (end < start) { setErr('The end date is before the start date.'); setLoaded(null); return }
    setLoading(true); setErr('')
    const fn = { sales: 'report_sales', profit: 'report_profit', stock: 'report_stock', cash: 'report_cash' }[tab]
    const { data: d, error } = await supabase.rpc(fn, { p_start: start, p_end: end })
    if (id !== req.current) return                         // a newer request replaced this one
    setLoading(false)
    if (error) { setErr(error.message); setLoaded(null); return }
    setLoaded({ tab, d })
  }, [tab, start, end])
  useEffect(() => { setLoaded(null); load() }, [load])

  const t0 = today()
  const presets: [string, string, string][] = [
    ['Today', t0, t0], ['Yesterday', addDays(t0, -1), addDays(t0, -1)],
    ['This week', weekStart(t0), t0], ['Last 7 days', addDays(t0, -6), t0], ['This month', monthStart(t0), t0],
    ['Last month', monthStart(addDays(monthStart(t0), -1)), addDays(monthStart(t0), -1)]]
  const tabBtn = (t: Tab, label: string, ok: boolean) => ok && (
    <button key={t} onClick={() => setTab(t)} className={`h-14 rounded-xl px-5 text-xl font-semibold ${tab === t ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{label}</button>)

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="mr-3 text-3xl font-bold">Owner reports</h2>
        {tabBtn('sales', 'Sales', seeSales)}{tabBtn('profit', 'Profit', seeProfit)}
        {tabBtn('stock', 'Stock value & losses', seeProfit)}{tabBtn('cash', 'Cash, M-Pesa & credit', seeSales)}
        <Btn kind="ghost" className="ml-auto !h-12" onClick={onDone}>Home</Btn>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-slate-800 p-3">
        {presets.map(([l, a, b]) => (
          <button key={l} onClick={() => { setStart(a); setEnd(b) }}
            className={`h-12 rounded-lg px-4 text-lg font-semibold ${start === a && end === b ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{l}</button>))}
        <span className="ml-auto text-lg">From</span><input type="date" className={input} value={start} onChange={e => setStart(e.target.value)} />
        <span className="text-lg">to</span><input type="date" className={input} value={end} onChange={e => setEnd(e.target.value)} />
        <Btn kind="ghost" className="!h-12" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Btn>
      </div>
      {err && <div className="mb-3 rounded-lg bg-red-700 p-3 text-lg font-semibold">{err}</div>}
      {!data && !err && <div className="text-xl text-slate-400">Loading…</div>}
      {data && tab === 'sales' && <Sales d={data} />}
      {data && tab === 'profit' && <Profit d={data} />}
      {data && tab === 'stock' && <Stock d={data} />}
      {data && tab === 'cash' && <Cash d={data} />}
    </div>
  )
}

// ───────────── 1. Sales ─────────────
function Sales({ d }: { d: Data }) {
  const t = d.totals; const net = n(t.gross) - n(t.adjustments)
  const days: Row[] = d.by_day.map((r: Row) => ({ ...r, net: n(r.gross) - n(r.adjustments) }))
  const max = Math.max(1, ...days.map(r => n(r.net)))
  const prods: Row[] = d.by_product.map((r: Row) => ({ ...r, share: pct(n(r.gross), n(t.gross)) }))
  const adjKinds = Object.entries(t.adjustments_by_kind as Record<string, number>)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card label="Net sales" value={kes(net)} sub={`${kes(t.gross)} before ${kes(t.adjustments)} adjustments`} />
        <Card label="Bills (tabs)" value={num(t.tabs)} sub={n(t.tabs) > 0 ? `${kes(n(t.gross) / n(t.tabs))} average per bill` : undefined} />
        <Card label="Items served" value={num(t.items)} />
      </div>
      {adjKinds.length > 0 && <div className="rounded-xl bg-slate-800 p-3 text-lg">Adjustments taken off: {adjKinds.map(([k, v]) => `${ADJ[k] ?? k} ${kes(v)}`).join(' · ')}</div>}
      <div className="rounded-xl bg-slate-800 p-4">
        <div className="mb-2 text-2xl font-bold">Net sales by day</div>
        {days.length <= 62 ? (
          <div className="flex h-44 items-end gap-1">
            {days.map(r => (
              <div key={String(r.date)} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${r.date}: ${kes(n(r.net))}`}>
                <div className="w-full rounded-t bg-amber-500" style={{ height: `${(n(r.net) / max) * 100}%`, minHeight: n(r.net) > 0 ? 2 : 0 }} />
              </div>))}
          </div>) : <div className="text-slate-400">Too many days to draw; see the table.</div>}
      </div>
      <Table title="By day" file="sales-by-day" rows={days}
        cols={[{ key: 'date', label: 'Day' }, { key: 'tabs', label: 'Bills', fmt: 'num' }, { key: 'gross', label: 'Sales', fmt: 'kes' }, { key: 'adjustments', label: 'Adjustments', fmt: 'kes' }, { key: 'net', label: 'Net', fmt: 'kes' }]}
        total={{ date: 'Total', tabs: t.tabs, gross: t.gross, adjustments: t.adjustments, net }} />
      <Table title="By product" file="sales-by-product" rows={prods}
        cols={[{ key: 'product', label: 'Product' }, { key: 'category', label: 'Category' }, { key: 'qty', label: 'Qty sold', fmt: 'num' }, { key: 'gross', label: 'Sales', fmt: 'kes' }, { key: 'share', label: 'Share', fmt: 'pct' }]} />
      <Table title="By waiter" file="sales-by-waiter" rows={d.by_waiter}
        cols={[{ key: 'waiter', label: 'Waiter' }, { key: 'staff_no', label: 'ID' }, { key: 'tabs', label: 'Bills', fmt: 'num' }, { key: 'items', label: 'Items', fmt: 'num' }, { key: 'gross', label: 'Sales', fmt: 'kes' }, { key: 'adjustments', label: 'Adjustments on their bills', fmt: 'kes' }]} />
      <div className="text-base text-slate-400">A sale counts on the trading day the item was served. Waiter figures are for the bills each waiter owns. Adjustments count on the day they were approved.</div>
    </div>
  )
}

// ───────────── 2. Profit ─────────────
function Profit({ d }: { d: Data }) {
  const s = d.sales, c = d.cost, f = d.flags
  const line = (label: string, v: number, o: { minus?: boolean; bold?: boolean; sub?: string; tone?: string } = {}) => (
    <div className={`flex items-baseline justify-between border-b border-slate-700 py-2 text-xl ${o.bold ? 'font-bold' : ''}`}>
      <span>{label}{o.sub && <span className="ml-2 text-base font-normal text-slate-400">{o.sub}</span>}</span>
      <span className={`tabular-nums ${o.tone ?? ''}`}>{o.minus ? (v !== 0 ? '− ' : '') + kes(Math.abs(v)) : kes(v)}</span>
    </div>)
  const gp = n(d.gross_profit), net = n(s.net), res = n(d.operating_result)
  const counts = f.counts as Record<string, { products: number; first: string; last: string }>
  const noCounts = ['kitchen', 'choma'].filter(k => !counts[k])
  const bars: Row[] = d.bar_rows
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card label="Net sales" value={kes(net)} />
        <Card label="Gross profit" value={kes(gp)} sub={`${pct(gp, net)} of net sales`} tone={gp < 0 ? 'bad' : undefined} />
        <Card label="Result for the period" value={kes(res)} sub="before payroll, maintenance and other director's items" tone={res < 0 ? 'bad' : 'good'} />
      </div>
      {n(f.bar_items_without_stock_deduction) > 0 && <Warn><b>{f.bar_items_without_stock_deduction} bar line(s)</b> were served without taking stock off the bar (usually a missing unit conversion for the product). Bar cost is too low by that amount.</Warn>}
      {f.uncosted_products.length > 0 && <Warn><b>No cost on record</b> for: {f.uncosted_products.join(', ')}. Their cost is counted as zero until goods are received for them.</Warn>}
      {noCounts.length > 0 && <Warn><b>No {noCounts.map(k => LOC[k]).join(' or ')} stock count in this period</b>, so food used shows zero for {noCounts.length === 2 ? 'both' : 'it'}. Kitchen and choma cost comes only from stock counts: count at the start and the end of the period for a true figure.</Warn>}
      {n(s.untracked) > 0 && <Warn>{kes(s.untracked)} of sales are from products with no station, so no cost is tracked for them.</Warn>}

      <div className="rounded-xl bg-slate-800 p-4">
        <div className="mb-1 text-2xl font-bold">Profit and loss · {d.period.start} to {d.period.end}</div>
        {line('Bar and drinks sales', n(s.bar))}{line('Kitchen sales', n(s.kitchen))}{line('Choma sales', n(s.choma))}
        {n(s.untracked) > 0 && line('Other sales (no station)', n(s.untracked))}
        {line('Adjustments (discounts, voids, free items)', n(s.adjustments), { minus: true })}
        {line('Net sales', net, { bold: true })}
        {line('Cost of bar sales', n(c.bar), { minus: true, sub: 'stock taken off the bar × cost' })}
        {line('Kitchen and choma stock used', n(c.food_used), { minus: true, sub: 'from stock counts' })}
        {line('Gross profit', gp, { bold: true, tone: gp < 0 ? 'text-red-400' : '' })}
        {line('Losses and giveaways', n(d.losses_total), { minus: true, sub: 'wastage, breakage, free, staff meals, bar/store count differences' })}
        {line('Cash expenses', n(d.expenses_total), { minus: true, sub: 'transport, gas and so on, not voided' })}
        {line('Result for the period', res, { bold: true, tone: res < 0 ? 'text-red-400' : 'text-green-400' })}
        <div className="mt-2 text-base text-slate-400">Cost is the latest delivery price on or before {d.period.end}. Payments to small suppliers made from the till are not counted as expenses here (their goods are already in the cost). Payroll, maintenance and other items in the director's report are not included.</div>
      </div>

      <Table title="Bar and drinks: sales against cost" file="profit-bar" rows={bars}
        cols={[{ key: 'product', label: 'Product' }, { key: 'qty_sold', label: 'Sold', fmt: 'num' }, { key: 'sales', label: 'Sales', fmt: 'kes' }, { key: 'qty_base', label: 'Stock taken off', fmt: 'num' }, { key: 'unit', label: 'Unit' }, { key: 'unit_cost', label: 'Cost each', fmt: 'kes' }, { key: 'cost', label: 'Cost', fmt: 'kes' }, { key: 'margin', label: 'Margin', fmt: 'kes' }]} />
      <Table title="Kitchen and choma stock used" file="profit-food" rows={d.food_rows.map((r: Row) => ({ ...r, location: LOC[String(r.location)] ?? r.location }))}
        empty="No stock used was recorded. Kitchen and choma stock only goes down when it is counted."
        cols={[{ key: 'product', label: 'Product' }, { key: 'location', label: 'Where' }, { key: 'qty_used', label: 'Used', fmt: 'num' }, { key: 'unit', label: 'Unit' }, { key: 'unit_cost', label: 'Cost each', fmt: 'kes' }, { key: 'cost', label: 'Cost', fmt: 'kes' }]} />
      <Table title="Losses and giveaways" file="profit-losses" rows={d.loss_rows.map((r: Row) => ({ ...r, type: LOSS[String(r.type)] ?? r.type }))}
        cols={[{ key: 'type', label: 'Type' }, { key: 'product', label: 'Product' }, { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'unit', label: 'Unit' }, { key: 'cost', label: 'Cost', fmt: 'kes' }]}
        total={d.loss_rows.length ? { type: 'Total', cost: d.losses_total } : undefined} />
      <Table title="Cash expenses" file="profit-expenses" rows={d.expense_rows}
        cols={[{ key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount', fmt: 'kes' }]}
        total={d.expense_rows.length ? { category: 'Total', amount: d.expenses_total } : undefined} />
    </div>
  )
}

// ───────────── 3. Stock value and losses ─────────────
function Stock({ d }: { d: Data }) {
  const neg: { product: string; location: string; qty: number }[] = d.flags.negative
  const loss: Row[] = d.loss_rows.map((r: Row) => ({ ...r, type: LOSS[String(r.type)] ?? r.type }))
  const lossOnly = d.loss_rows.reduce((s: number, r: Row) => s + n(r.value), 0)
  const counts: Row[] = d.count_rows.map((r: Row) => ({ ...r, location: LOC[String(r.location)] ?? r.location, loss: -n(r.value) }))
  const stock: Row[] = d.stock_rows.map((r: Row) => ({ ...r, location: LOC[String(r.location)] ?? r.location }))
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card label={`Stock value at end of ${d.period.end}`} value={kes(d.total_value)} sub="book quantity × latest cost" />
        {d.by_location.map((l: Row) => <Card key={String(l.location)} label={LOC[String(l.location)] ?? String(l.location)} value={kes(n(l.value))} sub={`${num(l.items)} products`} />)}
        <Card label="Shrinkage in the period" value={kes(d.losses_total)} sub="losses and count differences, at cost" tone={n(d.losses_total) > 0 ? 'bad' : undefined} />
      </div>
      {neg.length > 0 && <Warn><b>Negative stock</b> (more sold than received, so the book is wrong): {neg.map(x => `${x.product} in ${LOC[x.location] ?? x.location} (${num(x.qty)})`).join(', ')}. These are valued at their negative amount.</Warn>}
      {d.flags.uncosted.length > 0 && <Warn><b>No cost on record</b> for: {d.flags.uncosted.join(', ')}. They are valued at zero.</Warn>}
      <Table title="Stock on hand" file="stock-valuation" rows={stock} empty="No stock is recorded yet."
        cols={[{ key: 'location', label: 'Where' }, { key: 'product', label: 'Product' }, { key: 'qty', label: 'Quantity', fmt: 'num' }, { key: 'unit', label: 'Unit' }, { key: 'unit_cost', label: 'Cost each', fmt: 'kes' }, { key: 'value', label: 'Value', fmt: 'kes' }]}
        total={stock.length ? { location: 'Total', value: d.total_value } : undefined} />
      <Table title="Stock written off" file="stock-writeoffs" rows={loss}
        cols={[{ key: 'type', label: 'Type' }, { key: 'product', label: 'Product' }, { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'unit', label: 'Unit' }, { key: 'value', label: 'Cost', fmt: 'kes' }]}
        total={loss.length ? { type: 'Total', value: lossOnly } : undefined} />
      <Table title="Stock count differences" file="stock-count-differences" rows={counts}
        empty="No count found a difference in this period."
        cols={[{ key: 'date', label: 'Date' }, { key: 'location', label: 'Where' }, { key: 'product', label: 'Product' }, { key: 'expected', label: 'Book', fmt: 'num' }, { key: 'counted', label: 'Counted', fmt: 'num' }, { key: 'variance', label: 'Difference', fmt: 'num' }, { key: 'loss', label: 'Loss (+) / gain (−)', fmt: 'kes' }, { key: 'explanation', label: 'Reason' }, { key: 'counted_by', label: 'Counted by' }]} />
      <div className="text-base text-slate-400">Shrinkage here includes kitchen and choma count differences. The profit report treats those as food used, so do not add the two reports together.</div>
    </div>
  )
}

// ───────────── 4. Cash, M-Pesa and credit ─────────────
function Cash({ d }: { d: Data }) {
  const t = d.totals; const paid = n(t.cash) + n(t.mpesa)
  const open = d.open_tabs
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card label="Cash taken" value={kes(t.cash)} sub={`${pct(n(t.cash), paid)} of money paid`} />
        <Card label="M-Pesa" value={kes(t.mpesa)} sub={`${pct(n(t.mpesa), paid)} of money paid`} />
        <Card label="Credit given" value={kes(t.credit_given)} tone={n(t.credit_given) > 0 ? 'warn' : undefined} />
        <Card label="Cash to bank" value={kes(t.cash_to_bank)} sub={`${kes(t.cash_received)} received − ${kes(t.expenses)} paid out`} />
      </div>
      {n(t.mpesa_awaiting) > 0 && <Warn><b>{kes(t.mpesa_awaiting)} of M-Pesa is not verified yet</b>{n(t.mpesa_disputed) > 0 && <> and <b>{kes(t.mpesa_disputed)} is disputed</b></>}.</Warn>}
      {n(t.mpesa_awaiting) === 0 && n(t.mpesa_disputed) > 0 && <Warn><b>{kes(t.mpesa_disputed)} of M-Pesa is disputed.</b></Warn>}
      {n(t.cash_short) !== 0 && <Warn>Cash received was {n(t.cash_short) > 0 ? `SHORT by ${kes(t.cash_short)}` : `OVER by ${kes(-n(t.cash_short))}`} against what the till records said, on days where cash was received.</Warn>}
      <Table title="By day" file="cash-by-day" rows={d.by_day}
        cols={[{ key: 'date', label: 'Day' }, { key: 'net_sales', label: 'Net sales', fmt: 'kes' }, { key: 'cash', label: 'Cash taken', fmt: 'kes' }, { key: 'mpesa', label: 'M-Pesa', fmt: 'kes' }, { key: 'mpesa_verified', label: 'M-Pesa verified', fmt: 'kes' }, { key: 'mpesa_disputed', label: 'M-Pesa disputed', fmt: 'kes' }, { key: 'credit', label: 'Credit given', fmt: 'kes' }, { key: 'cash_received', label: 'Cash received', fmt: 'kes' }, { key: 'cash_short', label: 'Short (+)', fmt: 'kes' }, { key: 'expenses', label: 'Paid out', fmt: 'kes' }, { key: 'cash_to_bank', label: 'To bank', fmt: 'kes' }]}
        total={{ date: 'Total', net_sales: t.net_sales, cash: t.cash, mpesa: t.mpesa, mpesa_verified: t.mpesa_verified, mpesa_disputed: t.mpesa_disputed, credit: t.credit_given, cash_received: t.cash_received, cash_short: t.cash_short, expenses: t.expenses, cash_to_bank: t.cash_to_bank }} />
      <Table title={`Credit still owed (all dates) · ${kes(d.credit_owing_total)}`} file="credit-owing" rows={d.credit_owing} empty="No credit is owed."
        cols={[{ key: 'customer', label: 'Customer' }, { key: 'waiter', label: 'Waiter' }, { key: 'since', label: 'Since' }, { key: 'balance', label: 'Owed', fmt: 'kes' }]} />
      <div className="rounded-xl bg-slate-800 p-3 text-lg">Open tabs right now: <b>{num(open.count)}</b> owing <b>{kes(open.balance)}</b> (not yet paid or put on credit).</div>
      <div className="text-base text-slate-400">"Cash taken" is what waiters recorded; "Cash received" is what the accountant counted in. "Paid out" is every cash expense not voided, including cash paid to small suppliers. Credit is counted on the day the tab was closed on credit.</div>
    </div>
  )
}
