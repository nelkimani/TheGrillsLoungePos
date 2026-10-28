// Manager-only staff creation. Creates the auth user (random password, never shown),
// the staff row, the role, and the hashed PIN. Permission is checked as the caller.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const ROLES = ['manager', 'accountant', 'director', 'waiter', 'head_chef', 'choma', 'bartender']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: allowed } = await caller.rpc('has_permission', { p: 'staff.manage' })
  if (allowed !== true) return json({ error: 'Not permitted' }, 403)

  try {
    const b = await req.json()
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (b.action === 'create') {
      const staff_no = String(b.staff_no ?? '').toUpperCase()
      const { full_name, role, is_captain, pin, email } = b
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(staff_no ?? '')) return json({ error: 'Staff ID: letters/numbers only' }, 400)
      if (!full_name?.trim()) return json({ error: 'Name required' }, 400)
      if (!ROLES.includes(role)) return json({ error: 'Unknown role' }, 400)
      if (!/^[0-9]{6}$/.test(pin ?? '')) return json({ error: 'PIN must be 6 digits' }, 400)

      // Terminal staff get an internal address; office staff (manager/accountant) can pass a real email.
      const loginEmail = email?.trim() || `${staff_no.toLowerCase()}@staff.grills.local`
      const password = crypto.randomUUID() + crypto.randomUUID()
      const { data: created, error: cerr } = await admin.auth.admin.createUser({
        email: loginEmail, password, email_confirm: true })
      if (cerr || !created.user) return json({ error: cerr?.message ?? 'Could not create user' }, 400)
      const id = created.user.id

      const rollback = async (msg: string) => { await admin.auth.admin.deleteUser(id); return json({ error: msg }, 400) }
      const { error: serr } = await admin.from('staff').insert({ id, staff_no, full_name: full_name.trim(), is_captain: !!is_captain })
      if (serr) return rollback(serr.message)
      const { error: rerr } = await admin.from('staff_roles').insert({ staff_id: id, role_code: role })
      if (rerr) { await admin.from('staff').delete().eq('id', id); return rollback(rerr.message) }
      const { error: perr } = await caller.rpc('set_staff_pin', { p_staff: id, p_pin: pin })
      if (perr) return json({ error: 'Staff created but PIN failed: ' + perr.message, id }, 400)
      return json({ ok: true, id })
    }

    if (b.action === 'set_pin') {
      const { error } = await caller.rpc('set_staff_pin', { p_staff: b.staff_id, p_pin: b.pin })
      return error ? json({ error: error.message }, 400) : json({ ok: true })
    }
    return json({ error: 'Unknown action' }, 400)
  } catch (_e) {
    return json({ error: 'Bad request' }, 400)
  }
})
