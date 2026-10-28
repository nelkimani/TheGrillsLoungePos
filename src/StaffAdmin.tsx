import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Btn } from './ui'
import { promptDialog } from './feedback'

type Row = { id: string; staff_no: string; full_name: string; is_captain: boolean; active: boolean; roles: string[]; has_pin: boolean }
const ROLES = [
  ['waiter', 'Waiter'], ['bartender', 'Bartender'], ['head_chef', 'Head chef'],
  ['choma', 'Nyama choma attendant'], ['accountant', 'Accountant'], ['manager', 'Manager'], ['director', 'Director'],
]

async function adminCall(body: object): Promise<{ ok?: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('staff-admin', { body })
  if (error) {
    try { const b = await (error as any).context.json(); return { error: b.error ?? error.message } } catch { return { error: error.message } }
  }
  return data
}

export default function StaffAdmin() {
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ staff_no: '', full_name: '', role: 'waiter', is_captain: false, pin: '', email: '' })

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_staff')
    if (error) setMsg(error.message); else setRows(data as Row[])
  }, [])
  useEffect(() => { load() }, [load])

  const office = f.role === 'manager' || f.role === 'accountant' || f.role === 'director'
  const create = async () => {
    if (busy) return
    setBusy(true); setMsg('')
    const r = await adminCall({ action: 'create', ...f, email: office ? f.email : '' })
    if (r.error) setMsg(r.error)
    else { setMsg(`Added ${f.full_name}.`); setF({ ...f, staff_no: '', full_name: '', pin: '', email: '', is_captain: false }); load() }
    setBusy(false)
  }
  const resetPin = async (id: string, name: string) => {
    const pin = await promptDialog({ title: `New PIN for ${name}`, message: 'Enter 6 digits.', digits: 6, confirmText: 'Set PIN' })
    if (!pin) return
    const r = await adminCall({ action: 'set_pin', staff_id: id, pin })
    setMsg(r.error ?? `PIN updated for ${name}.`); load()
  }
  const toggle = async (r: Row) => {
    const { error } = await supabase.rpc('set_staff_active', { p_staff: r.id, p_active: !r.active })
    setMsg(error ? error.message : ''); load()
  }

  const input = 'h-12 rounded-lg bg-slate-800 border border-slate-600 px-3 text-lg'
  return (
    <div className="p-6 grid gap-8 lg:grid-cols-[22rem_1fr]">
      <div className="flex flex-col gap-3">
        <h2 className="text-2xl font-bold">Add staff</h2>
        <input className={input} placeholder="Staff ID (e.g. W001)" value={f.staff_no} onChange={e => setF({ ...f, staff_no: e.target.value })} />
        <input className={input} placeholder="Full name" value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} />
        <select className={input} value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
          {ROLES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select>
        {office && <input className={input} type="email" placeholder="Email (for office login)" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />}
        {f.role === 'waiter' && (
          <label className="flex items-center gap-3 text-lg">
            <input type="checkbox" className="h-6 w-6" checked={f.is_captain} onChange={e => setF({ ...f, is_captain: e.target.checked })} />
            Captain (can order for other waiters' tables)
          </label>
        )}
        <input className={input} inputMode="numeric" maxLength={6} placeholder="6-digit PIN" value={f.pin}
               onChange={e => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} />
        <Btn onClick={create} disabled={busy || !f.staff_no || !f.full_name || f.pin.length !== 6}>Add staff member</Btn>
        {office && <p className="text-sm text-slate-400">Manager/accountant sign in with a password on the office computer. Set it in Supabase → Authentication → Users (use Send password recovery).</p>}
        {msg && <div className="rounded-lg bg-slate-700 p-3">{msg}</div>}
      </div>
      <div>
        <h2 className="mb-3 text-2xl font-bold">Staff ({rows.length})</h2>
        <table className="w-full text-left text-lg">
          <thead className="text-slate-400"><tr><th>ID</th><th>Name</th><th>Role</th><th>PIN</th><th></th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={`border-t border-slate-700 ${r.active ? '' : 'opacity-50'}`}>
                <td className="py-2">{r.staff_no}</td>
                <td>{r.full_name}{r.is_captain ? ' (captain)' : ''}</td>
                <td>{r.roles.join(', ')}</td>
                <td>{r.has_pin ? 'Set' : 'None'}</td>
                <td className="flex gap-2 py-1">
                  <button className="h-12 rounded-lg bg-slate-700 px-3" onClick={() => resetPin(r.id, r.full_name)}>Reset PIN</button>
                  <button className="h-12 rounded-lg bg-slate-700 px-3" onClick={() => toggle(r)}>{r.active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
