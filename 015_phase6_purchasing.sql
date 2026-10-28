-- Grills Lounge POS — Phase 6A: suppliers, goods received, kitchen/choma/store stock, small cash expenses,
-- director's report with sign-off, supplier payments. (run after 014)

-- ───────────── Role and permissions ─────────────
insert into roles(code, name) values ('director', 'Director') on conflict do nothing;
insert into permissions(code, description) values
  ('goods.receive',   'Receive goods against a delivery note'),
  ('supplier.manage', 'Add and edit suppliers'),
  ('expense.record',  'Record small cash expenses'),
  ('expense.void',    'Void a wrongly recorded expense'),
  ('report.build',    'Build and submit the report for the director'),
  ('report.view',     'View expense reports and supplier balances'),
  ('report.signoff',  'Review and sign off the report'),
  ('supplier.pay',    'Record a payment made to a supplier'),
  ('stock.count',     'Count stock'),
  ('stock.view_all',  'View all stock')
on conflict (code) do nothing;
insert into role_permissions(role_code, permission_code) values
  ('accountant','goods.receive'), ('accountant','supplier.manage'), ('accountant','expense.record'),
  ('accountant','report.build'),  ('accountant','report.view'),     ('accountant','stock.count'), ('accountant','stock.view_all'),
  ('manager','goods.receive'),    ('manager','supplier.manage'),     ('manager','expense.record'), ('manager','expense.void'),
  ('manager','report.view'),      ('manager','stock.count'),         ('manager','stock.view_all'),
  ('head_chef','stock.count'),    ('choma','stock.count'),
  ('director','report.view'),     ('director','report.signoff'),     ('director','supplier.pay'),
  ('director','recon.view_all'),  ('director','stock.view_all')
on conflict do nothing;

-- ───────────── Suppliers ─────────────
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique, phone text,
  kind text not null default 'other' check (kind in ('kitchen','drinks','maintenance','other')),
  is_big boolean not null default false,            -- big suppliers are paid by the director after sign-off
  active boolean not null default true, created_at timestamptz not null default now());
alter table suppliers enable row level security;
create policy suppliers_read on suppliers for select to authenticated
  using (has_permission('supplier.manage') or has_permission('goods.receive') or has_permission('report.view'));

create or replace function add_supplier(p_name text, p_phone text, p_kind text, p_big boolean)
returns suppliers language plpgsql security definer set search_path = public as $$
declare v suppliers;
begin
  if not has_permission('supplier.manage') then raise exception 'not permitted'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'supplier name required'; end if;
  insert into suppliers(name, phone, kind, is_big) values (btrim(p_name), nullif(btrim(p_phone), ''), p_kind, coalesce(p_big, false))
  returning * into v;
  perform write_audit('supplier.add', 'suppliers', v.id::text, null, to_jsonb(v));
  return v;
exception when unique_violation then raise exception 'A supplier with that name already exists';
end $$;

-- ───────────── Goods received ─────────────
create table goods_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_no bigint generated always as identity unique,
  supplier_id uuid not null references suppliers(id),
  delivery_note text not null,
  business_date date not null default business_date(now()),
  received_by uuid not null references staff(id),
  note text, total_cost numeric(14,2) not null check (total_cost >= 0),
  idempotency_key text not null unique, created_at timestamptz not null default now());
create unique index one_note_per_supplier on goods_receipts(supplier_id, lower(delivery_note));
create table goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references goods_receipts(id),
  product_id uuid not null references products(id),
  location_kind location_kind not null,
  qty_base numeric(14,3) not null check (qty_base > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),      -- cost per BASE unit
  line_total numeric(14,2) not null);
alter table goods_receipts enable row level security;
alter table goods_receipt_lines enable row level security;
create trigger grn_immutable before update or delete on goods_receipts for each row execute function forbid_change();
create trigger grnl_immutable before update or delete on goods_receipt_lines for each row execute function forbid_change();

-- Supplier account: positive = we owe the supplier
create table supplier_ledger (
  id bigint generated always as identity primary key,
  supplier_id uuid not null references suppliers(id),
  at timestamptz not null default now(), business_date date not null default business_date(now()),
  kind text not null check (kind in ('invoice','payment','credit')),
  amount numeric(14,2) not null check (amount <> 0),
  ref_table text, ref_id uuid, note text, actor_id uuid references staff(id));
alter table supplier_ledger enable row level security;
create trigger ledger_immutable before update or delete on supplier_ledger for each row execute function forbid_change();

create or replace function receive_goods(p_supplier uuid, p_note_no text, p_note text, p_lines jsonb, p_key text)
returns goods_receipts language plpgsql security definer set search_path = public as $$
declare g goods_receipts; it jsonb; pr products; v_loc location_kind; v_qty numeric; v_cost numeric;
        v_total numeric; n int := 0;
begin
  if not has_permission('goods.receive') then raise exception 'not permitted'; end if;
  select * into g from goods_receipts where idempotency_key = p_key;
  if found then return g; end if;
  if not exists (select 1 from suppliers where id = p_supplier and active) then raise exception 'choose a supplier'; end if;
  if coalesce(btrim(p_note_no), '') = '' then raise exception 'enter the delivery note number'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'there are no items on this delivery'; end if;
  select coalesce(sum((x->>'qty')::numeric * (x->>'unit_cost')::numeric), 0) into v_total from jsonb_array_elements(p_lines) x;
  begin
    insert into goods_receipts(supplier_id, delivery_note, received_by, note, total_cost, idempotency_key)
    values (p_supplier, btrim(p_note_no), auth.uid(), nullif(btrim(p_note), ''), round(v_total, 2), p_key) returning * into g;
  exception when unique_violation then
    select * into g from goods_receipts where idempotency_key = p_key;
    if found then return g; end if;
    raise exception 'Delivery note % was already recorded for this supplier', btrim(p_note_no);
  end;
  for it in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_qty := (it->>'qty')::numeric; v_cost := (it->>'unit_cost')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'bad quantity on line %', n; end if;
    if v_cost is null or v_cost < 0 then raise exception 'bad cost on line %', n; end if;
    v_loc := (it->>'location')::location_kind;
    if v_loc not in ('main_bar', 'store', 'kitchen', 'choma') then raise exception 'bad destination on line %', n; end if;
    select * into pr from products where id = (it->>'product_id')::uuid;
    if not found then raise exception 'product not found on line %', n; end if;
    insert into goods_receipt_lines(receipt_id, product_id, location_kind, qty_base, unit_cost, line_total)
    values (g.id, pr.id, v_loc, v_qty, v_cost, round(v_qty * v_cost, 2));
    insert into stock_movements(product_id, from_location, to_location, qty_base, type, ref_table, ref_id,
                                shift_id, actor_id, idempotency_key, note)
    values (pr.id, null, loc(v_loc), v_qty, 'purchase', 'goods_receipts', g.id, current_shift(), auth.uid(),
            'grn:' || g.id::text || ':' || n::text, 'Delivery note ' || g.delivery_note);
    update products set purchase_cost = v_cost where id = pr.id;
  end loop;
  if g.total_cost > 0 then
    insert into supplier_ledger(supplier_id, kind, amount, ref_table, ref_id, note, actor_id)
    values (p_supplier, 'invoice', g.total_cost, 'goods_receipts', g.id, 'Delivery note ' || g.delivery_note, auth.uid());
  end if;
  perform write_audit('goods.receive', 'goods_receipts', g.id::text, null, to_jsonb(g));
  return g;
end $$;

-- ───────────── Small cash expenses (paid from the till) ─────────────
create table expenses (
  id uuid primary key default gen_random_uuid(),
  business_date date not null default business_date(now()),
  category text not null, amount numeric(12,2) not null check (amount > 0),
  description text not null, receipt_ref text,
  recorded_by uuid not null references staff(id),
  idempotency_key text not null unique, created_at timestamptz not null default now());
create table expense_voids (
  expense_id uuid primary key references expenses(id), reason text not null,
  voided_by uuid not null references staff(id), at timestamptz not null default now());
alter table expenses enable row level security;
alter table expense_voids enable row level security;
create trigger expenses_immutable before update or delete on expenses for each row execute function forbid_change();

create or replace function record_expense(p_category text, p_amount numeric, p_description text, p_ref text, p_key text)
returns expenses language plpgsql security definer set search_path = public as $$
declare v expenses;
begin
  if not has_permission('expense.record') then raise exception 'not permitted'; end if;
  select * into v from expenses where idempotency_key = p_key;
  if found then return v; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if coalesce(btrim(p_category), '') = '' or coalesce(btrim(p_description), '') = '' then
    raise exception 'category and description are required'; end if;
  if day_locked(business_date(now())) then raise exception 'This day is already closed and approved'; end if;
  insert into expenses(category, amount, description, receipt_ref, recorded_by, idempotency_key)
  values (btrim(p_category), p_amount, btrim(p_description), nullif(btrim(p_ref), ''), auth.uid(), p_key) returning * into v;
  perform write_audit('expense.record', 'expenses', v.id::text, null, to_jsonb(v));
  return v;
end $$;

create or replace function void_expense(p_id uuid, p_reason text)
returns expense_voids language plpgsql security definer set search_path = public as $$
declare e expenses; v expense_voids;
begin
  if not has_permission('expense.void') then raise exception 'not permitted'; end if;
  select * into e from expenses where id = p_id;
  if not found then raise exception 'expense not found'; end if;
  if day_locked(e.business_date) then raise exception 'This day is already closed and approved'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'write the reason'; end if;
  if e.recorded_by = auth.uid() then raise exception 'you cannot void an expense you recorded'; end if;
  insert into expense_voids(expense_id, reason, voided_by) values (p_id, btrim(p_reason), auth.uid()) returning * into v;
  perform write_audit('expense.void', 'expenses', p_id::text, to_jsonb(e), null, p_reason);
  return v;
exception when unique_violation then raise exception 'already voided';
end $$;

-- ───────────── Store / kitchen / choma stock counts ─────────────
create or replace function record_location_count(p_kind location_kind, p_product uuid, p_counted numeric, p_explanation text)
returns stock_counts language plpgsql security definer set search_path = public as $$
declare v stock_counts; l uuid := loc(p_kind); expected numeric; diff numeric;
begin
  if not has_permission('stock.count') then raise exception 'not permitted'; end if;
  if p_kind not in ('store', 'kitchen', 'choma') then raise exception 'use the bar stock screen for the bar'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'counted quantity is invalid'; end if;
  select coalesce(sum(q), 0) into expected from (
    select qty_base as q from stock_movements where product_id = p_product and to_location = l
    union all select -qty_base from stock_movements where product_id = p_product and from_location = l) m;
  diff := p_counted - expected;
  if diff <> 0 and coalesce(btrim(p_explanation), '') = '' then raise exception 'explain the difference'; end if;
  insert into stock_counts(location_id, product_id, expected_qty, counted_qty, explanation, counted_by, business_date)
  values (l, p_product, expected, p_counted, nullif(btrim(p_explanation), ''), auth.uid(), business_date(now())) returning * into v;
  if diff > 0 then
    insert into stock_movements(product_id, from_location, to_location, qty_base, type, ref_table, ref_id, shift_id, actor_id, note)
    values (p_product, null, l, diff, 'count_adjust', 'stock_counts', v.id, current_shift(), auth.uid(), p_explanation);
  elsif diff < 0 then
    insert into stock_movements(product_id, from_location, to_location, qty_base, type, ref_table, ref_id, shift_id, actor_id, note)
    values (p_product, l, null, -diff, 'count_adjust', 'stock_counts', v.id, current_shift(), auth.uid(), p_explanation);
  end if;
  perform write_audit('stock.count', 'stock_counts', v.id::text, null, to_jsonb(v), p_explanation);
  return v;
end $$;

-- ───────────── Director's report ─────────────
create table expense_reports (
  id uuid primary key default gen_random_uuid(),
  period_start date not null, period_end date not null check (period_end >= period_start),
  status text not null default 'draft' check (status in ('draft','submitted','signed_off','returned')),
  created_by uuid not null references staff(id), created_at timestamptz not null default now(),
  submitted_at timestamptz, signed_by uuid references staff(id), signed_at timestamptz,
  notes text, director_notes text, summary jsonb);
create table report_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references expense_reports(id),
  kind text not null check (kind in ('supplier_invoice','expense_small','maintenance','payroll','deduction','other')),
  supplier_id uuid references suppliers(id), staff_id uuid references staff(id),
  description text not null, amount numeric(14,2) not null check (amount > 0),   -- a deduction is a positive amount that REDUCES what is paid
  source_table text, source_id uuid,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  director_note text, created_at timestamptz not null default now());
create unique index one_report_per_source on report_items(source_table, source_id) where source_id is not null;
alter table expense_reports enable row level security;
alter table report_items enable row level security;

create or replace function build_report(p_start date, p_end date) returns expense_reports
language plpgsql security definer set search_path = public as $$
declare r expense_reports;
begin
  if not has_permission('report.build') then raise exception 'not permitted'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'choose a valid period'; end if;
  insert into expense_reports(period_start, period_end, created_by) values (p_start, p_end, auth.uid()) returning * into r;
  insert into report_items(report_id, kind, supplier_id, description, amount, source_table, source_id)
  select r.id, 'supplier_invoice', g.supplier_id,
         'Delivery note ' || g.delivery_note || ' · ' || to_char(g.business_date, 'DD Mon'), g.total_cost, 'goods_receipts', g.id
  from goods_receipts g join suppliers s on s.id = g.supplier_id
  where s.is_big and g.business_date between p_start and p_end and g.total_cost > 0
    and not exists (select 1 from report_items x where x.source_table = 'goods_receipts' and x.source_id = g.id);
  insert into report_items(report_id, kind, description, amount, source_table, source_id)
  select r.id, 'expense_small', e.category || ' · ' || e.description || ' · ' || to_char(e.business_date, 'DD Mon'), e.amount, 'expenses', e.id
  from expenses e
  where e.business_date between p_start and p_end
    and not exists (select 1 from expense_voids v where v.expense_id = e.id)
    and not exists (select 1 from report_items x where x.source_table = 'expenses' and x.source_id = e.id);
  perform write_audit('report.build', 'expense_reports', r.id::text, null, to_jsonb(r));
  return r;
end $$;

create or replace function add_report_item(p_report uuid, p_kind text, p_supplier uuid, p_staff uuid, p_description text, p_amount numeric)
returns report_items language plpgsql security definer set search_path = public as $$
declare r expense_reports; v report_items;
begin
  if not has_permission('report.build') then raise exception 'not permitted'; end if;
  select * into r from expense_reports where id = p_report for update;
  if not found then raise exception 'report not found'; end if;
  if r.status not in ('draft', 'returned') then raise exception 'this report is already %', r.status; end if;
  if p_kind not in ('maintenance', 'payroll', 'deduction', 'other') then raise exception 'bad item type'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if coalesce(btrim(p_description), '') = '' then raise exception 'description required'; end if;
  if p_kind = 'deduction' and p_staff is null then raise exception 'choose the staff member the deduction is for'; end if;
  insert into report_items(report_id, kind, supplier_id, staff_id, description, amount)
  values (p_report, p_kind, p_supplier, p_staff, btrim(p_description), p_amount) returning * into v;
  perform write_audit('report.add_item', 'report_items', v.id::text, null, to_jsonb(v));
  return v;
end $$;

create or replace function remove_report_item(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i report_items; r expense_reports;
begin
  if not has_permission('report.build') then raise exception 'not permitted'; end if;
  select * into i from report_items where id = p_item for update;
  if not found then raise exception 'item not found'; end if;
  select * into r from expense_reports where id = i.report_id;
  if r.status not in ('draft', 'returned') then raise exception 'this report is already %', r.status; end if;
  delete from report_items where id = p_item;     -- auto-listed items return to the pool for the next report
  perform write_audit('report.remove_item', 'report_items', p_item::text, to_jsonb(i), null);
end $$;

create or replace function submit_report(p_id uuid, p_notes text) returns expense_reports
language plpgsql security definer set search_path = public as $$
declare r expense_reports;
begin
  if not has_permission('report.build') then raise exception 'not permitted'; end if;
  select * into r from expense_reports where id = p_id for update;
  if not found then raise exception 'report not found'; end if;
  if r.status not in ('draft', 'returned') then raise exception 'this report is already %', r.status; end if;
  if not exists (select 1 from report_items where report_id = p_id) then raise exception 'the report has no items'; end if;
  update report_items set status = 'pending', director_note = null where report_id = p_id;
  update expense_reports set status = 'submitted', submitted_at = now(), notes = nullif(btrim(p_notes), ''),
         summary = (select coalesce(jsonb_object_agg(kind, total), '{}'::jsonb)
                    from (select kind, sum(amount) as total from report_items where report_id = p_id group by kind) s)
   where id = p_id returning * into r;
  perform write_audit('report.submit', 'expense_reports', p_id::text, null, to_jsonb(r), p_notes);
  return r;
end $$;

create or replace function decide_report_item(p_item uuid, p_status text, p_note text) returns report_items
language plpgsql security definer set search_path = public as $$
declare i report_items; r expense_reports;
begin
  if not has_permission('report.signoff') then raise exception 'not permitted'; end if;
  if p_status not in ('confirmed', 'rejected') then raise exception 'status must be confirmed or rejected'; end if;
  select * into i from report_items where id = p_item for update;
  if not found then raise exception 'item not found'; end if;
  select * into r from expense_reports where id = i.report_id;
  if r.status <> 'submitted' then raise exception 'the report is %, not waiting for review', r.status; end if;
  if p_status = 'rejected' and coalesce(btrim(p_note), '') = '' then raise exception 'write why this item is rejected'; end if;
  update report_items set status = p_status, director_note = nullif(btrim(p_note), '') where id = p_item returning * into i;
  perform write_audit('report.item_' || p_status, 'report_items', p_item::text, null, to_jsonb(i), p_note);
  return i;
end $$;

create or replace function sign_off_report(p_id uuid, p_approve boolean, p_notes text) returns expense_reports
language plpgsql security definer set search_path = public as $$
declare r expense_reports;
begin
  if not has_permission('report.signoff') then raise exception 'not permitted'; end if;
  select * into r from expense_reports where id = p_id for update;
  if not found then raise exception 'report not found'; end if;
  if r.status <> 'submitted' then raise exception 'the report is %, not waiting for sign-off', r.status; end if;
  if r.created_by = auth.uid() then raise exception 'you cannot sign off a report you built'; end if;
  if p_approve and exists (select 1 from report_items where report_id = p_id and status = 'pending') then
    raise exception 'confirm or reject every item before signing off'; end if;
  if not p_approve and coalesce(btrim(p_notes), '') = '' then raise exception 'write what must be fixed'; end if;
  update expense_reports set status = case when p_approve then 'signed_off' else 'returned' end,
         signed_by = auth.uid(), signed_at = now(), director_notes = nullif(btrim(p_notes), '')
   where id = p_id returning * into r;
  perform write_audit('report.' || case when p_approve then 'signoff' else 'return' end, 'expense_reports', p_id::text, null, to_jsonb(r), p_notes);
  return r;
end $$;

-- ───────────── Supplier payments: made by the director, recorded after sign-off ─────────────
create table supplier_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  report_id uuid references expense_reports(id),          -- required for big suppliers (signed-off report)
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('bank','mpesa','cash','cheque')),
  reference text, paid_by uuid not null references staff(id),
  at timestamptz not null default now(), idempotency_key text not null unique);
alter table supplier_payments enable row level security;
create trigger spay_immutable before update or delete on supplier_payments for each row execute function forbid_change();

create or replace function record_supplier_payment(p_supplier uuid, p_amount numeric, p_method text, p_ref text, p_report uuid, p_key text)
returns supplier_payments language plpgsql security definer set search_path = public as $$
declare v supplier_payments; r expense_reports; sup suppliers; owed numeric;
begin
  select * into v from supplier_payments where idempotency_key = p_key;
  if found then return v; end if;
  select * into sup from suppliers where id = p_supplier;
  if not found then raise exception 'supplier not found'; end if;
  if sup.is_big then
    -- big suppliers: the director pays after signing off the report, then records it
    if not has_permission('supplier.pay') then raise exception 'not permitted'; end if;
    select * into r from expense_reports where id = p_report;
    if not found or r.status <> 'signed_off' then raise exception 'payments to big suppliers can only be recorded against a signed-off report'; end if;
  else
    if not (has_permission('supplier.pay') or has_permission('expense.record')) then raise exception 'not permitted'; end if;
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if p_method not in ('bank', 'mpesa', 'cash', 'cheque') then raise exception 'bad payment method'; end if;
  if p_method <> 'cash' and coalesce(btrim(p_ref), '') = '' then raise exception 'enter the payment reference'; end if;
  select coalesce(sum(amount), 0) into owed from supplier_ledger where supplier_id = p_supplier;
  if p_amount > owed then raise exception 'amount exceeds what is owed (KES %)', owed; end if;
  insert into supplier_payments(supplier_id, report_id, amount, method, reference, paid_by, idempotency_key)
  values (p_supplier, case when sup.is_big then p_report end, p_amount, p_method, nullif(btrim(p_ref), ''), auth.uid(), p_key)
  returning * into v;
  insert into supplier_ledger(supplier_id, kind, amount, ref_table, ref_id, note, actor_id)
  values (p_supplier, 'payment', -p_amount, 'supplier_payments', v.id, p_method || coalesce(' ' || nullif(btrim(p_ref), ''), ''), auth.uid());
  if p_method = 'cash' and not sup.is_big then       -- cash from the till: it must show in the day's cash position
    insert into expenses(category, amount, description, recorded_by, idempotency_key)
    values ('Supplier payment', p_amount, 'Paid ' || sup.name, auth.uid(), 'spay:' || v.id::text);
  end if;
  perform write_audit('supplier.pay', 'supplier_payments', v.id::text, null, to_jsonb(v));
  return v;
end $$;

-- ───────────── Read views (gated inside, run as owner) ─────────────
create or replace view supplier_balances with (security_invoker = false) as
select s.id as supplier_id, s.name, s.kind, s.is_big, s.phone,
       coalesce(sum(l.amount) filter (where l.kind = 'invoice'), 0) as invoiced,
       coalesce(-sum(l.amount) filter (where l.kind = 'payment'), 0) as paid,
       coalesce(sum(l.amount), 0) as owed
from suppliers s left join supplier_ledger l on l.supplier_id = s.id
where s.active and (has_permission('supplier.manage') or has_permission('goods.receive') or has_permission('report.view'))
group by s.id;

create or replace view receipts_v with (security_invoker = false) as
select g.id, g.receipt_no, g.business_date, g.delivery_note, s.name as supplier_name, g.total_cost, g.note,
       st.full_name as received_by_name,
       (select count(*) from goods_receipt_lines l where l.receipt_id = g.id) as lines
from goods_receipts g join suppliers s on s.id = g.supplier_id join staff st on st.id = g.received_by
where has_permission('goods.receive') or has_permission('report.view');

create or replace view expenses_v with (security_invoker = false) as
select e.id, e.business_date, e.category, e.amount, e.description, e.receipt_ref, s.full_name as recorded_by_name,
       (v.expense_id is not null) as voided, v.reason as void_reason
from expenses e join staff s on s.id = e.recorded_by left join expense_voids v on v.expense_id = e.id
where has_permission('expense.record') or has_permission('report.view') or has_permission('recon.view_all');

create or replace view reports_v with (security_invoker = false) as
select r.id, r.period_start, r.period_end, r.status, r.notes, r.director_notes, r.submitted_at, r.signed_at,
       c.full_name as created_by_name, sg.full_name as signed_by_name, r.created_by,
       (select coalesce(sum(amount) filter (where kind = 'supplier_invoice'), 0) from report_items where report_id = r.id) as supplier_total,
       (select coalesce(sum(amount) filter (where kind in ('maintenance','payroll','other')), 0) from report_items where report_id = r.id) as other_total,
       (select coalesce(sum(amount) filter (where kind = 'deduction'), 0) from report_items where report_id = r.id) as deductions,
       (select coalesce(sum(amount) filter (where kind = 'expense_small'), 0) from report_items where report_id = r.id) as small_expenses
from expense_reports r join staff c on c.id = r.created_by left join staff sg on sg.id = r.signed_by
where has_permission('report.view') or has_permission('report.build');

create or replace view report_items_v with (security_invoker = false) as
select i.id, i.report_id, i.kind, i.description, i.amount, i.status, i.director_note, i.supplier_id, i.staff_id,
       s.name as supplier_name, st.full_name as staff_name
from report_items i left join suppliers s on s.id = i.supplier_id left join staff st on st.id = i.staff_id
where has_permission('report.view') or has_permission('report.build');

-- Cash shortages and stock losses in a period, to help decide deductions (a human decides)
create or replace function deduction_suggestions(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('report.build') or has_permission('report.view')) then raise exception 'not permitted'; end if;
  return jsonb_build_object(
    'cash_shortages', coalesce((select jsonb_agg(jsonb_build_object('staff_id', waiter_id, 'name', full_name, 'date', business_date, 'short', variance, 'note', notes))
                                from recon_cash where business_date between p_start and p_end and received and variance > 0), '[]'::jsonb),
    'stock_losses', coalesce((select jsonb_agg(jsonb_build_object('staff_id', m.actor_id, 'name', s.full_name, 'product', p.name, 'type', m.type, 'qty', m.qty_base, 'note', m.note, 'date', business_date(m.at)))
                              from stock_movements m join products p on p.id = m.product_id join staff s on s.id = m.actor_id
                              where m.type in ('breakage', 'wastage') and business_date(m.at) between p_start and p_end), '[]'::jsonb));
end $$;

create or replace view stock_room with (security_invoker = false) as
select p.id as product_id, p.name, p.base_unit, l.kind::text as location_kind,
       sum(case when m.to_location = l.id then m.qty_base else -m.qty_base end) as qty,
       p.reorder_level, p.purchase_cost
from stock_movements m
join locations l on l.id in (m.to_location, m.from_location) and l.kind in ('store', 'kitchen', 'choma') and l.custodian_id is null
join products p on p.id = m.product_id
where has_permission('stock.view_all') or has_permission('station.' || l.kind::text)
group by p.id, p.name, p.base_unit, l.kind, l.id, p.reorder_level, p.purchase_cost;

grant select on supplier_balances, receipts_v, expenses_v, reports_v, report_items_v, stock_room to authenticated;
revoke all on supplier_balances, receipts_v, expenses_v, reports_v, report_items_v, stock_room from anon;
revoke execute on function add_supplier(text, text, text, boolean), receive_goods(uuid, text, text, jsonb, text),
  record_expense(text, numeric, text, text, text), void_expense(uuid, text),
  record_location_count(location_kind, uuid, numeric, text), build_report(date, date),
  add_report_item(uuid, text, uuid, uuid, text, numeric), remove_report_item(uuid), submit_report(uuid, text),
  decide_report_item(uuid, text, text), sign_off_report(uuid, boolean, text),
  record_supplier_payment(uuid, numeric, text, text, uuid, text), deduction_suggestions(date, date) from public, anon;
grant execute on function add_supplier(text, text, text, boolean), receive_goods(uuid, text, text, jsonb, text),
  record_expense(text, numeric, text, text, text), void_expense(uuid, text),
  record_location_count(location_kind, uuid, numeric, text), build_report(date, date),
  add_report_item(uuid, text, uuid, uuid, text, numeric), remove_report_item(uuid), submit_report(uuid, text),
  decide_report_item(uuid, text, text), sign_off_report(uuid, boolean, text),
  record_supplier_payment(uuid, numeric, text, text, uuid, text), deduction_suggestions(date, date) to authenticated;
