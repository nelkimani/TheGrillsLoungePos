import { useEffect, useRef } from 'react'

// Calls onIdle after `ms` with no touch, tap or key press.
export function useIdle(ms: number, onIdle: () => void, enabled: boolean) {
  const cb = useRef(onIdle)
  cb.current = onIdle
  useEffect(() => {
    if (!enabled) return
    let t = setTimeout(() => cb.current(), ms)
    const reset = () => { clearTimeout(t); t = setTimeout(() => cb.current(), ms) }
    const events = ['pointerdown', 'keydown', 'touchstart']
    events.forEach(e => window.addEventListener(e, reset))
    return () => { clearTimeout(t); events.forEach(e => window.removeEventListener(e, reset)) }
  }, [ms, enabled])
}
