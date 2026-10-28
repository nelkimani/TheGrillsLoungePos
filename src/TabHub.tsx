import { useCallback, useEffect, useState } from 'react'
import { supabase, Profile, can } from './supabase'
import { Btn } from './ui'
import { kes } from './lib'
import { BillLine, CardRow, Slip } from './Receipt'

const STATUS_TEXT: Record<string, string> = {
  new: 'Sent', accepted: 'Accepted', preparing: 'Preparing', ready: 'READY', served: 'Served',
}

export default function TabHub({ profile, tab, onOrder, onPay, onBack }:
  { profile: Profile; tab: { id: string; label: string }; onOrder: () => void; onPay: () => void; onBack: () => void }) {
  const [card, setCard] = useState<CardRow | null>(null)
  const [lines, setLines] = useState<BillLine[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showBill, setShowBill] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([
      supabase.from('tab_cards').select('*').eq('tab_id', tab.id).maybeSingle(),
      supabase.from('tab_bill_lines').select('*').eq('tab_id', tab.id).order('created_at'),
    ])
    setCard((c.data as CardRow | null) ?? null)
    if (l.data) setLines(l.data as BillLine[])
    setLoaded(true)
  }, [tab.id])
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const bill = async () => {
    if (busy) return
    setBusy(true); setErr('')
    const { error } = await supabase.rpc('request_bill', { p_tab: tab.id })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setShowBill(true); load()
  }
  const serveMine = async () => {
    if (busy) return
    setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('serve_my_bar_items', { p_tab: tab.id })
    setBusy(false)
    if (error) { setErr(error.message); return }
    if (!data) setErr('No bar items waiting to be served on this tab.')
    load()
  }
  const close = async () => {
    if (busy) return
    setBusy(true); setErr('')
    const { error } = await supabase.rpc('close_tab', { p_tab: tab.id })
    setBusy(false)
    if (error) { setErr(error.message); return }
    onBack()
  }

  const all = lines.reduce((s, l) => s + Number(l.line_total), 0)
  const balance = Number(card?.balance ?? 0)
  const pending = Number(card?.pending_total ?? 0)
  const nothingOrdered = lines.length === 0
  const canClose = loaded && (nothingOrdered || (balance === 0 && pending === 0))

  if (showBill) {
    return (
      <div className="flex flex-col items-center gap-4 p-4">
        <div className="text-2xl font-bold">Interim bill — NOT A RECEIPT</div>
        <Slip heading="Interim bill" notReceipt label={tab.label} waiter={card?.waiter_name ?? profile.full_name} lines={lines} total={all}>
          <div className="mt-1 flex justify-between"><span>Paid so far</span><span>{kes(card?.paid)}</span></div>
          <div className="flex justify-between font-bold"><span>Still to pay</span><span>{kes(all - Number(card?.paid ?? 0))}</span></div>
        </Slip>
        <div className="flex gap-3">
          <Btn kind="ghost" onClick={() => setShowBill(false)}>Back</Btn>
          <Btn onClick={() => window.print()}>Print bill</Btn>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-6 p-4 lg:grid-cols-[1fr_21rem]">
      <div>
        <div className="mb-3 flex items-center gap-3">
          <Btn kind="ghost" onClick={onBack} className="!h-[3.75rem]">← Tables</Btn>
          <h2 className="text-3xl font-bold">{tab.label}</h2>
          {card && <span className="rounded bg-slate-700 px-3 py-1 text-lg">{card.status.replace('_', ' ')}</span>}
        </div>
        {!card && loaded && !nothingOrdered && <div className="mb-3 rounded-lg bg-slate-700 p-3 text-xl">This tab is closed.</div>}
        <div className="space-y-2">
          {lines.map(l => (
            <div key={l.item_id} className={`flex items-center gap-3 rounded-lg p-2 ${l.status === 'ready' ? 'bg-green-800' : 'bg-slate-800'}`}>
              <div className="flex-1 text-xl">{Number(l.qty)} × {l.product_name}
                <div className="text-sm text-slate-400">{STATUS_TEXT[l.status] ?? l.status}</div></div>
              <div className="text-xl tabular-nums">{kes(l.line_total)}</div>
            </div>
          ))}
          {nothingOrdered && loaded && <div className="text-xl text-slate-400">Nothing ordered yet.</div>}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="rounded-xl bg-slate-800 p-4">
          <div className="flex justify-between text-lg"><span>Served</span><span>{kes(card?.bill_total)}</span></div>
          <div className="flex justify-between text-lg text-slate-300"><span>Not yet served</span><span>{kes(pending)}</span></div>
          <div className="flex justify-between text-lg"><span>Paid</span><span>{kes(card?.paid)}</span></div>
          <div className="mt-1 flex justify-between text-3xl font-bold"><span>Balance</span><span>{kes(balance)}</span></div>
        </div>
        {err && <div className="rounded-lg bg-red-700 p-3 font-semibold">{err}</div>}
        <Btn onClick={onOrder} disabled={!card && !nothingOrdered}>Add items</Btn>
        {can(profile, 'station.bar') && card?.waiter_id === profile.id && pending > 0 &&
          <Btn onClick={serveMine} disabled={busy}>Serve my drinks</Btn>}
        <Btn kind="ghost" onClick={bill} disabled={busy || nothingOrdered}>Interim bill</Btn>
        {can(profile, 'payment.record') && <Btn onClick={onPay} disabled={balance <= 0}>Record payment</Btn>}
        <Btn kind="ghost" onClick={close} disabled={busy || !canClose}>Close tab</Btn>
        {!canClose && loaded && !nothingOrdered && (
          <div className="text-base text-slate-400">A tab closes only when the balance is zero and every item is served.</div>
        )}
      </div>
    </div>
  )
}
