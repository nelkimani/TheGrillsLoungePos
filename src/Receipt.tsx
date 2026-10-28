import { ReactNode } from 'react'
import { kes } from './lib'

export type BillLine = {
  item_id: string; product_name: string; qty: number; unit_price: number; line_total: number; status: string
}
export type CardRow = {
  tab_id: string; table_number: string | null; customer_name: string | null; waiter_name: string; waiter_id?: string
  status: string; bill_total: number; paid: number; balance: number; pending_total: number
}
export type PaymentRow = {
  id: string; receipt_no: number; method: 'cash' | 'mpesa'; amount: number; mpesa_code: string | null
  tendered_amount: number | null; change_given: number | null; entered_at: string
}

const row = 'flex justify-between gap-2'

// 58mm slip. On screen it previews as white paper; Print shows only this block.
export function Slip({ heading, notReceipt, label, waiter, lines, total, children }:
  { heading: string; notReceipt?: boolean; label: string; waiter: string; lines: BillLine[]; total: number; children?: ReactNode }) {
  return (
    <div id="receipt" className="mx-auto w-[58mm] min-w-[58mm] bg-white p-2 font-mono text-[11px] leading-tight text-black">
      <div className="text-center text-sm font-bold">GRILLS LOUNGE NDAGANI</div>
      <div className="text-center">{heading}</div>
      {notReceipt && <div className="my-1 border border-black text-center font-bold">NOT A RECEIPT</div>}
      <div>{label} · {waiter}</div>
      <div>{new Date().toLocaleString('en-KE')}</div>
      <hr className="my-1 border-black" />
      {lines.map(l => (
        <div key={l.item_id} className={row}>
          <span>{Number(l.qty)} x {l.product_name}{l.status !== 'served' ? ' *' : ''}</span>
          <span>{Number(l.line_total).toLocaleString('en-KE')}</span>
        </div>
      ))}
      {lines.some(l => l.status !== 'served') && <div>* not yet served</div>}
      <hr className="my-1 border-black" />
      <div className={`${row} text-xs font-bold`}><span>TOTAL</span><span>{kes(total)}</span></div>
      {children}
    </div>
  )
}

export function PaymentLines({ p, remaining }: { p: PaymentRow; remaining: number }) {
  return (
    <div className="mt-1 border-t border-black pt-1">
      <div className={row}><span>Receipt #{p.receipt_no}</span><span>{p.method === 'cash' ? 'CASH' : 'M-PESA'}</span></div>
      <div className={row}><span>Paid</span><span>{kes(p.amount)}</span></div>
      {p.method === 'cash' && p.tendered_amount != null && (
        <>
          <div className={row}><span>Cash given</span><span>{kes(p.tendered_amount)}</span></div>
          <div className={row}><span>Change</span><span>{kes(p.change_given)}</span></div>
        </>
      )}
      {p.mpesa_code && <div className={row}><span>M-Pesa code</span><span>{p.mpesa_code}</span></div>}
      <div className={`${row} font-bold`}><span>Balance</span><span>{kes(remaining)}</span></div>
      <div className="mt-1 text-center">Thank you</div>
    </div>
  )
}
