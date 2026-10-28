-- Grills Lounge Ndagani POS — Phase 1 (run after 001_foundation.sql)
-- Roles/permissions seed, PIN login support, terminals, demo floor, catalogue import.
-- No real catalogue, prices, stock or staff. Demo rows are flagged is_demo.

-- ───────────── Settings confirmed ─────────────
update business_settings set value = '5' where key = 'day_rollover_hour';
insert into business_settings(key,value) values
  ('payments_require_online','true'),
  ('pin_max_failures','5'),
  ('pin_lock_minutes','5'),
  ('idle_lock_seconds','30')
on conflict (key) do update set value = excluded.value;

-- ───────────── Addendum A schema deltas ─────────────
alter table terminals add column if not exists kind text check (kind in ('kitchen','bar','office'));
alter table terminals add column if not exists device_user_id uuid references auth.users(id);
alter table staff add column if not exists pin_hash text,
  add column if not exists pin_failed int not null default 0,
  add column if not exists pin_locked_until timestamptz;
alter table order_items add column if not exists claimed_by uuid references staff(id),
  add column if not exists claimed_terminal uuid references terminals(id),
  add column if not exists claimed_at timestamptz;
alter table requisitions add column if not exists claimed_by uuid references staff(id),
  add column if not exists claimed_at timestamptz;
alter table payments add column if not exists tendered_amount numeric(12,2),
  add column if not exists change_given numeric(12,2);
alter table payments add constraint chg_chk
  check (change_given is null or tendered_amount - change_given = amount);
alter table audit_log add column if not exists terminal_id uuid references terminals(id);
create table if not exists product_favourites (
  product_id uuid primary key references products(id), sort int not null);

-- Fix: an M-Pesa reversal row must not be blocked by the unique-code index (already partial on amount > 0). Kept as is.

-- ───────────── Permissions seed ─────────────
insert into permissions(code, description) values
 ('staff.manage','Manage staff, roles, PINs'),
 ('catalogue.manage','Edit products, prices, recipes, locations'),
 ('catalogue.import','Import catalogue CSV/XLSX'),
 ('tab.open','Open tabs and add rounds'),
 ('tab.view_all','View all tabs and orders'),
 ('order.captain','Order on behalf of another waiter'),
 ('table.transfer','Transfer table (needs approval)'),
 ('station.kitchen','Kitchen queue actions'),
 ('station.choma','Choma queue actions'),
 ('station.bar','Bar queue actions'),
 ('item.mark_served','Mark delivered/served'),
 ('payment.record','Record cash/M-Pesa on own tabs'),
 ('payment.record_any','Record payment on any tab'),
 ('adjustment.request','Request discount/void/refund'),
 ('adjustment.approve','Approve discount/void/refund'),
 ('requisition.request','Request liquor from bar'),
 ('requisition.release','Release liquor to waiter'),
 ('bar.direct_sale','Direct bar sale'),
 ('stock.return_approve','Approve return of stock to bar'),
 ('exchange.request','Request equal-price exchange'),
 ('exchange.process','Process exchange'),
 ('stock.adjust','Wastage and stock adjustments'),
 ('stock.count','Record stock counts'),
 ('stock.view_all','View all stock movements'),
 ('goods.receive','Goods receipts and purchases'),
 ('handover.declare','Declare own cash handover'),
 ('handover.acknowledge','Acknowledge cash handover'),
 ('recon.view_all','Reconciliation dashboard'),
 ('recon.verify_mpesa','Verify M-Pesa'),
 ('dailyclose.submit','Submit daily close'),
 ('dailyclose.approve','Approve daily close'),
 ('report.cogs','COGS, profit, margins'),
 ('audit.view','View audit log'),
 ('approval.grant','Grant manager approvals')
on conflict do nothing;

-- Manager: everything except nothing denied by matrix (manager can do all listed).
insert into role_permissions(role_code, permission_code)
select 'manager', code from permissions on conflict do nothing;

insert into role_permissions(role_code, permission_code) values
 -- Accountant: reviews, verifies, submits close; no sales, no stock changes
 ('accountant','recon.view_all'),('accountant','recon.verify_mpesa'),
 ('accountant','handover.acknowledge'),('accountant','dailyclose.submit'),
 ('accountant','stock.view_all'),('accountant','goods.receive'),('accountant','audit.view'),
 -- Waiter
 ('waiter','tab.open'),('waiter','item.mark_served'),('waiter','payment.record'),
 ('waiter','adjustment.request'),('waiter','requisition.request'),
 ('waiter','exchange.request'),('waiter','handover.declare'),('waiter','stock.count'),
 -- Head chef
 ('head_chef','station.kitchen'),('head_chef','item.mark_served'),
 ('head_chef','stock.count'),('head_chef','stock.adjust'),
 -- Choma attendant
 ('choma','station.choma'),('choma','item.mark_served'),
 ('choma','stock.count'),('choma','stock.adjust'),
 -- Bartender (payments only if enabled via per-user override)
 ('bartender','station.bar'),('bartender','item.mark_served'),
 ('bartender','requisition.release'),('bartender','bar.direct_sale'),
 ('bartender','exchange.process'),('bartender','adjustment.request'),
 ('bartender','stock.count'),('bartender','tab.open')
on conflict do nothing;
-- Captain waiters get order.captain via staff.is_captain (checked in submit_order, Phase 2).

-- ───────────── Terminals (demo codes) ─────────────
insert into terminals(code, name, kind) values
 ('T1','Kitchen + Choma','kitchen'),
 ('T2','Bar A','bar'),
 ('T3','Bar B','bar'),
 ('OFFICE','Office','office')
on conflict (code) do nothing;

-- ───────────── PIN handling ─────────────
-- Hash: crypt(pin, gen_salt('bf')). PIN must be 6 digits. Plain PIN is never stored.
create or replace function set_staff_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not has_permission('staff.manage') then raise exception 'not permitted'; end if;
  if p_pin !~ '^[0-9]{6}$' then raise exception 'PIN must be exactly 6 digits'; end if;
  update staff set pin_hash = crypt(p_pin, gen_salt('bf')), pin_failed = 0, pin_locked_until = null
   where id = p_staff;
  perform write_audit('staff.set_pin','staff', p_staff::text, null, null);
end $$;

-- Called ONLY by the terminal-login Edge Function (service role). It then mints
-- a short-lived Supabase session for the returned staff id.
create or replace function verify_staff_pin(p_staff_no text, p_pin text, p_terminal text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare s staff; v_max int; v_lock int; t uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not permitted'; end if;
  select id into t from terminals where code = p_terminal;
  select (value)::int into v_max from business_settings where key='pin_max_failures';
  select (value)::int into v_lock from business_settings where key='pin_lock_minutes';
  select * into s from staff where staff_no = p_staff_no and active for update;
  if not found or s.pin_hash is null then raise exception 'invalid credentials'; end if;
  if s.pin_locked_until is not null and s.pin_locked_until > now() then
    raise exception 'locked until %', s.pin_locked_until; end if;
  if s.pin_hash = crypt(p_pin, s.pin_hash) then
    update staff set pin_failed = 0, pin_locked_until = null where id = s.id;
    insert into audit_log(actor_id, action, entity, entity_id, terminal_id)
      values (s.id,'pin.login','staff', s.id::text, t);
    return s.id;
  end if;
  update staff set pin_failed = pin_failed + 1,
         pin_locked_until = case when pin_failed + 1 >= v_max
                                 then now() + make_interval(mins => v_lock) end
   where id = s.id;
  insert into audit_log(actor_id, action, entity, entity_id, terminal_id, new_values)
    values (s.id,'pin.fail','staff', s.id::text, t, jsonb_build_object('failed', s.pin_failed + 1));
  raise exception 'invalid credentials';
end $$;
revoke all on function verify_staff_pin(text,text,text) from public, anon, authenticated;

-- ───────────── Demo floor ─────────────
insert into floor_tables(number, label)
select n::text, 'Demo table ' || n from generate_series(1,12) n
on conflict (number) do nothing;

-- ───────────── Base reference data ─────────────
insert into units(code,name) values
 ('bottle','Bottle'),('crate','Crate'),('ml','Millilitre'),('tot','Tot'),
 ('kg','Kilogram'),('g','Gram'),('portion','Portion'),('piece','Piece')
on conflict do nothing;

-- ───────────── Catalogue import ─────────────
-- Client parses CSV/XLSX and sends rows as jsonb array; this validates and upserts by sku.
-- Row keys: sku, barcode, name, category, station, is_liquor, base_unit, sale_unit,
--           selling_price, purchase_cost, reorder_level, is_demo
create or replace function import_catalogue(p_rows jsonb, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; i int := 0; ok int := 0; errs jsonb := '[]'; cat uuid; v_station station;
begin
  if not has_permission('catalogue.import') then raise exception 'not permitted'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      if coalesce(btrim(r->>'name'),'') = '' then raise exception 'name required'; end if;
      if coalesce(btrim(r->>'sku'),'') = '' then raise exception 'sku required'; end if;
      if not exists (select 1 from units where code = r->>'base_unit') then
        raise exception 'unknown base_unit %', r->>'base_unit'; end if;
      v_station := coalesce(nullif(r->>'station',''),'none')::station;
      if (r->>'selling_price') is not null and (r->>'selling_price')::numeric < 0 then
        raise exception 'negative price'; end if;
      cat := null;
      if nullif(r->>'category','') is not null then
        insert into categories(name) values (r->>'category')
          on conflict (name) do update set name = excluded.name returning id into cat;
      end if;
      if not p_dry_run then
        insert into products(sku,barcode,name,category_id,station,is_liquor,base_unit,sale_unit,
                             selling_price,purchase_cost,reorder_level,is_demo)
        values (r->>'sku', nullif(r->>'barcode',''), r->>'name', cat, v_station,
                coalesce((r->>'is_liquor')::boolean,false), r->>'base_unit',
                nullif(r->>'sale_unit',''), (r->>'selling_price')::numeric,
                (r->>'purchase_cost')::numeric, (r->>'reorder_level')::numeric,
                coalesce((r->>'is_demo')::boolean,false))
        on conflict (sku) do update set
          barcode = excluded.barcode, name = excluded.name, category_id = excluded.category_id,
          station = excluded.station, is_liquor = excluded.is_liquor, base_unit = excluded.base_unit,
          sale_unit = excluded.sale_unit, selling_price = excluded.selling_price,
          purchase_cost = excluded.purchase_cost, reorder_level = excluded.reorder_level;
      end if;
      ok := ok + 1;
    exception when others then
      errs := errs || jsonb_build_object('row', i, 'sku', r->>'sku', 'error', sqlerrm);
    end;
  end loop;
  if not p_dry_run then
    perform write_audit('catalogue.import','products', null, null,
            jsonb_build_object('rows_ok', ok, 'rows_failed', jsonb_array_length(errs)));
  end if;
  return jsonb_build_object('dry_run', p_dry_run, 'ok', ok, 'errors', errs);
end $$;
