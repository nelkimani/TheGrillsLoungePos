import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Btn } from './ui'

type Item = {
  id: string; kind: string; reason: string; status: string; created_at: string; requester_name: string
  payload: { product_name?: string; qty?: number; type?: string } | null
}
const KIND: Record<string, string> = { stock_out: 'Stock out' }

export default function Approvals({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase.from('approvals_inbox').select('*').order('created_at', { ascending: false }).limit(50)
    if (data) setItems(data as Item[])
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, [load])

  const decide = async (id: string, approve: boolean) => {
    if (busy) return
    setBusy(id); setMsg('')
    const { error } = await supabase.rpc('decide_approval', { p_id: id, p_approve: approve })
    if (error) setMsg(error.message)
    setBusy(null); load()
  }

  const pending = items.filter(i => i.status === 'pending')
  const decided = items.filter(i => i.status !== 'pending')
  const card = (i: Item, actions: boolean) => (
    <div key={i.id} className="rounded-xl bg-slate-800 p-4">
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-bold">{KIND[i.kind] ?? i.kind}</span>
        <span className="text-lg text-slate-300">{i.payload?.type?.replace('_', ' ')}</span>
        <span className="ml-auto text-base text-slate-400">{new Date(i.created_at).toLocaleString('en-KE')}</span>
      </div>
      <div className="text-xl">{i.payload?.qty} × {i.payload?.product_name}</div>
      <div className="text-lg text-slate-300">Requested by {i.requester_name} · Reason: {i.reason}</div>
      {actions
        ? <div className="mt-3 flex gap-3">
            <Btn onClick={() => decide(i.id, true)} disabled={busy === i.id}>Approve</Btn>
            <Btn kind="danger" onClick={() => decide(i.id, false)} disabled={busy === i.id}>REJECT</Btn>
          </div>
        : <div className="mt-1 text-lg font-semibold">{i.status.toUpperCase()}</div>}
    </div>
  )

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="mr-auto text-3xl font-bold">Approvals ({pending.length} waiting)</h2>
        <Btn kind="ghost" onClick={onDone}>Home</Btn>
      </div>
      {msg && <div className="mb-3 rounded-lg bg-red-700 p-3 text-lg font-semibold">{msg}</div>}
      <div className="space-y-3">
        {pending.map(i => card(i, true))}
        {pending.length === 0 && <div className="text-xl text-slate-400">Nothing waiting for approval.</div>}
        {decided.length > 0 && <div className="pt-4 text-lg uppercase text-slate-400">Recent decisions</div>}
        {decided.map(i => card(i, false))}
      </div>
    </div>
  )
}
