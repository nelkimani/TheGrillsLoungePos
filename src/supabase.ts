import { createClient } from '@supabase/supabase-js'

// Which device this is (OFFICE, T1, T2, T3). Decided in index.html before the app starts:
// open the site once as  https://your-site/?t=T2  and that browser remembers it.
export const TERMINAL_CODE: string =
  document.documentElement.getAttribute('data-terminal') || import.meta.env.VITE_TERMINAL_CODE || 'OFFICE'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  // Terminals must not keep a person signed in across a browser restart.
  { auth: { persistSession: TERMINAL_CODE === 'OFFICE', autoRefreshToken: true } },
)

export type Profile = {
  id: string; staff_no: string; full_name: string; is_captain: boolean
  roles: string[]; permissions: string[]
}

export const can = (p: Profile | null, perm: string) => !!p?.permissions.includes(perm)
