import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, TERMINAL_CODE, Profile, can } from './supabase'
import { AlphaKeys, Btn } from './ui'
import { CartLine, Draft, LOCK_AFTER_SEND, clearDraft, isNetworkError, kes, listNotSent, loadDraft, saveDraft, uid } from './lib'
import TabHub from './TabHub'
import Pay from './Pay'

type Table = { id: string; number: string; label: string | null }
type Card = {
  tab_id: string; table_number: string | null; customer_name: string | null; waiter_id: string
  waiter_name: string; status: string; bill_total: number; paid: number; balance: number; pending_total: number
}
type Product = { id: string; name: string; selling_price: number; station: string; category: { name: string } | null }
type ActiveTab = { id: string; label: string }
type TabItem = { item_id: string; product_name: string; qty: number; status: string }

const STATUS_TEXT: Record<string, string> = {
  new: 'Sent', accepted: 'Accepted', preparing: 'Preparing', ready: 'READY – collect', served: 'Served',
}

export default function Waiter({ profile, onDone, onLock }: { profile: Profile; onDone: () => void; onLock: () => void }) {
  const [tables, setTables] = useState<Table[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [active, setActive] = useState<ActiveTab | null>(null)
  const [screen, setScreen] = useState<'order' | 'hub' | 'pay'>('order')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [taken, setTaken] = useState<{ table_number: string | number; tab_id: string | null; waiter_id: string | null; waiter_name: string | null }[]>([])
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const load = useCallback(async () => {
    const [t, c, p, ts] = await Promise.all([
      supabase.from('floor_tables').select('id, number, label'),
      supabase.from('tab_cards').select('*'),
      supabase.from('products').select('id, name, selling_price, station, category:categories(name)')
        .eq('available', true).not('selling_price', 'is', null).order('name'),
      supabase.from('table_status').select('table_number, tab_id, waiter_id, waiter_name'),
    ])
    if (ts.data) setTaken(ts.data as { table_number: string | number; tab_id: string | null; waiter_id: string | null; waiter_name: string | null }[])
    if (t.data) setTables((t.data as Table[]).sort((a, b) => Number(a.number) - Number(b.number)))
    if (c.data) setCards(c.data as Card[])
    if (p.data) setProducts(p.data as unknown as Product[])
  }, [])

  useEffect(() => {
    load()
    const ch = supabase.channel('waiter-' + uid())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tabs' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, load)
      .subscribe()
    const poll = setInterval(load, 15000)
    return () => { supabase.removeChannel(ch); clearInterval(poll) }
  }, [load])

  // Retry any NOT SENT orders for this person with their original idempotency key.
  const flushing = useRef(false)
  const flush = useCallback(async () => {
    if (flushing.current) return
    flushing.current = true
    for (const u of listNotSent(profile.id)) {
      const { error } = await supabase.rpc('submit_order', {
        p_tab: u.tab, p_items: u.draft.lines.map(l => ({ product_id: l.product_id, qty: l.qty })),
        p_terminal: TERMINAL_CODE, p_key: u.draft.key })
      if (!error) clearDraft(profile.id, u.tab)
      else if (!isNetworkError(error)) saveDraft(profile.id, u.tab, { ...u.draft, state: 'editing' })  // server refused: let the person fix it
    }
    flushing.current = false
    load()
  }, [profile.id, load])
  useEffect(() => {
    flush()
    const t = setInterval(flush, 8000)
    window.addEventListener('online', flush)
    return () => { clearInterval(t); window.removeEventListener('online', flush) }
  }, [flush])

  const openTable = async (t: Table) => {
    if (busy) return
    setErr('')
    const card = cards.find(c => c.table_number === t.number)
    const other = taken.find(x => x.table_number === t.number && x.tab_id && x.waiter_id !== profile.id)
    if (other && !card) { setErr(`Table ${t.number} is being served by ${other.waiter_name ?? 'another waiter'}.`); return }
    if (card) { setScreen('hub'); setActive({ id: card.tab_id, label: `Table ${t.number}` }); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('open_tab', { p_table: t.id, p_customer: null, p_key: uid() })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setScreen('order')
    setActive({ id: (data as { id: string }).id, label: `Table ${t.number}` })
    load()
  }
  const openNamed = async () => {
    if (busy || !name.trim()) return
    setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('open_tab', { p_table: null, p_customer: name.trim(), p_key: uid() })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setScreen('order')
    setActive({ id: (data as { id: string }).id, label: name.trim() })
    setNaming(false); setName(''); load()
  }

  if (active && screen === 'hub') {
    return <TabHub profile={profile} tab={active} onOrder={() => setScreen('order')} onPay={() => setScreen('pay')}
      onBack={() => { setActive(null); load() }} />
  }
  if (active && screen === 'pay') {
    return <Pay profile={profile} tab={active} onBack={() => setScreen('hub')}
      onDone={() => { setActive(null); load() }} />
  }
  if (active) {
    return <OrderScreen profile={profile} tab={active} products={products}
      onBack={() => { setScreen('hub'); load() }} onSent={() => {
        if (can(profile, 'station.bar')) { setScreen('hub'); load(); return }   // bartender: stay on the tab to serve, pay, close
        setActive(null); load(); LOCK_AFTER_SEND ? onLock() : onDone() }} />
  }

  if (naming) {
    return (
      <div className="flex flex-col items-center gap-4 p-6">
        <h2 className="text-3xl font-bold">Takeaway / named tab</h2>
        <div className="h-btn w-[min(40rem,100%)] rounded-xl border-2 border-amber-500 bg-slate-800 px-4 text-3xl leading-[var(--btn-h)]">
          {name || <span className="text-xl text-slate-500">Customer name</span>}
        </div>
        <AlphaKeys withSpace onKey={k => setName(n => (n + k).slice(0, 30))}
          onBack={() => setName(n => n.slice(0, -1))} onClear={() => setName('')} />
        {err && <div className="rounded-lg bg-red-700 p-3 text-lg font-semibold">{err}</div>}
        <div className="flex gap-3">
          <Btn kind="ghost" onClick={() => { setNaming(false); setName('') }}>Cancel</Btn>
          <Btn onClick={openNamed} disabled={busy || !name.trim()}>Open tab</Btn>
        </div>
      </div>
    )
  }

  const named = cards.filter(c => !c.table_number)
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="mr-auto text-3xl font-bold">Tables</h2>
        <Btn kind="ghost" onClick={onDone}>Home</Btn>
        <Btn onClick={() => setNaming(true)}>+ Takeaway / named tab</Btn>
      </div>
      {err && <div className="mb-3 rounded-lg bg-red-700 p-3 text-lg font-semibold">{err}</div>}
      <div className="grid-tables">
        {tables.map(t => {
          const c = cards.find(x => x.table_number === t.number)
          const mine = c?.waiter_id === profile.id
          const other = !c ? taken.find(x => x.table_number === t.number && x.tab_id) : undefined
          return (
            <button key={t.id} onClick={() => openTable(t)}
              className={`h-full rounded-xl p-3 text-left active:opacity-80 ${c ? (mine ? 'bg-amber-600 text-on-accent' : 'bg-slate-600') : other ? 'bg-slate-700 opacity-70' : 'bg-slate-800 border-2 border-slate-600'}`}>
              <div className="text-2xl font-bold">Table {t.number}</div>
              {c ? <div className="text-lg">{c.waiter_name} · {kes(c.balance + c.pending_total)}</div>
                 : other ? <div className="text-lg text-slate-300">In use · {other.waiter_name}</div>
                 : <div className="text-lg text-slate-400">Free</div>}
            </button>
          )
        })}
        {named.map(c => (
          <button key={c.tab_id} onClick={() => { setScreen('hub'); setActive({ id: c.tab_id, label: c.customer_name ?? 'Tab' }) }}
            className="h-full rounded-xl bg-amber-600 p-3 text-left text-on-accent active:opacity-80">
            <div className="truncate text-2xl font-bold">{c.customer_name}</div>
            <div className="text-lg">{c.waiter_name} · {kes(c.balance + c.pending_total)}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function OrderScreen({ profile, tab, products, onBack, onSent }:
  { profile: Profile; tab: ActiveTab; products: Product[]; onBack: () => void; onSent: () => void }) {
  const initial = useMemo(() => loadDraft(profile.id, tab.id), [profile.id, tab.id])
  const [lines, setLines] = useState<CartLine[]>(initial?.lines ?? [])
  const [state, setState] = useState<Draft['state']>(initial?.state ?? 'editing')
  const key = useRef(initial?.key ?? uid())
  const [cat, setCat] = useState('All')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [ticket, setTicket] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)
  const [items, setItems] = useState<TabItem[]>([])

  const cats = useMemo(() => ['All', ...Array.from(new Set(products.map(p => p.category?.name ?? 'Other')))], [products])
  const shown = products.filter(p => cat === 'All' || (p.category?.name ?? 'Other') === cat)
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0)

  const persist = (next: CartLine[], st: Draft['state'] = state) => {
    setLines(next)
    if (next.length === 0) clearDraft(profile.id, tab.id)
    else saveDraft(profile.id, tab.id, { key: key.current, lines: next, state: st })
  }
  const add = (p: Product) => {
    if (state === 'not_sent') return
    const i = lines.findIndex(l => l.product_id === p.id)
    persist(i >= 0 ? lines.map((l, j) => j === i ? { ...l, qty: l.qty + 1 } : l)
                   : [...lines, { product_id: p.id, name: p.name, price: Number(p.selling_price), qty: 1 }])
  }
  const step = (id: string, d: number) => {
    if (state === 'not_sent') return
    persist(lines.map(l => l.product_id === id ? { ...l, qty: l.qty + d } : l).filter(l => l.qty > 0))
  }

  const loadItems = useCallback(async () => {
    const { data } = await supabase.from('station_queue')
      .select('item_id, product_name, qty, status').eq('tab_id', tab.id).order('created_at')
    if (data) setItems(data as TabItem[])
  }, [tab.id])
  useEffect(() => { loadItems(); const t = setInterval(loadItems, 5000); return () => clearInterval(t) }, [loadItems])

  const markServed = async (id: string) => {
    const { error } = await supabase.rpc('update_item_status', { p_item: id, p_status: 'served' })
    if (error) setErr(error.message)
    loadItems()
  }

  const send = async () => {
    if (sending || lines.length === 0) return          // in-flight lock: double taps do nothing
    setSending(true); setErr('')
    const { data, error } = await supabase.rpc('submit_order', {
      p_tab: tab.id, p_items: lines.map(l => ({ product_id: l.product_id, qty: l.qty })),
      p_terminal: TERMINAL_CODE, p_key: key.current })
    if (error) {
      if (isNetworkError(error)) {
        saveDraft(profile.id, tab.id, { key: key.current, lines, state: 'not_sent' })
        setState('not_sent'); setSaved(true)
      } else setErr(error.message)
      setSending(false); return
    }
    clearDraft(profile.id, tab.id)
    setTicket((data as { ticket_no: number }).ticket_no)
    setTimeout(onSent, 2500)
  }

  if (ticket !== null) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-green-700 text-center">
        <div className="text-6xl font-bold">Order #{ticket} received</div>
        <div className="text-3xl">by Bar &amp; Kitchen · {tab.label}</div>
      </div>
    )
  }
  if (saved) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-red-800 text-center">
        <div className="text-6xl font-bold">NOT SENT</div>
        <div className="max-w-2xl text-2xl">No connection. The order is saved on this screen and will send by itself when the network is back. Do not re-enter it.</div>
        <Btn onClick={onSent}>OK</Btn>
      </div>
    )
  }

  const btn = 'h-[3.75rem] w-full rounded-xl px-3 text-left text-xl font-semibold'
  return (
    <div className="order-layout fill-screen">
      <div className="flex flex-col gap-2 overflow-y-auto">
        <Btn kind="ghost" onClick={onBack} className="!h-[3.75rem]">← Tables</Btn>
        {cats.map(c => (
          <button key={c} onClick={() => setCat(c)}
            className={`${btn} ${cat === c ? 'bg-amber-500 text-on-accent' : 'bg-slate-700'}`}>{c}</button>
        ))}
      </div>
      <div className="grid-products overflow-y-auto">
        {shown.map(p => (
          <button key={p.id} onClick={() => add(p)}
            className="rounded-xl bg-slate-700 p-2 text-left active:bg-slate-500">
            <div className="line-clamp-2 text-lg font-semibold leading-tight">{p.name}</div>
            <div className="text-amber-400">{kes(p.selling_price)}</div>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 overflow-hidden rounded-xl bg-slate-800 p-3">
        <div className="text-2xl font-bold">{tab.label}</div>
        {state === 'not_sent' && <div className="rounded bg-red-700 p-2 font-semibold">NOT SENT – waiting to retry</div>}
        <div className="flex-1 space-y-2 overflow-y-auto">
          {lines.map(l => (
            <div key={l.product_id} className="flex items-center gap-2">
              <div className="flex-1 text-lg leading-tight">{l.name}<div className="text-sm text-slate-400">{kes(l.price * l.qty)}</div></div>
              <button className="h-14 w-14 rounded-lg bg-slate-600 text-3xl" onClick={() => step(l.product_id, -1)}>−</button>
              <span className="w-8 text-center text-2xl">{l.qty}</span>
              <button className="h-14 w-14 rounded-lg bg-slate-600 text-3xl" onClick={() => step(l.product_id, 1)}>+</button>
            </div>
          ))}
          {items.length > 0 && <div className="border-t border-slate-600 pt-2 text-sm uppercase text-slate-400">On this tab</div>}
          {items.map(i => (
            <div key={i.item_id} className={`flex items-center gap-2 rounded p-1 ${i.status === 'ready' ? 'bg-green-800' : ''}`}>
              <div className="flex-1 text-base">{i.qty} × {i.product_name}<div className="text-sm text-slate-300">{STATUS_TEXT[i.status] ?? i.status}</div></div>
              {i.status === 'ready' && <button className="h-12 rounded-lg bg-green-600 px-3 font-semibold" onClick={() => markServed(i.item_id)}>Served</button>}
            </div>
          ))}
        </div>
        {err && <div className="rounded bg-red-700 p-2 font-semibold">{err}</div>}
        <div className="text-4xl font-bold">{kes(total)}</div>
        <Btn onClick={send} disabled={sending || lines.length === 0}>
          {sending ? 'Sending…' : state === 'not_sent' ? 'Retry send' : 'SEND ORDER'}
        </Btn>
      </div>
    </div>
  )
}
