import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn } from './ui'
import { kes, uid } from './lib'

type Tab = 'cash' | 'mpesa' | 'close'
type CashRow = { waiter_id: string; full_name: string; staff_no: string; business_date: string; expected_cash: number
  declared: number | null; actual: number | null; received: boolean; variance: number | null; received_by_name: string | null; notes: string | null }
type MpesaRow = { payment_id: string; txn_time: string; code: string; amount: number; waiter_name: string
  verification: string; matched_ref: string | null; discrepancy_reason: string | null; verified_by_name: string | null }
type Summary = Record<string, number | string | null>
type Exc = { kind: string; detail: string; amount: number | null }

// Trading day rolls over at 05:00 Nairobi (UTC+3) = 02:00 UTC
const today = () => new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 10)
const input = 'h-12 rounded-lg border border-slate-500 bg-slate-900 px-3 text-lg'

export default function Recon({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [tab, setTab] = useState<Tab>('cash')
  const [date, setDate] = useState(today())
  const [msg, setMsg] = useState('')
  const [bad, setBad] = useState(false)
  const flash = (m: string, isBad = false) => { setMsg(m); setBad(isBad) }

  const tabBtn = (t: Tab, n: string) => (
    <button key={t} onClick={() => { setTab(t); setMsg('') }}
      className={`h-14 rounded-xl px-6 text-xl font-semibold ${tab === t ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{n}</button>)

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="mr-4 text-3xl font-bold">Reconciliation</h2>
        {tabBtn('cash', 'Cash')}{tabBtn('mpesa', 'M-Pesa')}{tabBtn('close', 'Day close')}
        <input type="date" className={input + ' ml-auto'} value={date} onChange={e => setDate(e.target.value)} />
        <Btn kind="ghost" onClick={onDone} className="!h-12">Home</Btn>
      </div>
      {msg && <div className={`mb-3 rounded-lg p-3 text-lg font-semibold ${bad ? 'bg-red-700' : 'bg-green-700'}`}>{msg}</div>}
      {tab === 'cash' && <Cash date={date} profile={profile} flash={flash} />}
      {tab === 'mpesa' && <Mpesa date={date} profile={profile} flash={flash} />}
      {tab === 'close' && <Close date={date} profile={profile} flash={flash} />}
    </div>
  )
}

type P = { date: string; profile: Profile; flash: (m: string, bad?: boolean) => void }

function Cash({ date, profile, flash }: P) {
  const [rows, setRows] = useState<CashRow[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [actual, setActual] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const key = useRef(uid())
  const load = useCallback(async () => {
    const { data } = await supabase.from('recon_cash').select('*').eq('business_date', date).order('full_name')
    setRows((data ?? []) as CashRow[])
  }, [date])
  useEffect(() => { load() }, [load])

  const receive = async (r: CashRow) => {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.rpc('receive_cash', { p_waiter: r.waiter_id, p_date: date, p_actual: Number(actual), p_notes: note || null, p_key: key.current })
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash(`Cash received from ${r.full_name}.`); setSel(null); setActual(''); setNote(''); key.current = uid(); load()
  }
  const allowed = can(profile, 'handover.receive')

  return (
    <div className="space-y-2">
      {rows.length === 0 && <div className="text-xl text-slate-400">No cash for this day.</div>}
      {rows.map(r => {
        const v = r.variance
        return (
          <div key={r.waiter_id} className="rounded-xl bg-slate-800 p-3">
            <div className="flex flex-wrap items-center gap-4 text-lg">
              <div className="w-48 text-xl font-semibold">{r.full_name}<span className="ml-2 text-sm text-slate-400">{r.staff_no}</span></div>
              <div className="w-40">Expected <b>{kes(r.expected_cash)}</b></div>
              <div className="w-40">Declared <b>{r.declared == null ? '—' : kes(r.declared)}</b></div>
              <div className="w-40">Received <b>{r.received ? kes(r.actual) : '—'}</b></div>
              {r.received && v !== null && (
                <span className={`rounded px-2 py-1 font-bold ${v === 0 ? 'bg-green-700' : v > 0 ? 'bg-red-700' : 'bg-amber-600 text-on-accent'}`}>
                  {v === 0 ? 'OK' : v > 0 ? `SHORT ${kes(v)}` : `SURPLUS ${kes(-v)}`}</span>)}
              {!r.received && allowed && <Btn className="ml-auto !h-12" onClick={() => { setSel(r.waiter_id); setActual(''); setNote('') }}>Receive cash</Btn>}
            </div>
            {r.notes && <div className="mt-1 text-slate-300">Note: {r.notes}</div>}
            {sel === r.waiter_id && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input className={input + ' w-48'} type="number" min="0" placeholder="Cash counted" value={actual} onChange={e => setActual(e.target.value)} />
                <input className={input + ' w-96'} placeholder="Reason (required if different from expected)" value={note} onChange={e => setNote(e.target.value)} />
                <Btn className="!h-12" onClick={() => receive(r)} disabled={busy || actual === ''}>{busy ? 'Saving…' : 'Confirm'}</Btn>
                <Btn kind="ghost" className="!h-12" onClick={() => setSel(null)}>Cancel</Btn>
              </div>)}
          </div>)
      })}
    </div>
  )
}

function Mpesa({ date, profile, flash }: P) {
  const [rows, setRows] = useState<MpesaRow[]>([])
  const [filter, setFilter] = useState<'all' | 'recorded' | 'verified' | 'disputed'>('recorded')
  const [sel, setSel] = useState<{ id: string; mode: 'verified' | 'disputed' } | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const { data } = await supabase.from('recon_mpesa').select('*').eq('business_date', date).order('txn_time')
    setRows((data ?? []) as MpesaRow[])
  }, [date])
  useEffect(() => { load() }, [load])

  const act = async () => {
    if (!sel || busy) return
    setBusy(true)
    const { error } = await supabase.rpc('verify_mpesa', {
      p_payment: sel.id, p_status: sel.mode, p_ref: sel.mode === 'verified' ? text || null : null, p_reason: sel.mode === 'disputed' ? text : null })
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash(sel.mode === 'verified' ? 'Verified.' : 'Marked as disputed.'); setSel(null); setText(''); load()
  }
  const shown = rows.filter(r => filter === 'all' || r.verification === filter)
  const total = (s: string) => rows.filter(r => r.verification === s).reduce((a, r) => a + Number(r.amount), 0)
  const allowed = can(profile, 'mpesa.verify')
  const chip = (f: typeof filter, n: string) => (
    <button key={f} onClick={() => setFilter(f)} className={`h-12 rounded-lg px-4 text-lg font-semibold ${filter === f ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{n}</button>)
  const badge = (v: string) => v === 'verified' ? 'bg-green-700' : v === 'disputed' ? 'bg-red-700' : 'bg-slate-600'

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {chip('recorded', `Awaiting (${kes(total('recorded'))})`)}{chip('verified', `Verified (${kes(total('verified'))})`)}
        {chip('disputed', `Disputed (${kes(total('disputed'))})`)}{chip('all', 'All')}
      </div>
      <div className="space-y-2">
        {shown.length === 0 && <div className="text-xl text-slate-400">Nothing here.</div>}
        {shown.map(r => (
          <div key={r.payment_id} className="rounded-xl bg-slate-800 p-3">
            <div className="flex flex-wrap items-center gap-4 text-lg">
              <div className="w-40 font-mono text-xl font-bold">{r.code}</div>
              <div className="w-36 text-xl font-semibold">{kes(r.amount)}</div>
              <div className="w-44">{r.waiter_name}</div>
              <div className="w-24 text-slate-300">{new Date(r.txn_time).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</div>
              <span className={`rounded px-2 py-1 font-semibold ${badge(r.verification)}`}>{r.verification === 'recorded' ? 'Awaiting verification' : r.verification}</span>
              {allowed && r.verification !== 'verified' && (
                <span className="ml-auto flex gap-2">
                  <Btn className="!h-12" onClick={() => { setSel({ id: r.payment_id, mode: 'verified' }); setText('') }}>Verify</Btn>
                  <Btn kind="danger" className="!h-12" onClick={() => { setSel({ id: r.payment_id, mode: 'disputed' }); setText('') }}>Dispute</Btn>
                </span>)}
            </div>
            {(r.matched_ref || r.discrepancy_reason) && <div className="mt-1 text-slate-300">
              {r.matched_ref && <>Statement ref: {r.matched_ref} </>}{r.discrepancy_reason && <>Reason: {r.discrepancy_reason}</>}
              {r.verified_by_name && <> · by {r.verified_by_name}</>}</div>}
            {sel?.id === r.payment_id && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input className={input + ' w-96'} value={text} onChange={e => setText(e.target.value)}
                  placeholder={sel.mode === 'verified' ? 'Statement reference (optional)' : 'Why is it disputed? (required)'} />
                <Btn className="!h-12" onClick={act} disabled={busy || (sel.mode === 'disputed' && !text.trim())}>{busy ? 'Saving…' : sel.mode === 'verified' ? 'Confirm verified' : 'Confirm dispute'}</Btn>
                <Btn kind="ghost" className="!h-12" onClick={() => setSel(null)}>Cancel</Btn>
              </div>)}
          </div>))}
      </div>
    </div>
  )
}

function Close({ date, profile, flash }: P) {
  const [s, setS] = useState<Summary | null>(null)
  const [exc, setExc] = useState<Exc[]>([])
  const [spent, setSpent] = useState(0)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([supabase.rpc('day_summary', { p_date: date }), supabase.rpc('day_exceptions', { p_date: date })])
    if (a.error) flash(a.error.message, true); else setS(a.data as Summary)
    setExc((b.data ?? []) as Exc[])
    const x = await supabase.from('expenses_v').select('amount, voided').eq('business_date', date)
    setSpent(((x.data ?? []) as { amount: number; voided: boolean }[]).filter(r => !r.voided).reduce((t, r) => t + Number(r.amount), 0))
  }, [date, flash])
  useEffect(() => { load() }, [load])

  const run = async (fn: string, args: Record<string, unknown>, ok: string) => {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash(ok); setNotes(''); load()
  }
  if (!s) return <div className="text-xl text-slate-400">Loading…</div>
  const n = (k: string) => Number(s[k] ?? 0)
  const status = (s.close_status as string | null) ?? 'not closed'
  const open = n('cash_unreceived') + n('mpesa_unverified_count') + n('open_tabs')
  const row = (label: string, v: string, warn = false) => (
    <div className="flex justify-between border-b border-slate-700 py-2 text-xl"><span>{label}</span><b className={warn ? 'text-red-400' : ''}>{v}</b></div>)

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-xl bg-slate-800 p-4">
        <div className="mb-2 flex items-center gap-3 text-2xl font-bold">Day {date}
          <span className="rounded bg-slate-600 px-3 py-1 text-lg">{status}</span></div>
        {row('Sales (served items)', kes(n('sales_total')))}
        {row('Cash expected', kes(n('cash_expected')))}
        {row('Cash received', kes(n('cash_received')))}
        {row('Cash paid out as expenses', kes(spent))}
        {row('Cash to bank (received − expenses)', kes(n('cash_received') - spent))}
        {row('Cash variance (+ short)', kes(n('cash_variance')), n('cash_variance') !== 0)}
        {row('Cash not yet received', String(n('cash_unreceived')), n('cash_unreceived') > 0)}
        {row('M-Pesa total', kes(n('mpesa_total')))}
        {row('M-Pesa verified', kes(n('mpesa_verified')))}
        {row('M-Pesa disputed', kes(n('mpesa_disputed')), n('mpesa_disputed') > 0)}
        {row('M-Pesa not verified', `${kes(n('mpesa_unverified'))} (${n('mpesa_unverified_count')})`, n('mpesa_unverified_count') > 0)}
        {row('Open tabs', `${n('open_tabs')} · ${kes(n('open_tabs_balance'))}`, n('open_tabs') > 0)}
        {row('Stock count variances', String(n('count_variances')), n('count_variances') > 0)}
        {row('Approvals pending', String(n('pending_approvals')), n('pending_approvals') > 0)}
        {s.close_submitted_by && <div className="mt-2 text-slate-300">Submitted by {String(s.close_submitted_by)}{s.close_notes ? ` — ${String(s.close_notes)}` : ''}</div>}

        {status !== 'approved' && (
          <div className="mt-4 space-y-3">
            <input className={input + ' w-full'} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder={open > 0 ? 'Reason for closing with open items / decision note' : 'Note (optional)'} />
            <div className="flex flex-wrap gap-3">
              {can(profile, 'close.submit') && (
                <Btn disabled={busy} onClick={() => run('submit_daily_close', { p_date: date, p_notes: notes || null }, open > 0 ? 'Submitted as PROVISIONAL.' : 'Day submitted for approval.')}>
                  {status === 'returned' || status === 'submitted' || status === 'provisional' ? 'Resubmit close' : 'Submit day close'}</Btn>)}
              {can(profile, 'close.approve') && s.close_id && (status === 'submitted' || status === 'provisional') && (<>
                <Btn disabled={busy} onClick={() => run('approve_daily_close', { p_id: s.close_id, p_approve: true, p_notes: notes || null }, 'Day approved and locked.')}>Approve</Btn>
                <Btn kind="danger" disabled={busy} onClick={() => run('approve_daily_close', { p_id: s.close_id, p_approve: false, p_notes: notes || null }, 'Returned to the accountant.')}>Return</Btn></>)}
            </div>
          </div>)}
        {status === 'approved' && <div className="mt-4 rounded-lg bg-green-800 p-3 text-lg font-semibold">This day is approved and locked.</div>}
      </div>
      <div className="rounded-xl bg-slate-800 p-4">
        <div className="mb-2 text-2xl font-bold">Exceptions ({exc.length})</div>
        {exc.length === 0 && <div className="text-xl text-slate-400">None.</div>}
        <div className="space-y-2">
          {exc.map((e, i) => (
            <div key={i} className="rounded-lg bg-slate-700 p-2">
              <div className="flex justify-between text-lg font-semibold"><span>{e.kind}</span>{e.amount !== null && <span>{kes(e.amount)}</span>}</div>
              <div className="text-slate-300">{e.detail}</div>
            </div>))}
        </div>
      </div>
    </div>
  )
}
