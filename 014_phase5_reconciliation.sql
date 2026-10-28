-- Grills Lounge POS — Phase 5: accountant reconciliation (run after 013)
-- Cash hand-in, M-Pesa verification, daily close. All writes go through RPCs; all reads through gated views.

-- ───────────── New permissions ─────────────
insert into permissions(code, description) values
  ('handover.receive', 'Receive cash from waiters and bartenders'),
  ('mpesa.verify',     'Verify or dispute M-Pesa payments against the statement'),
  ('close.submit',     'Submit the daily close'),
  ('close.approve',    'Approve or return the daily close')
on conflict (code) do nothing;

insert into role_permissions(role_code, permission_code) values
  ('accountant','handover.receive'), ('accountant','mpesa.verify'), ('accountant','close.submit'),
  ('manager','handover.receive'),    ('manager','mpesa.verify'),    ('manager','close.submit'), ('manager','close.approve')
on conflict do nothing;
-- recon.view_all must already be on accountant and manager (Phase 1); make sure:
insert into role_permissions(role_code, permission_code)
select r, 'recon.view_all' from unnest(array['accountant','manager']) r
where exists (select 1 from permissions where code = 'recon.view_all')
on conflict do nothing;

alter table daily_closes add column if not exists summary jsonb;
create unique index if not exists daily_close_one_per_day on daily_closes(business_date) where shift_id is null;

create or replace function day_locked(p_date date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from daily_closes where business_date = p_date and shift_id is null and status = 'approved')
$$;

-- ───────────── Views ─────────────
-- Cash: expected (cash payments) vs what was handed in and received. variance = expected − received; + shortage, − surplus.
create or replace view recon_cash with (security_invoker = false) as
with exp as (
  select waiter_id, business_date, sum(amount) as expected from payments where method = 'cash' group by 1, 2),
hv as (
  select waiter_id, business_date,
         sum(declared_amount) as declared, sum(actual_amount) as actual, count(*) as n,
         count(*) filter (where actual_amount is null) as pending_n,
         max(received_at) as received_at,
         (array_agg(received_by order by received_at desc nulls last))[1] as received_by,
         string_agg(notes, ' | ') filter (where notes is not null) as notes
  from cash_handovers group by 1, 2)
select coalesce(e.waiter_id, h.waiter_id) as waiter_id, s.full_name, s.staff_no,
       coalesce(e.business_date, h.business_date) as business_date,
       coalesce(e.expected, 0) as expected_cash,
       h.declared, h.actual,
       (h.n is not null and h.pending_n = 0) as received,
       case when h.n is not null and h.pending_n = 0 then coalesce(e.expected, 0) - h.actual end as variance,
       h.received_at, rb.full_name as received_by_name, h.notes
from exp e
full join hv h on h.waiter_id = e.waiter_id and h.business_date = e.business_date
join staff s on s.id = coalesce(e.waiter_id, h.waiter_id)
left join staff rb on rb.id = h.received_by
where has_permission('recon.view_all');

create or replace view recon_mpesa with (security_invoker = false) as
select p.id as payment_id, p.business_date, p.txn_time, p.mpesa_code_norm as code, p.amount,
       p.waiter_id, s.full_name as waiter_name, p.tab_id,
       coalesce(v.status::text, 'recorded') as verification,
       v.matched_ref, v.discrepancy_reason, vs.full_name as verified_by_name, v.at as verified_at
from payments p
join staff s on s.id = p.waiter_id
left join lateral (select * from mpesa_verifications x where x.payment_id = p.id order by x.at desc, x.id desc limit 1) v on true
left join staff vs on vs.id = v.verified_by
where p.method = 'mpesa' and p.amount > 0 and has_permission('recon.view_all');

grant select on recon_cash, recon_mpesa to authenticated;
revoke all on recon_cash, recon_mpesa from anon;

-- ───────────── Day summary and exceptions ─────────────
create or replace function day_summary(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb; c daily_closes;
begin
  if not has_permission('recon.view_all') then raise exception 'not permitted'; end if;
  select * into c from daily_closes where business_date = p_date and shift_id is null;
  select jsonb_build_object(
    'date', p_date,
    'sales_total',   coalesce((select sum(tt.bill_total) from tab_totals tt join tabs t on t.id = tt.tab_id where t.business_date = p_date), 0),
    'cash_expected', coalesce((select sum(expected_cash) from recon_cash where business_date = p_date), 0),
    'cash_received', coalesce((select sum(actual) from recon_cash where business_date = p_date and received), 0),
    'cash_variance', coalesce((select sum(variance) from recon_cash where business_date = p_date and received), 0),
    'cash_unreceived', (select count(*) from recon_cash where business_date = p_date and not coalesce(received, false) and expected_cash <> 0),
    'mpesa_total',    coalesce((select sum(amount) from recon_mpesa where business_date = p_date), 0),
    'mpesa_verified', coalesce((select sum(amount) from recon_mpesa where business_date = p_date and verification = 'verified'), 0),
    'mpesa_disputed', coalesce((select sum(amount) from recon_mpesa where business_date = p_date and verification = 'disputed'), 0),
    'mpesa_unverified', coalesce((select sum(amount) from recon_mpesa where business_date = p_date and verification = 'recorded'), 0),
    'mpesa_unverified_count', (select count(*) from recon_mpesa where business_date = p_date and verification = 'recorded'),
    'open_tabs', (select count(*) from tabs where business_date = p_date and status not in ('settled', 'closed_credit')),
    'open_tabs_balance', coalesce((select sum(b.balance) from tab_balances b join tabs t on t.id = b.tab_id
                                    where t.business_date = p_date and t.status not in ('settled', 'closed_credit')), 0),
    'pending_approvals', (select count(*) from approvals where status = 'pending'),
    'count_variances', (select count(*) from stock_counts where business_date = p_date and variance <> 0),
    'close_id', c.id, 'close_status', c.status, 'close_notes', c.notes,
    'close_submitted_by', (select full_name from staff where id = c.submitted_by)
  ) into r;
  return r;
end $$;

create or replace function day_exceptions(p_date date)
returns table (kind text, detail text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not has_permission('recon.view_all') then raise exception 'not permitted'; end if;
  return query
  select 'Open tab', coalesce('Table ' || ft.number, t.customer_name, 'Tab') || ' · ' || s.full_name || ' · ' || t.status, b.balance
    from tabs t join staff s on s.id = t.waiter_id left join floor_tables ft on ft.id = t.table_id
    join tab_balances b on b.tab_id = t.id
   where t.business_date = p_date and t.status not in ('settled', 'closed_credit')
  union all
  select 'Cash not received', full_name || ' (' || staff_no || ')', expected_cash
    from recon_cash where business_date = p_date and not coalesce(received, false) and expected_cash <> 0
  union all
  select case when variance > 0 then 'Cash SHORTAGE' else 'Cash surplus' end,
         full_name || ' · ' || coalesce(notes, 'no note'), variance
    from recon_cash where business_date = p_date and received and variance <> 0
  union all
  select 'M-Pesa DISPUTED', code || ' · ' || waiter_name || ' · ' || coalesce(discrepancy_reason, ''), amount
    from recon_mpesa where business_date = p_date and verification = 'disputed'
  union all
  select 'M-Pesa not verified', code || ' · ' || waiter_name, amount
    from recon_mpesa where business_date = p_date and verification = 'recorded'
  union all
  select 'Stock count variance', p.name || ' · ' || coalesce(sc.explanation, 'no explanation'), sc.variance
    from stock_counts sc join products p on p.id = sc.product_id where sc.business_date = p_date and sc.variance <> 0
  union all
  select 'Approval pending', a.kind || ' · ' || a.reason, null::numeric from approvals a where a.status = 'pending'
  union all
  select 'Missing unit conversion', coalesce(new_values->>'product', '?'), null::numeric
    from audit_log where action = 'stock.conversion_missing' and business_date(at) = p_date;
end $$;

-- ───────────── Cash hand-in (blind: the person declares without seeing the expected figure) ─────────────
create or replace function declare_handover(p_amount numeric, p_notes text, p_key text)
returns cash_handovers language plpgsql security definer set search_path = public as $$
declare v cash_handovers;
begin
  if not has_permission('payment.record') then raise exception 'not permitted'; end if;
  select * into v from cash_handovers where idempotency_key = p_key;
  if found then return v; end if;
  if p_amount is null or p_amount < 0 then raise exception 'amount is invalid'; end if;
  insert into cash_handovers(waiter_id, shift_id, business_date, declared_amount, notes, idempotency_key)
  values (auth.uid(), current_shift(), business_date(now()), p_amount, nullif(btrim(p_notes), ''), p_key)
  returning * into v;
  perform write_audit('handover.declare', 'cash_handovers', v.id::text, null, to_jsonb(v));
  return v;
end $$;

-- Accountant counts the cash and records what was actually received
create or replace function receive_cash(p_waiter uuid, p_date date, p_actual numeric, p_notes text, p_key text)
returns cash_handovers language plpgsql security definer set search_path = public as $$
declare v cash_handovers; expected numeric; prev numeric; diff numeric;
begin
  if not has_permission('handover.receive') then raise exception 'not permitted'; end if;
  if p_waiter = auth.uid() then raise exception 'you cannot receive your own cash'; end if;
  select * into v from cash_handovers where idempotency_key = p_key;
  if found then return v; end if;
  if day_locked(p_date) then raise exception 'This day is already closed and approved'; end if;
  if p_actual is null or p_actual < 0 then raise exception 'amount is invalid'; end if;
  select coalesce(sum(amount), 0) into expected from payments where waiter_id = p_waiter and business_date = p_date and method = 'cash';
  select coalesce(sum(actual_amount), 0) into prev from cash_handovers where waiter_id = p_waiter and business_date = p_date and actual_amount is not null;
  diff := expected - (prev + p_actual);
  if diff <> 0 and coalesce(btrim(p_notes), '') = '' then
    raise exception 'Cash differs from expected by KES % – write the reason', diff; end if;
  select * into v from cash_handovers where waiter_id = p_waiter and business_date = p_date and actual_amount is null
   order by declared_at desc limit 1 for update;
  if found then
    update cash_handovers set actual_amount = p_actual, received_by = auth.uid(), received_at = now(),
           notes = coalesce(nullif(btrim(p_notes), ''), notes), idempotency_key = p_key
     where id = v.id returning * into v;
  else
    insert into cash_handovers(waiter_id, business_date, declared_amount, actual_amount, received_by, received_at, notes, idempotency_key)
    values (p_waiter, p_date, p_actual, p_actual, auth.uid(), now(),
            coalesce(nullif(btrim(p_notes), ''), 'recorded by receiver, no declaration'), p_key)
    returning * into v;
  end if;
  perform write_audit('handover.receive', 'cash_handovers', v.id::text, null, to_jsonb(v), p_notes);
  return v;
end $$;

-- ───────────── M-Pesa verification (append-only) ─────────────
create or replace function verify_mpesa(p_payment uuid, p_status pay_status, p_ref text, p_reason text)
returns mpesa_verifications language plpgsql security definer set search_path = public as $$
declare pay payments; prev_v mpesa_verifications; v mpesa_verifications;
begin
  if not has_permission('mpesa.verify') then raise exception 'not permitted'; end if;
  if p_status not in ('verified', 'disputed') then raise exception 'status must be verified or disputed'; end if;
  select * into pay from payments where id = p_payment and method = 'mpesa' and amount > 0;
  if not found then raise exception 'M-Pesa payment not found'; end if;
  if pay.waiter_id = auth.uid() then raise exception 'you cannot verify a payment you recorded'; end if;
  if day_locked(pay.business_date) then raise exception 'This day is already closed and approved'; end if;
  select * into prev_v from mpesa_verifications where payment_id = p_payment order by at desc, id desc limit 1;
  if found and prev_v.status = p_status and p_status = 'verified' then return prev_v; end if;
  if p_status = 'disputed' and coalesce(btrim(p_reason), '') = '' then raise exception 'write the reason it is disputed'; end if;
  insert into mpesa_verifications(payment_id, status, matched_ref, discrepancy_reason, verified_by)
  values (p_payment, p_status, nullif(btrim(p_ref), ''), nullif(btrim(p_reason), ''), auth.uid())
  returning * into v;
  perform write_audit('mpesa.' || p_status::text, 'payments', p_payment::text, null, to_jsonb(v), p_reason);
  return v;
end $$;

-- ───────────── Daily close: accountant submits, manager approves ─────────────
create or replace function submit_daily_close(p_date date, p_notes text)
returns daily_closes language plpgsql security definer set search_path = public as $$
declare d daily_closes; s jsonb; blockers int; st text;
begin
  if not has_permission('close.submit') then raise exception 'not permitted'; end if;
  if p_date > business_date(now()) then raise exception 'cannot close a future day'; end if;
  select * into d from daily_closes where business_date = p_date and shift_id is null for update;
  if found and d.status = 'approved' then raise exception 'This day is already approved'; end if;
  s := day_summary(p_date);
  blockers := (s->>'cash_unreceived')::int + (s->>'mpesa_unverified_count')::int + (s->>'open_tabs')::int;
  st := case when blockers > 0 then 'provisional' else 'submitted' end;
  if st = 'provisional' and coalesce(btrim(p_notes), '') = '' then
    raise exception 'Items are still open (cash not received, M-Pesa not verified or open tabs) – write why you are closing anyway'; end if;
  if found then
    update daily_closes set status = st, submitted_by = auth.uid(), submitted_at = now(), notes = nullif(btrim(p_notes), ''),
           approved_by = null, approved_at = null, summary = s where id = d.id returning * into d;
  else
    insert into daily_closes(business_date, status, submitted_by, submitted_at, notes, summary)
    values (p_date, st, auth.uid(), now(), nullif(btrim(p_notes), ''), s) returning * into d;
  end if;
  perform write_audit('close.submit', 'daily_closes', d.id::text, null, to_jsonb(d), p_notes);
  return d;
end $$;

create or replace function approve_daily_close(p_id uuid, p_approve boolean, p_notes text)
returns daily_closes language plpgsql security definer set search_path = public as $$
declare d daily_closes;
begin
  if not has_permission('close.approve') then raise exception 'not permitted'; end if;
  select * into d from daily_closes where id = p_id for update;
  if not found then raise exception 'close not found'; end if;
  if d.status not in ('submitted', 'provisional') then raise exception 'this close is %, not waiting for a decision', d.status; end if;
  if d.submitted_by = auth.uid() then raise exception 'you cannot approve a close you submitted'; end if;
  if p_approve and d.status = 'provisional' and coalesce(btrim(p_notes), '') = '' then
    raise exception 'This close has open items – write why you accept it'; end if;
  if not p_approve and coalesce(btrim(p_notes), '') = '' then raise exception 'write what must be fixed'; end if;
  update daily_closes set status = case when p_approve then 'approved' else 'returned' end,
         approved_by = auth.uid(), approved_at = now(),
         notes = coalesce(nullif(btrim(p_notes), ''), notes),
         summary = case when p_approve then day_summary(d.business_date) else summary end
   where id = p_id returning * into d;
  perform write_audit('close.' || case when p_approve then 'approve' else 'return' end, 'daily_closes', d.id::text, null, to_jsonb(d), p_notes);
  return d;
end $$;

revoke execute on function day_locked(date), day_summary(date), day_exceptions(date),
  declare_handover(numeric, text, text), receive_cash(uuid, date, numeric, text, text),
  verify_mpesa(uuid, pay_status, text, text), submit_daily_close(date, text), approve_daily_close(uuid, boolean, text)
  from public, anon;
grant execute on function day_summary(date), day_exceptions(date),
  declare_handover(numeric, text, text), receive_cash(uuid, date, numeric, text, text),
  verify_mpesa(uuid, pay_status, text, text), submit_daily_close(date, text), approve_daily_close(uuid, boolean, text)
  to authenticated;
