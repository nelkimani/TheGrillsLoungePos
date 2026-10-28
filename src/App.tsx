import { useEffect, useState } from 'react'
import { supabase, TERMINAL_CODE, Profile, can } from './supabase'
import { Btn, TopBar } from './ui'
import Login from './Login'
import StaffAdmin from './StaffAdmin'
import Waiter from './Waiter'
import Queue from './Queue'
import BarStock from './BarStock'
import Approvals from './Approvals'
import Handover from './Handover'
import Recon from './Recon'
import Purchasing from './Purchasing'
import Expenses from './Expenses'
import StockRoom from './StockRoom'
import Reports from './Reports'
import OwnerReports from './OwnerReports'
import { ORDER_IDLE_MS, STATION_IDLE_MS, TERMINAL_NAMES, listNotSent } from './lib'
import { useIdle } from './useIdle'
import { FeedbackHost, confirmDialog } from './feedback'

type View = 'home' | 'waiter' | 'queue' | 'staff' | 'stock' | 'approvals' | 'handover' | 'recon' | 'purchasing' | 'expenses' | 'stockroom' | 'reports' | 'owner'
const isTerminal = TERMINAL_CODE !== 'OFFICE'

export default function App() {
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [problem, setProblem] = useState('')
  const [view, setView] = useState<View>('home')
  const [queueStations, setQueueStations] = useState<string[]>([])
  const [unsent, setUnsent] = useState(0)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSignedIn(!!data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSignedIn(!!s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!signedIn) { setProfile(null); setProblem(''); setView('home'); return }
    supabase.rpc('my_profile').then(({ data, error }) => {
      if (error || !data) { setProblem('This account is not set up as staff, or is inactive.'); return }
      setProfile(data as Profile)
    })
  }, [signedIn])

  useEffect(() => {
    const t = setInterval(() => setUnsent(listNotSent().length), 3000)
    setUnsent(listNotSent().length)
    return () => clearInterval(t)
  }, [])

  const lock = () => supabase.auth.signOut()
  // Terminals lock themselves: quickly while ordering, slowly on the kitchen/bar queues.
  useIdle(view === 'waiter' ? ORDER_IDLE_MS : STATION_IDLE_MS, lock, isTerminal && signedIn && view !== 'home' || (isTerminal && signedIn))

  const switchUser = async () => {
    const mine = profile ? listNotSent(profile.id).length : 0
    if (mine > 0 && !(await confirmDialog({
      title: 'Switch user?',
      message: `${mine} order(s) NOT SENT are saved for you. They stay saved and send when you sign in again.`,
      confirmText: 'Switch user',
    }))) return
    lock()
  }

  if (!ready) return null
  const home = () => setView('home')
  const stationPerms = profile
    ? ['kitchen', 'choma', 'bar'].filter(s => can(profile, 'station.' + s)) : []

  return (
    <div className="min-h-full">
      <FeedbackHost />
      <TopBar terminal={TERMINAL_NAMES[TERMINAL_CODE] ?? TERMINAL_CODE} unsent={unsent}
              who={profile ? `${profile.full_name} (${profile.roles.join(', ')})` : undefined}
              onSignOut={signedIn ? switchUser : undefined} />
      {!signedIn && <Login />}
      {signedIn && problem && (
        <div className="p-8 text-xl">{problem}
          <div className="mt-4"><button className="h-14 rounded-xl bg-slate-700 px-6" onClick={lock}>Sign out</button></div>
        </div>
      )}
      {signedIn && profile && view === 'home' && (
        <div className="mx-auto flex max-w-xl flex-col gap-4 p-8">
          <h1 className="text-3xl font-bold">Hello, {profile.full_name}</h1>
          {can(profile, 'tab.open') && <Btn onClick={() => setView('waiter')}>Take orders</Btn>}
          {stationPerms.includes('kitchen') && <Btn onClick={() => { setQueueStations(['kitchen']); setView('queue') }}>Kitchen queue</Btn>}
          {stationPerms.includes('choma') && <Btn onClick={() => { setQueueStations(['choma']); setView('queue') }}>Choma queue</Btn>}
          {stationPerms.includes('bar') && <Btn onClick={() => { setQueueStations(['bar']); setView('queue') }}>Bar queue</Btn>}
          {stationPerms.length > 1 && <Btn kind="ghost" onClick={() => { setQueueStations(stationPerms); setView('queue') }}>All queues</Btn>}
          {(stationPerms.includes('bar') || can(profile, 'stock.view_all')) && <Btn kind="ghost" onClick={() => setView('stock')}>Bar stock</Btn>}
          {can(profile, 'approval.grant') && <Btn kind="ghost" onClick={() => setView('approvals')}>Approvals</Btn>}
          {can(profile, 'payment.record') && !can(profile, 'recon.view_all') && <Btn kind="ghost" onClick={() => setView('handover')}>Hand in cash</Btn>}
          {can(profile, 'recon.view_all') && <Btn kind="ghost" onClick={() => setView('recon')}>Reconciliation</Btn>}
          {(can(profile, 'goods.receive') || can(profile, 'supplier.manage')) && <Btn kind="ghost" onClick={() => setView('purchasing')}>Purchasing</Btn>}
          {can(profile, 'expense.record') && <Btn kind="ghost" onClick={() => setView('expenses')}>Cash expenses</Btn>}
          {(can(profile, 'stock.view_all') || stationPerms.includes('kitchen') || stationPerms.includes('choma')) && <Btn kind="ghost" onClick={() => setView('stockroom')}>Stock room</Btn>}
          {(can(profile, 'report.view') || can(profile, 'report.build')) && <Btn kind="ghost" onClick={() => setView('reports')}>Reports &amp; sign-off</Btn>}
          {(can(profile, 'report.sales') || can(profile, 'report.profit')) && <Btn kind="ghost" onClick={() => setView('owner')}>Owner reports</Btn>}
          {can(profile, 'staff.manage') && <Btn kind="ghost" onClick={() => setView('staff')}>Staff</Btn>}
          {!can(profile, 'tab.open') && stationPerms.length === 0 && !can(profile, 'staff.manage') &&
            <div className="text-xl text-slate-300">No screens are available for your role yet.</div>}
        </div>
      )}
      {signedIn && profile && view === 'waiter' && <Waiter profile={profile} onDone={home} onLock={lock} />}
      {signedIn && profile && view === 'queue' && <Queue profile={profile} stations={queueStations} onDone={home} />}
      {signedIn && profile && view === 'stock' && <BarStock profile={profile} onDone={home} />}
      {signedIn && profile && view === 'approvals' && <Approvals onDone={home} />}
      {signedIn && profile && view === 'handover' && <Handover onDone={home} />}
      {signedIn && profile && view === 'recon' && <Recon profile={profile} onDone={home} />}
      {signedIn && profile && view === 'purchasing' && <Purchasing profile={profile} onDone={home} />}
      {signedIn && profile && view === 'expenses' && <Expenses profile={profile} onDone={home} />}
      {signedIn && profile && view === 'stockroom' && <StockRoom profile={profile} onDone={home} />}
      {signedIn && profile && view === 'reports' && <Reports profile={profile} onDone={home} />}
      {signedIn && profile && view === 'owner' && <OwnerReports profile={profile} onDone={home} />}
      {signedIn && profile && view === 'staff' && (
        <div><div className="p-3"><Btn kind="ghost" onClick={home}>← Home</Btn></div><StaffAdmin /></div>
      )}
    </div>
  )
}
