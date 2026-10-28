// Terminal PIN login. Verifies staff_no + 6-digit PIN with the service role, then returns
// a one-time token the browser exchanges for a real session as that person.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json()
    const staff_no = String(body.staff_no ?? '').toUpperCase()   // IDs are stored upper-case
    const { pin, terminal } = body
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(staff_no ?? '') || !/^[0-9]{6}$/.test(pin ?? ''))
      return json({ error: 'Invalid staff ID or PIN' }, 400)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: staffId, error } = await admin.rpc('verify_staff_pin', {
      p_staff_no: staff_no, p_pin: pin, p_terminal: terminal ?? 'UNKNOWN',
    })
    // Same message for every failure so IDs cannot be probed; lock message passes through.
    if (error) return json({ error: error.message.startsWith('locked') ? error.message : 'Invalid staff ID or PIN' }, 401)

    const { data: u, error: uerr } = await admin.auth.admin.getUserById(staffId)
    if (uerr || !u.user?.email) return json({ error: 'Account not ready' }, 500)
    const { data: link, error: lerr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.user.email })
    if (lerr) return json({ error: 'Could not start session' }, 500)
    return json({ token_hash: link.properties.hashed_token })
  } catch (_e) {
    return json({ error: 'Bad request' }, 400)
  }
})
