import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn } from './ui'
import { kes, uid } from './lib'

type Rep = { id: string; period_start: string; period_end: string; status: string; notes: string | null; director_notes: string | null
  created_by_name: string; signed_by_name: string | null; supplier_total: number; other_total: number; deductions: number; small_expenses: number }
type Item = { id: string; kind: string; description: string; amount: number; status: string; director_note: string | null; supplier_name: string | null; staff_name: string | null }
type Sup = { supplier_id: string; name: string; is_big: boolean; owed: number }
type Staff = { id: string; staff_no: string; full_name: string }
type Sugg = { cash_shortages: { staff_id: string; name: string; date: string; short: number; note: string | null }[]
  stock_losses: { staff_id: string; name: string; product: string; type: string; qty: number; note: string | null; date: string }[] }
const input = 'h-12 rounded-lg border border-slate-500 bg-slate-900 px-3 text-lg'
const KIND: Record<string, string> = { supplier_invoice: 'Supplier invoice', expense_small: 'Cash expense (already paid)', maintenance: 'Maintenance', payroll: 'Payroll', deduction: 'Deduction', other: 'Other' }
const monthStart = () => { const d = new Date(Date.now() - 2 * 3600_000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10) }
const today = () => new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 10)
const badge = (s: string) => s === 'signed_off' || s === 'confirmed' ? 'bg-green-700' : s === 'returned' || s === 'rejected' ? 'bg-red-700' : s === 'submitted' ? 'bg-amber-600 text-on-accent' : 'bg-slate-600'

export default function Reports({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [reps, setReps] = useState<Rep[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [start, setStart] = useState(monthStart()); const [end, setEnd] = useState(today())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(''); const [bad, setBad] = useState(false)
  const flash = useCallback((m: string, b = false) => { setMsg(m); setBad(b) }, [])
  const load = useCallback(async () => {
    const { data } = await supabase.from('reports_v').select('*').order('period_end', { ascending: false })
    setReps((data ?? []) as Rep[])
  }, [])
  useEffect(() => { load() }, [load])

  const build = async () => {
    if (busy) return; setBusy(true)
    const { data, error } = await supabase.rpc('build_report', { p_start: start, p_end: end })
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash('Report created. Add any other items, then submit it.'); await load(); setOpen((data as { id: string }).id)
  }
  const cur = reps.find(r => r.id === open)

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-3xl font-bold">Reports & sign-off</h2>
        {open && <Btn kind="ghost" className="!h-12" onClick={() => { setOpen(null); load() }}>← All reports</Btn>}
        <Btn kind="ghost" className="!h-12" onClick={onDone}>Home</Btn>
      </div>
      {msg && <div className={`mb-3 rounded-lg p-3 text-lg font-semibold ${bad ? 'bg-red-700' : 'bg-green-700'}`}>{msg}</div>}
      {!open && (<>
        {can(profile, 'report.build') && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-slate-800 p-3">
            <span className="text-lg">New report for</span>
            <input type="date" className={input} value={start} onChange={e => setStart(e.target.value)} /> <span>to</span>
            <input type="date" className={input} value={end} onChange={e => setEnd(e.target.value)} />
            <Btn className="!h-12" onClick={build} disabled={busy}>Build report</Btn>
          </div>)}
        <div className="space-y-2">
          {reps.length === 0 && <div className="text-xl text-slate-400">No reports yet.</div>}
          {reps.map(r => (
            <button key={r.id} onClick={() => setOpen(r.id)} className="flex w-full flex-wrap items-center gap-4 rounded-xl bg-slate-800 p-3 text-left text-lg">
              <b className="w-56">{r.period_start} → {r.period_end}</b>
              <span className={`rounded px-2 py-1 font-semibold ${badge(r.status)}`}>{r.status.replace('_', ' ')}</span>
              <span>Suppliers {kes(r.supplier_total)}</span><span>Other {kes(r.other_total)}</span>
              {Number(r.deductions) > 0 && <span>Deductions −{kes(r.deductions)}</span>}<span className="text-slate-400">by {r.created_by_name}</span>
            </button>))}
        </div>
      </>)}
      {cur && <Detail rep={cur} profile={profile} flash={flash} reload={load} />}
    </div>
  )
}

function Detail({ rep, profile, flash, reload }: { rep: Rep; profile: Profile; flash: (m: string, b?: boolean) => void; reload: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [sups, setSups] = useState<Sup[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [sugg, setSugg] = useState<Sugg | null>(null)
  const [notes, setNotes] = useState('')
  const [f, setF] = useState({ kind: 'maintenance', supplier: '', staff: '', description: '', amount: '' })
  const [note, setNote] = useState<Record<string, string>>({})
  const [pay, setPay] = useState<{ sup: string; amount: string; method: string; ref: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const payKey = useRef(uid())
  const editable = rep.status === 'draft' || rep.status === 'returned'
  const builder = can(profile, 'report.build')
  const reviewer = can(profile, 'report.signoff')

  const load = useCallback(async () => {
    const [i, s, st] = await Promise.all([
      supabase.from('report_items_v').select('*').eq('report_id', rep.id).order('kind'),
      supabase.from('supplier_balances').select('supplier_id, name, is_big, owed').order('name'),
      supabase.from('staff_directory').select('id, staff_no, full_name').order('full_name')])
    setItems((i.data ?? []) as Item[]); setSups((s.data ?? []) as Sup[]); setStaff((st.data ?? []) as Staff[])
    if (builder) { const g = await supabase.rpc('deduction_suggestions', { p_start: rep.period_start, p_end: rep.period_end }); if (g.data) setSugg(g.data as Sugg) }
  }, [rep.id, rep.period_start, rep.period_end, builder])
  useEffect(() => { load() }, [load])

  const call = async (fn: string, args: Record<string, unknown>, ok: string, after?: () => void) => {
    if (busy) return; setBusy(true)
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash(ok); after?.(); load(); reload()
  }
  const addItem = () => call('add_report_item', { p_report: rep.id, p_kind: f.kind, p_supplier: f.supplier || null, p_staff: f.staff || null, p_description: f.description, p_amount: Number(f.amount) },
    'Item added.', () => setF({ ...f, description: '', amount: '' }))
  const suggest = (staffId: string, name: string, text: string, amt: number) => setF({ kind: 'deduction', supplier: '', staff: staffId, description: `${name}: ${text}`, amount: String(amt) })
  const sum = (k: string) => items.filter(i => i.kind === k && i.status !== 'rejected').reduce((s, i) => s + Number(i.amount), 0)
  const payable = sum('supplier_invoice') + sum('maintenance') + sum('payroll') + sum('other') - sum('deduction')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-slate-800 p-3 text-xl">
        <b>{rep.period_start} → {rep.period_end}</b><span className={`rounded px-2 py-1 font-semibold ${badge(rep.status)}`}>{rep.status.replace('_', ' ')}</span>
        <span className="text-slate-300">built by {rep.created_by_name}</span>{rep.signed_by_name && <span className="text-slate-300">signed by {rep.signed_by_name}</span>}
        {rep.notes && <span className="w-full text-base text-slate-300">Accountant: {rep.notes}</span>}
        {rep.director_notes && <span className="w-full text-base text-amber-300">Director: {rep.director_notes}</span>}
      </div>

      <div className="space-y-2">
        {items.map(i => (
          <div key={i.id} className="rounded-xl bg-slate-800 p-3">
            <div className="flex flex-wrap items-center gap-3 text-lg">
              <span className="w-56 text-slate-300">{KIND[i.kind]}</span>
              <span className="flex-1">{i.description}{i.supplier_name && ` · ${i.supplier_name}`}{i.staff_name && ` · ${i.staff_name}`}</span>
              <b className={`w-40 text-right text-xl ${i.kind === 'deduction' ? 'text-red-300' : ''}`}>{i.kind === 'deduction' ? '−' : ''}{kes(i.amount)}</b>
              {rep.status !== 'draft' && <span className={`rounded px-2 py-1 text-base font-semibold ${badge(i.status)}`}>{i.status}</span>}
              {editable && builder ?
                <Btn kind="ghost" className="!h-10 !px-3 !text-base" onClick={() => call('remove_report_item', { p_item: i.id }, 'Item removed.')}>Remove</Btn> : null}
              {rep.status === 'submitted' && reviewer && i.status === 'pending' && (<>
                <Btn className="!h-10 !px-3 !text-base" onClick={() => call('decide_report_item', { p_item: i.id, p_status: 'confirmed', p_note: note[i.id] || null }, 'Confirmed.')}>Confirm</Btn>
                <Btn kind="danger" className="!h-10 !px-3 !text-base" onClick={() => call('decide_report_item', { p_item: i.id, p_status: 'rejected', p_note: note[i.id] }, 'Rejected.')}>Reject</Btn></>)}
            </div>
            {rep.status === 'submitted' && reviewer && i.status === 'pending' &&
              <input className={input + ' mt-2 w-full'} placeholder="Note (required to reject)" value={note[i.id] ?? ''} onChange={e => setNote({ ...note, [i.id]: e.target.value })} />}
            {i.director_note && <div className="mt-1 text-amber-300">Director: {i.director_note}</div>}
          </div>))}
        {items.length === 0 && <div className="text-xl text-slate-400">No items in this report.</div>}
      </div>
      <div className="rounded-xl bg-slate-800 p-3 text-xl">To be paid by the director (suppliers + maintenance + payroll + other − deductions): <b>{kes(payable)}</b>
        <span className="ml-3 text-base text-slate-400">Cash expenses are already paid from the till and are listed for your information.</span></div>

      {editable && builder && (
        <div className="space-y-3 rounded-xl bg-slate-800 p-4">
          <div className="text-xl font-bold">Add an item</div>
          <div className="flex flex-wrap gap-3">
            <select className={input} value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
              <option value="maintenance">Maintenance</option><option value="payroll">Payroll</option><option value="deduction">Deduction (breakage / cash short)</option><option value="other">Other</option></select>
            {f.kind !== 'deduction' && f.kind !== 'payroll' && <select className={input} value={f.supplier} onChange={e => setF({ ...f, supplier: e.target.value })}><option value="">Supplier (optional)</option>{sups.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.name}</option>)}</select>}
            {(f.kind === 'deduction' || f.kind === 'payroll') && <select className={input} value={f.staff} onChange={e => setF({ ...f, staff: e.target.value })}><option value="">Staff member…</option>{staff.map(s => <option key={s.id} value={s.id}>{s.full_name} ({s.staff_no})</option>)}</select>}
            <input className={input + ' w-96'} placeholder="Description" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
            <input className={input + ' w-40'} type="number" min="0" placeholder="Amount" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} />
            <Btn className="!h-12" onClick={addItem} disabled={busy || !f.description.trim() || !f.amount}>Add</Btn>
          </div>
          {sugg && (sugg.cash_shortages.length > 0 || sugg.stock_losses.length > 0) && (
            <div className="rounded-lg bg-slate-700 p-3">
              <div className="mb-2 font-semibold">Shortages and losses in this period (tap one to start a deduction — you and the director decide)</div>
              {sugg.cash_shortages.map((c, i) => <button key={'c' + i} className="mb-1 block w-full rounded bg-slate-600 p-2 text-left" onClick={() => suggest(c.staff_id, c.name, `cash short on ${c.date}`, Number(c.short))}>
                {c.name} · cash short {kes(c.short)} on {c.date}{c.note ? ` · ${c.note}` : ''}</button>)}
              {sugg.stock_losses.map((s, i) => <button key={'s' + i} className="mb-1 block w-full rounded bg-slate-600 p-2 text-left" onClick={() => suggest(s.staff_id, s.name, `${s.type} of ${s.product} on ${s.date}`, 0)}>
                {s.name} · {s.type} · {s.qty} × {s.product} on {s.date}{s.note ? ` · ${s.note}` : ''}</button>)}
            </div>)}
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-600 pt-3">
            <input className={input + ' w-[32rem]'} placeholder="Note to the director (optional)" value={notes} onChange={e => setNotes(e.target.value)} />
            <Btn disabled={busy || items.length === 0} onClick={() => call('submit_report', { p_id: rep.id, p_notes: notes || null }, 'Submitted to the director.')}>Submit to director</Btn>
          </div>
        </div>)}

      {rep.status === 'submitted' && reviewer && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-800 p-4">
          <input className={input + ' w-[32rem]'} placeholder="Note (required to return)" value={notes} onChange={e => setNotes(e.target.value)} />
          <Btn disabled={busy} onClick={() => call('sign_off_report', { p_id: rep.id, p_approve: true, p_notes: notes || null }, 'Report signed off.')}>Sign off</Btn>
          <Btn kind="danger" disabled={busy} onClick={() => call('sign_off_report', { p_id: rep.id, p_approve: false, p_notes: notes }, 'Returned to the accountant.')}>Return</Btn>
        </div>)}

      {rep.status === 'signed_off' && can(profile, 'supplier.pay') && (
        <div className="space-y-2 rounded-xl bg-slate-800 p-4">
          <div className="text-xl font-bold">Record payments you have made (big suppliers)</div>
          {sups.filter(s => s.is_big && Number(s.owed) > 0).map(s => (
            <div key={s.supplier_id} className="rounded-lg bg-slate-700 p-2">
              <div className="flex flex-wrap items-center gap-4 text-lg"><b className="w-64">{s.name}</b><span>Owed {kes(s.owed)}</span>
                <Btn className="ml-auto !h-10 !text-base" onClick={() => setPay({ sup: s.supplier_id, amount: String(s.owed), method: 'bank', ref: '' })}>Record payment</Btn></div>
              {pay?.sup === s.supplier_id && (
                <div className="mt-2 flex flex-wrap gap-3">
                  <input className={input + ' w-40'} type="number" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} />
                  <select className={input} value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })}><option value="bank">Bank</option><option value="mpesa">M-Pesa</option><option value="cheque">Cheque</option><option value="cash">Cash</option></select>
                  <input className={input + ' w-64'} placeholder="Reference" value={pay.ref} onChange={e => setPay({ ...pay, ref: e.target.value })} />
                  <Btn className="!h-12" disabled={busy || !pay.amount} onClick={() => call('record_supplier_payment', { p_supplier: s.supplier_id, p_amount: Number(pay.amount), p_method: pay.method, p_ref: pay.ref || null, p_report: rep.id, p_key: payKey.current },
                    'Payment recorded.', () => { setPay(null); payKey.current = uid() })}>Confirm</Btn>
                </div>)}
            </div>))}
          {sups.filter(s => s.is_big && Number(s.owed) > 0).length === 0 && <div className="text-slate-300">No big supplier has an unpaid balance.</div>}
        </div>)}
    </div>
  )
}
