import { useCallback, useEffect, useState } from 'react'
import { supabase, TERMINAL_CODE, Profile, can } from './supabase'
import { Btn } from './ui'
import { LATE_AMBER_MIN, LATE_RED_MIN, TERMINAL_NAMES, uid } from './lib'

type QItem = {
  item_id: string; order_id: string; ticket_no: number; table_number: string | null; customer_name: string | null
  waiter_name: string; product_name: string; station: string; qty: number; notes: string | null
  status: string; claimed_terminal: string | null; created_at: string
}
// Next action for each status. "new" is claimed atomically so two terminals cannot both take it.
const NEXT: Record<string, { label: string; to: string }> = {
  new: { label: 'Accept', to: 'claim' }, accepted: { label: 'Start', to: 'preparing' },
  preparing: { label: 'Ready', to: 'ready' }, ready: { label: 'Served', to: 'served' },
}
const LABEL: Record<string, string> = { kitchen: 'Kitchen', choma: 'Choma', bar: 'Bar' }

export default function Queue({ profile, stations, onDone }: { profile: Profile; stations: string[]; onDone: () => void }) {
  const [sel, setSel] = useState<string[]>(stations)
  const [items, setItems] = useState<QItem[]>([])
  const [msg, setMsg] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    const { data } = await supabase.from('station_queue').select('*').in('station', sel).order('created_at')
    if (data) setItems(data as QItem[])
  }, [sel])

  useEffect(() => {
    load()
    const ch = supabase.channel('queue-' + uid())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, load)
      .subscribe()
    const poll = setInterval(load, 10000)          // fallback if a realtime event is missed
    const tick = setInterval(() => setTick(x => x + 1), 15000)
    return () => { supabase.removeChannel(ch); clearInterval(poll); clearInterval(tick) }
  }, [load])

  const act = async (it: QItem) => {
    const a = NEXT[it.status]
    if (!a || busyId) return
    setBusyId(it.item_id); setMsg('')
    const { error } = a.to === 'claim'
      ? await supabase.rpc('claim_item', { p_item: it.item_id, p_terminal: TERMINAL_CODE })
      : await supabase.rpc('update_item_status', { p_item: it.item_id, p_status: a.to })
    if (error) setMsg(error.message === 'already claimed' ? 'Already taken at another screen' : error.message)
    await load()
    setBusyId(null)
  }

  // group by order (ticket)
  const orders = new Map<string, QItem[]>()
  items.forEach(i => orders.set(i.order_id, [...(orders.get(i.order_id) ?? []), i]))
  const mins = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 60000)

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="mr-auto text-3xl font-bold">{sel.map(s => LABEL[s] ?? s).join(' + ')} queue</h2>
        {stations.length > 1 && stations.map(s => (
          <Btn key={s} kind={sel.length === 1 && sel[0] === s ? 'primary' : 'ghost'} onClick={() => setSel([s])}>{LABEL[s]}</Btn>
        ))}
        {stations.length > 1 && <Btn kind={sel.length > 1 ? 'primary' : 'ghost'} onClick={() => setSel(stations)}>All</Btn>}
        <Btn kind="ghost" onClick={onDone}>Home</Btn>
      </div>
      {msg && <div className="mb-3 rounded-lg bg-red-700 p-3 text-lg font-semibold">{msg}</div>}
      {orders.size === 0 && <div className="mt-16 text-center text-3xl text-slate-400">No open orders</div>}
      <div className="grid-queue">
        {Array.from(orders.values()).map(group => {
          const first = group[0]
          const age = mins(group.reduce((m, i) => i.created_at < m ? i.created_at : m, first.created_at))
          const tone = age >= LATE_RED_MIN ? 'border-red-500 bg-red-950' : age >= LATE_AMBER_MIN ? 'border-amber-500 bg-amber-950' : 'border-slate-600 bg-slate-800'
          return (
            <div key={first.order_id} className={`rounded-xl border-4 p-3 ${tone} ${age >= LATE_RED_MIN ? 'animate-pulse' : ''}`}>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold">#{first.ticket_no}</span>
                <span className="text-xl">{first.table_number ? `Table ${first.table_number}` : first.customer_name}</span>
                <span className="ml-auto text-xl font-semibold tabular-nums">{age} min{age >= LATE_AMBER_MIN ? ' LATE' : ''}</span>
              </div>
              <div className="mb-2 text-slate-300">{first.waiter_name}</div>
              <div className="space-y-2">
                {group.map(i => {
                  const a = NEXT[i.status]
                  const elsewhere = !!i.claimed_terminal && i.claimed_terminal !== TERMINAL_CODE
                    && i.status !== 'new' && !can(profile, 'tab.view_all')
                  return (
                    <div key={i.item_id} className="flex items-center gap-2 rounded-lg bg-slate-900/60 p-2">
                      <div className="flex-1 text-xl leading-tight">{i.qty} × {i.product_name}
                        {i.notes && <div className="text-base text-amber-300">{i.notes}</div>}
                        <div className="text-sm text-slate-400">
                          {elsewhere ? `Being prepared at ${TERMINAL_NAMES[i.claimed_terminal!] ?? i.claimed_terminal}` : i.status.toUpperCase()}
                        </div>
                      </div>
                      {a && <button disabled={elsewhere || busyId === i.item_id} onClick={() => act(i)}
                        className="h-btn min-w-[6.5rem] rounded-xl bg-amber-500 px-3 text-xl font-semibold text-on-accent active:bg-amber-400 disabled:opacity-40">
                        {a.label}
                      </button>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
