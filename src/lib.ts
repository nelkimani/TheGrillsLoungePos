export const TERMINAL_NAMES: Record<string, string> = {
  T1: 'Kitchen + Choma', T2: 'Bar A', T3: 'Bar B', OFFICE: 'Office',
}

export const kes = (n: number | null | undefined) =>
  `KES ${Number(n ?? 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`

export const uid = () => crypto.randomUUID()

// supabase-js returns an empty code when the request never reached the server
export const isNetworkError = (e: { code?: string } | null) => !!e && !e.code

// Late thresholds for queue cards (minutes) — configurable later from business_settings
export const LATE_AMBER_MIN = 10
export const LATE_RED_MIN = 20
export const LOCK_AFTER_SEND = true
export const ORDER_IDLE_MS = 30_000
export const STATION_IDLE_MS = 300_000

// ───────────── Order drafts, stored per staff member and per tab ─────────────
export type CartLine = { product_id: string; name: string; price: number; qty: number }
export type Draft = { key: string; lines: CartLine[]; state: 'editing' | 'not_sent' }

const PREFIX = 'draft:'
const dkey = (staff: string, tab: string) => `${PREFIX}${staff}:${tab}`

export function loadDraft(staff: string, tab: string): Draft | null {
  try { const s = localStorage.getItem(dkey(staff, tab)); return s ? JSON.parse(s) as Draft : null } catch { return null }
}
export function saveDraft(staff: string, tab: string, d: Draft) {
  try { localStorage.setItem(dkey(staff, tab), JSON.stringify(d)) } catch { /* storage full or blocked */ }
}
export function clearDraft(staff: string, tab: string) {
  try { localStorage.removeItem(dkey(staff, tab)) } catch { /* ignore */ }
}
export function listNotSent(staff?: string): { staff: string; tab: string; draft: Draft }[] {
  const out: { staff: string; tab: string; draft: Draft }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(PREFIX)) continue
      const [s, t] = k.slice(PREFIX.length).split(':')
      if (staff && s !== staff) continue
      const d = JSON.parse(localStorage.getItem(k) ?? 'null') as Draft | null
      if (d && d.state === 'not_sent') out.push({ staff: s, tab: t, draft: d })
    }
  } catch { /* ignore */ }
  return out
}
