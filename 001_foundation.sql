-- Grills Lounge Ndagani POS — Phase 1 foundation (PostgreSQL / Supabase)
-- No real catalogue, prices, stock or staff are included. Demo seed lives in seed_demo.sql (later).

create extension if not exists pgcrypto;

-- ───────────── Settings & time ─────────────
create table business_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into business_settings(key,value) values
 ('timezone','"Africa/Nairobi"'),
 ('currency','"KES"'),
 ('day_rollover_hour','5'),
 ('billable_from_food','"served"'),
 ('billable_from_drinks','"served"'),
 ('liquor_custody_deducted_on','"served"'),
 ('bartender_collects_payments','false'),
 ('vat_rate_percent','null'),            -- unset until confirmed
 ('service_charge_percent','null'),
 ('prices_tax_inclusive','null');

create or replace function business_date(ts timestamptz) returns date
language sql stable as $$
  select ((ts at time zone 'Africa/Nairobi')
          - make_interval(hours => coalesce((select (value)::int from business_settings where key='day_rollover_hour'),5)))::date
$$;

-- ───────────── Staff, roles, permissions ─────────────
create table roles (code text primary key, name text not null);
insert into roles values ('manager','Manager'),('accountant','Accountant'),('waiter','Waiter'),
 ('head_chef','Head chef'),('choma','Nyama choma attendant'),('bartender','Bartender');

create table permissions (code text primary key, description text);
create table role_permissions (
  role_code text references roles(code), permission_code text references permissions(code),
  primary key (role_code, permission_code));

create table staff (
  id uuid primary key references auth.users(id),
  staff_no text unique not null,
  full_name text not null,
  is_captain boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table staff_roles (
  staff_id uuid references staff(id), role_code text references roles(code),
  primary key (staff_id, role_code));
create table staff_permission_overrides (
  staff_id uuid references staff(id), permission_code text references permissions(code),
  granted boolean not null, primary key (staff_id, permission_code));

create or replace function has_permission(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.granted from staff_permission_overrides o where o.staff_id = auth.uid() and o.permission_code = p),
    exists (select 1 from staff s join staff_roles sr on sr.staff_id = s.id
            join role_permissions rp on rp.role_code = sr.role_code
            where s.id = auth.uid() and s.active and rp.permission_code = p))
$$;

create table terminals (id uuid primary key default gen_random_uuid(), code text unique not null, name text not null);
create table shifts (
  id uuid primary key default gen_random_uuid(),
  business_date date not null, name text not null,
  opened_at timestamptz not null default now(), closed_at timestamptz,
  unique (business_date, name));

-- ───────────── Immutability helper ─────────────
create or replace function forbid_change() returns trigger language plpgsql as $$
begin raise exception '% is append-only; use a reversal entry', tg_table_name; end $$;

-- ───────────── Audit ─────────────
create table approvals (
  id uuid primary key default gen_random_uuid(),
  kind text not null, requested_by uuid not null references staff(id),
  approved_by uuid references staff(id), reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  payload jsonb, created_at timestamptz not null default now(), decided_at timestamptz,
  check (approved_by is distinct from requested_by));  -- no self-approval
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid, actor_role text, device text,
  action text not null, entity text not null, entity_id text,
  old_values jsonb, new_values jsonb, reason text, approval_id uuid references approvals(id));
create trigger audit_immutable before update or delete on audit_log
  for each row execute function forbid_change();

create or replace function write_audit(a text, e text, eid text, o jsonb, n jsonb, r text default null, ap uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_log(actor_id, actor_role, action, entity, entity_id, old_values, new_values, reason, approval_id)
  values (auth.uid(), (select string_agg(role_code, ',') from staff_roles where staff_id = auth.uid()), a, e, eid, o, n, r, ap)
$$;

-- ───────────── Catalogue ─────────────
create table categories (
  id uuid primary key default gen_random_uuid(), name text unique not null,
  parent_id uuid references categories(id));
create table units (code text primary key, name text not null);   -- bottle, crate, ml, kg, portion...
create type station as enum ('bar','kitchen','choma','none');

create table products (
  id uuid primary key default gen_random_uuid(),
  sku text unique, barcode text unique,
  name text not null, description text,
  category_id uuid references categories(id),
  station station not null default 'none',
  is_liquor boolean not null default false,          -- liquor follows requisition/custody rules
  base_unit text not null references units(code),
  sale_unit text references units(code),
  selling_price numeric(12,2) check (selling_price >= 0),
  purchase_cost numeric(12,2) check (purchase_cost >= 0),
  reorder_level numeric(14,3),
  tax_code text, image_url text,
  available boolean not null default true,
  active boolean not null default true,
  is_demo boolean not null default false,
  created_at timestamptz not null default now());

create table unit_conversions (
  product_id uuid references products(id), from_unit text references units(code),
  to_unit text references units(code), factor numeric(14,4) not null check (factor > 0),
  primary key (product_id, from_unit, to_unit));   -- e.g. crate→bottle 24; bottle→tot configured per product

create table recipes (product_id uuid primary key references products(id), yield_note text);
create table recipe_ingredients (
  product_id uuid references recipes(product_id),
  ingredient_id uuid references products(id),
  qty_base numeric(14,4) not null check (qty_base > 0),
  wastage_allowance_pct numeric(5,2) not null default 0,
  primary key (product_id, ingredient_id));

-- ───────────── Locations & stock ledger ─────────────
create type location_kind as enum ('main_bar','waiter','kitchen','choma','store','wastage');
create table locations (
  id uuid primary key default gen_random_uuid(),
  kind location_kind not null, name text not null,
  custodian_id uuid references staff(id),            -- set for kind = 'waiter'
  unique (kind, custodian_id, name));

create type movement_type as enum (
 'opening','purchase','transfer_to_waiter','direct_sale','tab_sale','exchange_out','exchange_in',
 'wastage','breakage','complimentary','staff_meal','count_adjust','approved_return','recipe_consume','transfer');

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  from_location uuid references locations(id),
  to_location uuid references locations(id),          -- null = leaves business stock (sale/consumption)
  qty_base numeric(14,3) not null check (qty_base > 0),
  type movement_type not null,
  ref_table text, ref_id uuid,
  shift_id uuid references shifts(id),
  actor_id uuid not null references staff(id),
  approval_id uuid references approvals(id),
  reverses_id uuid references stock_movements(id),
  idempotency_key text unique,
  note text, at timestamptz not null default now(),
  check (from_location is not null or to_location is not null),
  check (type <> 'approved_return' or approval_id is not null));
create trigger stock_immutable before update or delete on stock_movements
  for each row execute function forbid_change();
create index on stock_movements (product_id, at);
create index on stock_movements (ref_table, ref_id);

create view stock_balance as
select product_id, location_id, sum(qty) as qty_base from (
  select product_id, to_location   as location_id,  qty_base as qty from stock_movements where to_location   is not null
  union all
  select product_id, from_location as location_id, -qty_base as qty from stock_movements where from_location is not null
) m group by product_id, location_id;

create table stock_counts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id), product_id uuid not null references products(id),
  expected_qty numeric(14,3) not null, counted_qty numeric(14,3) not null,
  variance numeric(14,3) generated always as (counted_qty - expected_qty) stored,
  explanation text, counted_by uuid not null references staff(id),
  business_date date not null, at timestamptz not null default now());

-- ───────────── Tables, tabs, orders ─────────────
create table floor_tables (
  id uuid primary key default gen_random_uuid(),
  number text unique not null, label text,
  status text not null default 'available' check (status in ('available','occupied','reserved','cleaning')));

create type tab_status as enum ('open','bill_requested','partially_paid','settled','closed_credit','reopened');
create table tabs (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references floor_tables(id),
  customer_name text,
  waiter_id uuid not null references staff(id),
  status tab_status not null default 'open',
  shift_id uuid references shifts(id),
  business_date date not null default business_date(now()),
  opened_at timestamptz not null default now(), closed_at timestamptz,
  credit_approval_id uuid references approvals(id),
  idempotency_key text unique);
create unique index one_active_tab_per_table on tabs(table_id)
  where table_id is not null and status in ('open','bill_requested','partially_paid','reopened');

create table orders (
  id uuid primary key default gen_random_uuid(),
  tab_id uuid not null references tabs(id),
  entered_by uuid not null references staff(id),
  responsible_waiter uuid not null references staff(id),
  terminal_id uuid references terminals(id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now());

create type item_status as enum ('new','accepted','preparing','ready','served','cancelled');
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  tab_id uuid not null references tabs(id),
  product_id uuid not null references products(id),
  station station not null,
  qty numeric(10,3) not null check (qty > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),   -- price snapshot at order time
  notes text, modifiers jsonb,
  status item_status not null default 'new',
  served_from uuid references locations(id),    -- waiter custody for liquor
  cancel_reason text, cancel_approval_id uuid references approvals(id),
  created_at timestamptz not null default now());
create index on order_items (station, status);
create index on order_items (tab_id);

create table order_item_events (
  id bigint generated always as identity primary key,
  item_id uuid not null references order_items(id),
  status item_status not null, actor_id uuid references staff(id), at timestamptz not null default now());

create type adjustment_kind as enum ('discount','void','complimentary','refund');
create table tab_adjustments (
  id uuid primary key default gen_random_uuid(),
  tab_id uuid not null references tabs(id), item_id uuid references order_items(id),
  kind adjustment_kind not null, amount numeric(12,2) not null check (amount > 0),
  reason text not null, approval_id uuid not null references approvals(id),
  actor_id uuid not null references staff(id), at timestamptz not null default now());

-- ───────────── Payments ─────────────
create type pay_method as enum ('cash','mpesa');
create type pay_status as enum ('recorded','verified','disputed');
create table payments (
  id uuid primary key default gen_random_uuid(),
  receipt_no bigint generated always as identity unique,
  tab_id uuid not null references tabs(id),
  method pay_method not null,
  amount numeric(12,2) not null check (amount <> 0),          -- negative only for reversals
  waiter_id uuid not null references staff(id),
  shift_id uuid references shifts(id),
  business_date date not null default business_date(now()),
  txn_time timestamptz not null, entered_at timestamptz not null default now(),
  mpesa_code text, mpesa_code_norm text generated always as (upper(btrim(mpesa_code))) stored,
  status pay_status not null default 'recorded',
  reverses_id uuid references payments(id), reversal_approval_id uuid references approvals(id),
  idempotency_key text not null unique,
  check ((method = 'mpesa') = (mpesa_code is not null)),
  check ((amount < 0) = (reverses_id is not null)),
  check (reverses_id is null or reversal_approval_id is not null));
create unique index uniq_mpesa_code on payments(mpesa_code_norm) where amount > 0 and mpesa_code is not null;
create trigger pay_immutable before update or delete on payments for each row execute function forbid_change();
-- verification state lives in a separate append-only table, never by editing the payment
create table mpesa_verifications (
  id bigint generated always as identity primary key,
  payment_id uuid not null references payments(id),
  status pay_status not null check (status in ('verified','disputed')),
  matched_ref text, discrepancy_reason text,
  verified_by uuid not null references staff(id), at timestamptz not null default now());

create table cash_handovers (
  id uuid primary key default gen_random_uuid(),
  waiter_id uuid not null references staff(id), shift_id uuid references shifts(id),
  business_date date not null,
  declared_amount numeric(12,2) not null check (declared_amount >= 0), declared_at timestamptz not null default now(),
  actual_amount numeric(12,2) check (actual_amount >= 0),
  received_by uuid references staff(id), received_at timestamptz, notes text,
  idempotency_key text unique);

create table daily_closes (
  id uuid primary key default gen_random_uuid(),
  business_date date not null, shift_id uuid references shifts(id),
  submitted_by uuid references staff(id), submitted_at timestamptz,
  approved_by uuid references staff(id), approved_at timestamptz,
  status text not null default 'draft' check (status in ('draft','submitted','approved','returned','provisional')),
  notes text);

-- ───────────── Requisitions (waiter liquor) ─────────────
create table requisitions (
  id uuid primary key default gen_random_uuid(),
  waiter_id uuid not null references staff(id), tab_id uuid references tabs(id),
  status text not null default 'pending' check (status in ('pending','released','rejected','cancelled')),
  released_by uuid references staff(id), released_at timestamptz,
  idempotency_key text not null unique, created_at timestamptz not null default now());
create table requisition_lines (
  id uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references requisitions(id),
  product_id uuid not null references products(id),
  qty_requested numeric(14,3) not null check (qty_requested > 0),
  qty_released numeric(14,3) check (qty_released >= 0));

-- ───────────── Views for money ─────────────
create view tab_totals as
select t.id as tab_id,
  coalesce((select sum(i.qty*i.unit_price) from order_items i
            where i.tab_id=t.id and i.status = 'served'),0)   -- decided: lines bill only when SERVED
  - coalesce((select sum(a.amount) from tab_adjustments a where a.tab_id=t.id),0) as bill_total,
  coalesce((select sum(p.amount) from payments p where p.tab_id=t.id),0) as paid
from tabs t;
-- NOTE: billable_from rule (submitted/ready/served) is applied in the Phase 4 revision of this view.

create view tab_balances as
select *, bill_total - paid as balance from tab_totals;

create view waiter_cash_expected as
select waiter_id, business_date, shift_id, sum(amount) as expected_cash
from payments where method = 'cash' group by 1,2,3;   -- M-Pesa excluded by definition

-- cash variance = expected − actual ; POSITIVE = SHORTAGE, NEGATIVE = SURPLUS
create view waiter_cash_variance as
select e.waiter_id, e.business_date, e.shift_id, e.expected_cash,
       h.declared_amount, h.actual_amount,
       e.expected_cash - h.actual_amount as variance
from waiter_cash_expected e
left join cash_handovers h on h.waiter_id=e.waiter_id and h.business_date=e.business_date
                          and h.shift_id is not distinct from e.shift_id;

-- ───────────── Core RPC: idempotent payment recording ─────────────
create or replace function record_payment(
  p_tab uuid, p_method pay_method, p_amount numeric, p_txn_time timestamptz,
  p_mpesa_code text, p_key text) returns payments
language plpgsql security definer set search_path = public as $$
declare v_tab tabs; v_bal numeric; v_row payments;
begin
  if not has_permission('payment.record') then raise exception 'not permitted'; end if;
  select * into v_row from payments where idempotency_key = p_key;
  if found then return v_row; end if;                       -- retry-safe
  select * into v_tab from tabs where id = p_tab for update;
  if v_tab.waiter_id <> auth.uid() and not has_permission('payment.record_any') then
    raise exception 'tab belongs to another waiter'; end if;
  if v_tab.status in ('settled','closed_credit') then raise exception 'tab already closed'; end if;
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  select balance into v_bal from tab_balances where tab_id = p_tab;
  if p_amount > v_bal then raise exception 'amount exceeds outstanding balance (%)', v_bal; end if;

  insert into payments(tab_id, method, amount, waiter_id, shift_id, txn_time, mpesa_code, idempotency_key)
  values (p_tab, p_method, p_amount, auth.uid(), v_tab.shift_id, p_txn_time,
          case when p_method='mpesa' then p_mpesa_code end, p_key)
  returning * into v_row;                                   -- unique index rejects duplicate M-Pesa codes

  update tabs set status = case when v_bal - p_amount = 0 then 'settled' else 'partially_paid' end,
                  closed_at = case when v_bal - p_amount = 0 then now() end
  where id = p_tab;
  perform write_audit('payment.record','payments', v_row.id::text, null, to_jsonb(v_row));
  return v_row;
end $$;

-- ───────────── Row Level Security (baseline) ─────────────
alter table payments enable row level security;
alter table stock_movements enable row level security;
alter table tabs enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table cash_handovers enable row level security;
alter table audit_log enable row level security;
alter table requisitions enable row level security;

-- Read-only policies; writes happen only through SECURITY DEFINER RPCs.
create policy pay_read on payments for select
  using (waiter_id = auth.uid() or has_permission('recon.view_all'));
create policy tabs_read on tabs for select
  using (waiter_id = auth.uid() or has_permission('tab.view_all'));
create policy orders_read on orders for select
  using (responsible_waiter = auth.uid() or entered_by = auth.uid() or has_permission('tab.view_all'));
create policy items_read on order_items for select
  using (has_permission('station.' || station::text) or has_permission('tab.view_all')
         or exists (select 1 from tabs t where t.id = tab_id and t.waiter_id = auth.uid()));
create policy stock_read on stock_movements for select
  using (has_permission('stock.view_all') or actor_id = auth.uid());
create policy handover_read on cash_handovers for select
  using (waiter_id = auth.uid() or has_permission('recon.view_all'));
create policy audit_read on audit_log for select using (has_permission('audit.view'));
create policy req_read on requisitions for select
  using (waiter_id = auth.uid() or has_permission('requisition.release') or has_permission('stock.view_all'));

-- TODO Phase 2+: submit_order, update_item_status, open_tab, transfer_table, close_tab (credit approval).
-- TODO Phase 3: create_requisition, release_requisition, direct_bar_sale, request_exchange, post_adjustment, receive_goods.
-- TODO Phase 5: declare_handover, acknowledge_handover, verify_mpesa, submit_daily_close, approve_daily_close.
-- TODO: seed permissions + role_permissions per the matrix in ARCHITECTURE.md.
