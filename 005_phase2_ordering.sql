-- Grills Lounge POS — Phase 2 database layer: tabs, orders, queues, claim and status moves
-- Run after 004_profile_rpcs.sql. All writes are RPCs; the app reads through the views below.

alter table orders add column if not exists ticket_no bigint generated always as identity;
create unique index if not exists orders_ticket_no_key on orders(ticket_no);

-- ───────────── Shift helper (one "Day" shift per business date for now) ─────────────
create or replace function current_shift() returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; d date := business_date(now());
begin
  select id into v from shifts where business_date = d and name = 'Day';
  if v is null then
    insert into shifts(business_date, name) values (d, 'Day') on conflict (business_date, name) do nothing;
    select id into v from shifts where business_date = d and name = 'Day';
  end if;
  return v;
end $$;

-- ───────────── open_tab: idempotent; a table with an active tab returns that tab ─────────────
create or replace function open_tab(p_table uuid, p_customer text, p_key text) returns tabs
language plpgsql security definer set search_path = public as $$
declare v tabs;
begin
  if not has_permission('tab.open') then raise exception 'not permitted'; end if;
  select * into v from tabs where idempotency_key = p_key;
  if found then return v; end if;
  if p_table is null and coalesce(btrim(p_customer), '') = '' then
    raise exception 'table or customer name required'; end if;
  if p_table is not null then
    select * into v from tabs where table_id = p_table
      and status in ('open','bill_requested','partially_paid','reopened');
    if found then return v; end if;
  end if;
  insert into tabs(table_id, customer_name, waiter_id, shift_id, idempotency_key)
  values (p_table, nullif(btrim(p_customer), ''), auth.uid(), current_shift(), p_key)
  returning * into v;
  if p_table is not null then update floor_tables set status = 'occupied' where id = p_table; end if;
  perform write_audit('tab.open', 'tabs', v.id::text, null, to_jsonb(v));
  return v;
end $$;

-- ───────────── submit_order: one order, many lines, routed by product station ─────────────
-- p_items: [{"product_id":"…","qty":2,"notes":"no ice"}]. Price is snapshotted server-side.
-- Station "none" products have nothing to prepare, so they are recorded as served at once.
create or replace function submit_order(p_tab uuid, p_items jsonb, p_terminal text, p_key text)
returns orders language plpgsql security definer set search_path = public as $$
declare v_tab tabs; v_order orders; v_term uuid; it jsonb; v_p products; v_qty numeric;
        v_item uuid; v_status item_status; me staff;
begin
  if not has_permission('tab.open') then raise exception 'not permitted'; end if;
  select * into v_order from orders where idempotency_key = p_key;
  if found then return v_order; end if;                      -- retry-safe
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'order has no items'; end if;
  select * into v_tab from tabs where id = p_tab for update;
  if not found then raise exception 'tab not found'; end if;
  if v_tab.status in ('settled', 'closed_credit') then raise exception 'tab is closed'; end if;
  select * into me from staff where id = auth.uid();
  if v_tab.waiter_id <> auth.uid() and not (me.is_captain or has_permission('tab.view_all')) then
    raise exception 'tab belongs to another waiter'; end if;
  select id into v_term from terminals where code = p_terminal;

  insert into orders(tab_id, entered_by, responsible_waiter, terminal_id, idempotency_key)
  values (p_tab, auth.uid(), v_tab.waiter_id, v_term, p_key) returning * into v_order;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'bad quantity'; end if;
    select * into v_p from products where id = (it->>'product_id')::uuid and active and available;
    if not found then raise exception 'a product is unavailable'; end if;
    if v_p.selling_price is null then raise exception '% has no price', v_p.name; end if;
    v_status := (case when v_p.station = 'none' then 'served' else 'new' end)::item_status;
    insert into order_items(order_id, tab_id, product_id, station, qty, unit_price, notes, status)
    values (v_order.id, p_tab, v_p.id, v_p.station, v_qty, v_p.selling_price,
            nullif(btrim(it->>'notes'), ''), v_status)
    returning id into v_item;
    insert into order_item_events(item_id, status, actor_id) values (v_item, v_status, auth.uid());
  end loop;

  if v_tab.status = 'bill_requested' then update tabs set status = 'open' where id = p_tab; end if;
  perform write_audit('order.submit', 'orders', v_order.id::text, null, to_jsonb(v_order));
  return v_order;
end $$;

-- ───────────── claim_item: atomic; the second terminal gets "already claimed" ─────────────
create or replace function claim_item(p_item uuid, p_terminal text) returns order_items
language plpgsql security definer set search_path = public as $$
declare v order_items; t uuid;
begin
  select * into v from order_items where id = p_item;
  if not found then raise exception 'item not found'; end if;
  if not has_permission('station.' || v.station::text) then raise exception 'not permitted'; end if;
  select id into t from terminals where code = p_terminal;
  update order_items set claimed_by = auth.uid(), claimed_terminal = t, claimed_at = now(), status = 'accepted'
   where id = p_item and claimed_by is null and status = 'new'
   returning * into v;
  if not found then raise exception 'already claimed'; end if;
  insert into order_item_events(item_id, status, actor_id) values (p_item, 'accepted', auth.uid());
  return v;
end $$;

-- ───────────── update_item_status: forward steps only ─────────────
-- accepted → preparing → ready → served. Station staff move food/drinks; the owning waiter
-- (or station staff) marks served. Cancelling needs a reason/approval flow (later).
create or replace function update_item_status(p_item uuid, p_status item_status) returns order_items
language plpgsql security definer set search_path = public as $$
declare v order_items; owner uuid;
begin
  select * into v from order_items where id = p_item for update;
  if not found then raise exception 'item not found'; end if;
  if not ((v.status = 'accepted'  and p_status = 'preparing')
       or (v.status = 'preparing' and p_status = 'ready')
       or (v.status = 'ready'     and p_status = 'served')) then
    raise exception 'cannot move % to %', v.status, p_status; end if;
  if p_status = 'served' then
    select waiter_id into owner from tabs where id = v.tab_id;
    if not (has_permission('station.' || v.station::text)
            or (has_permission('item.mark_served') and owner = auth.uid())
            or has_permission('tab.view_all')) then raise exception 'not permitted'; end if;
  elsif not has_permission('station.' || v.station::text) then
    raise exception 'not permitted';
  end if;
  update order_items set status = p_status where id = p_item returning * into v;
  insert into order_item_events(item_id, status, actor_id) values (p_item, p_status, auth.uid());
  return v;
end $$;

-- ───────────── Read views (filtered by the caller inside the view) ─────────────
create or replace view station_queue as
select i.id as item_id, i.order_id, o.ticket_no, i.tab_id,
       ft.number as table_number, t.customer_name, s.full_name as waiter_name,
       p.name as product_name, i.station, i.qty, i.notes, i.status,
       i.claimed_by, ct.code as claimed_terminal, i.created_at
from order_items i
join orders o on o.id = i.order_id
join tabs t on t.id = i.tab_id
left join floor_tables ft on ft.id = t.table_id
join staff s on s.id = t.waiter_id
join products p on p.id = i.product_id
left join terminals ct on ct.id = i.claimed_terminal
where i.status not in ('served', 'cancelled')
  and (has_permission('station.' || i.station::text)
       or has_permission('tab.view_all')
       or t.waiter_id = auth.uid());

create or replace view tab_cards as
select t.id as tab_id, ft.number as table_number, t.customer_name,
       t.waiter_id, s.full_name as waiter_name, t.status, t.opened_at,
       b.bill_total, b.paid, b.balance,
       coalesce((select sum(i.qty * i.unit_price) from order_items i
                 where i.tab_id = t.id and i.status not in ('served', 'cancelled')), 0) as pending_total
from tabs t
left join floor_tables ft on ft.id = t.table_id
join staff s on s.id = t.waiter_id
join tab_balances b on b.tab_id = t.id
where t.status in ('open', 'bill_requested', 'partially_paid', 'reopened')
  and (t.waiter_id = auth.uid() or has_permission('tab.view_all'));

grant select on station_queue, tab_cards to authenticated;
revoke all on station_queue, tab_cards from anon;

-- Realtime: queues refresh when order items or tabs change
do $$ begin alter publication supabase_realtime add table order_items;
  exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table tabs;
  exception when duplicate_object then null; end $$;

revoke execute on function open_tab(uuid,text,text), submit_order(uuid,jsonb,text,text),
  claim_item(uuid,text), update_item_status(uuid,item_status), current_shift() from public, anon;
grant execute on function open_tab(uuid,text,text), submit_order(uuid,jsonb,text,text),
  claim_item(uuid,text), update_item_status(uuid,item_status) to authenticated;
