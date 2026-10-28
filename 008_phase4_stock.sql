-- Grills Lounge POS — Phase 4: bar stock ledger (run after 007)
-- Model: the bartender serves every order from the main bar. Stock leaves the bar when an item
-- is marked SERVED. All movements are append-only; corrections are new movements.

-- ───────────── Locations ─────────────
insert into locations(kind, name)
select v.kind::location_kind, v.name
from (values ('main_bar','Main Bar'), ('store','Store'), ('wastage','Wastage'),
             ('kitchen','Kitchen'), ('choma','Choma')) as v(kind, name)
where not exists (select 1 from locations l where l.kind = v.kind::location_kind and l.name = v.name);

create or replace function loc(k location_kind) returns uuid
language sql stable security definer set search_path = public as $$
  select id from locations where kind = k and custodian_id is null order by name limit 1
$$;

-- ───────────── Deduct bar stock when an item is served ─────────────
-- Serving is never blocked by stock problems: a missing unit conversion is logged for the manager,
-- and negative stock is allowed but flagged on the stock screen.
create or replace function deduct_for_item(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v order_items; p products; q numeric; f numeric; mtype movement_type;
begin
  select * into v from order_items where id = p_item;
  if not found or v.station <> 'bar' then return; end if;
  select * into p from products where id = v.product_id;
  if p.sale_unit is null or p.sale_unit = p.base_unit then
    q := v.qty;
  else
    select factor into f from unit_conversions
     where product_id = p.id and from_unit = p.sale_unit and to_unit = p.base_unit;
    if f is null then
      perform write_audit('stock.conversion_missing', 'order_items', p_item::text, null,
                          jsonb_build_object('product', p.name, 'sale_unit', p.sale_unit, 'base_unit', p.base_unit));
      return;
    end if;
    q := v.qty * f;
  end if;
  -- a tab opened by a bartender is a bar (direct) sale; any other tab is a waiter sale
  mtype := (case when exists (select 1 from tabs t join staff_roles sr on sr.staff_id = t.waiter_id
                              where t.id = v.tab_id and sr.role_code = 'bartender')
                 then 'direct_sale' else 'tab_sale' end)::movement_type;
  insert into stock_movements(product_id, from_location, to_location, qty_base, type, ref_table, ref_id,
                              shift_id, actor_id, idempotency_key)
  values (p.id, loc('main_bar'), null, q, mtype, 'order_items', p_item, current_shift(), auth.uid(), 'serve:' || p_item)
  on conflict (idempotency_key) do nothing;                         -- serving twice can never deduct twice
end $$;

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
  if p_status = 'served' then
    perform deduct_for_item(p_item);
    perform settle_if_clear(v.tab_id);
  end if;
  return v;
end $$;

-- ───────────── Stock in (opening stock, purchases) ─────────────
create or replace function stock_in(p_product uuid, p_qty numeric, p_type movement_type, p_note text, p_key text)
returns stock_movements language plpgsql security definer set search_path = public as $$
declare v stock_movements;
begin
  if p_type = 'opening' then
    if not has_permission('stock.adjust') then raise exception 'not permitted'; end if;
  elsif p_type = 'purchase' then
    if not has_permission('goods.receive') then raise exception 'not permitted'; end if;
  else raise exception 'stock in must be opening or purchase'; end if;
  select * into v from stock_movements where idempotency_key = p_key;
  if found then return v; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'quantity must be positive'; end if;
  insert into stock_movements(product_id, from_location, to_location, qty_base, type, shift_id, actor_id, idempotency_key, note)
  values (p_product, null, loc('main_bar'), p_qty, p_type, current_shift(), auth.uid(), p_key, nullif(btrim(p_note), ''))
  returning * into v;
  perform write_audit('stock.in', 'stock_movements', v.id::text, null, to_jsonb(v));
  return v;
end $$;

-- ───────────── Stock out: wastage, breakage, complimentary, staff meal ─────────────
create or replace function _post_out(p_product uuid, p_qty numeric, p_type movement_type, p_reason text,
                                     p_actor uuid, p_approval uuid, p_key text)
returns stock_movements language plpgsql security definer set search_path = public as $$
declare v stock_movements; dest uuid;
begin
  if p_type not in ('wastage', 'breakage', 'complimentary', 'staff_meal') then raise exception 'bad stock-out type'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'quantity must be positive'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason required'; end if;
  select * into v from stock_movements where idempotency_key = p_key;
  if found then return v; end if;
  dest := case when p_type in ('wastage', 'breakage') then loc('wastage') else null end;
  insert into stock_movements(product_id, from_location, to_location, qty_base, type, shift_id, actor_id,
                              approval_id, idempotency_key, note)
  values (p_product, loc('main_bar'), dest, p_qty, p_type, current_shift(), p_actor, p_approval, p_key, p_reason)
  returning * into v;
  return v;
end $$;

-- Manager posts directly
create or replace function post_stock_out(p_product uuid, p_qty numeric, p_type movement_type, p_reason text, p_key text)
returns stock_movements language plpgsql security definer set search_path = public as $$
declare v stock_movements;
begin
  if not has_permission('stock.adjust') then raise exception 'not permitted'; end if;
  v := _post_out(p_product, p_qty, p_type, p_reason, auth.uid(), null, p_key);
  perform write_audit('stock.out', 'stock_movements', v.id::text, null, to_jsonb(v), p_reason);
  return v;
end $$;

-- Bartender requests; nothing moves until a manager approves
create or replace function request_stock_out(p_product uuid, p_qty numeric, p_type movement_type, p_reason text, p_key text)
returns approvals language plpgsql security definer set search_path = public as $$
declare a approvals; pname text;
begin
  if not (has_permission('station.bar') or has_permission('stock.adjust')) then raise exception 'not permitted'; end if;
  select * into a from approvals where requested_by = auth.uid() and payload->>'key' = p_key;
  if found then return a; end if;
  if p_type not in ('wastage', 'breakage', 'complimentary', 'staff_meal') then raise exception 'bad stock-out type'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'quantity must be positive'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason required'; end if;
  select name into pname from products where id = p_product;
  if pname is null then raise exception 'product not found'; end if;
  insert into approvals(kind, requested_by, reason, payload)
  values ('stock_out', auth.uid(), p_reason,
          jsonb_build_object('product_id', p_product, 'product_name', pname, 'qty', p_qty, 'type', p_type, 'key', p_key))
  returning * into a;
  perform write_audit('approval.request', 'approvals', a.id::text, null, to_jsonb(a), p_reason, a.id);
  return a;
end $$;

create or replace function decide_approval(p_id uuid, p_approve boolean) returns approvals
language plpgsql security definer set search_path = public as $$
declare a approvals; pl jsonb;
begin
  if not has_permission('approval.grant') then raise exception 'not permitted'; end if;
  select * into a from approvals where id = p_id for update;
  if not found then raise exception 'approval not found'; end if;
  if a.status <> 'pending' then raise exception 'already decided'; end if;
  if a.requested_by = auth.uid() then raise exception 'you cannot approve your own request'; end if;
  update approvals set status = case when p_approve then 'approved' else 'rejected' end,
                       approved_by = auth.uid(), decided_at = now()
   where id = p_id returning * into a;
  if p_approve and a.kind = 'stock_out' then
    pl := a.payload;
    perform _post_out((pl->>'product_id')::uuid, (pl->>'qty')::numeric, (pl->>'type')::movement_type,
                      a.reason, a.requested_by, a.id, 'appr:' || a.id);
  end if;
  perform write_audit('approval.decide', 'approvals', p_id::text, null, to_jsonb(a), a.reason, a.id);
  return a;
end $$;

-- ───────────── Stock count: records the variance, then aligns the book with the shelf ─────────────
create or replace function record_stock_count(p_product uuid, p_counted numeric, p_explanation text)
returns stock_counts language plpgsql security definer set search_path = public as $$
declare v stock_counts; bar uuid := loc('main_bar'); expected numeric; diff numeric;
begin
  if not has_permission('stock.count') then raise exception 'not permitted'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'counted quantity is invalid'; end if;
  select coalesce(sum(qty), 0) into expected from (
    select qty_base as qty from stock_movements where product_id = p_product and to_location = bar
    union all
    select -qty_base from stock_movements where product_id = p_product and from_location = bar) m;
  diff := p_counted - expected;
  if diff <> 0 and coalesce(btrim(p_explanation), '') = '' then raise exception 'explain the difference'; end if;
  insert into stock_counts(location_id, product_id, expected_qty, counted_qty, explanation, counted_by, business_date)
  values (bar, p_product, expected, p_counted, nullif(btrim(p_explanation), ''), auth.uid(), business_date(now()))
  returning * into v;
  if diff > 0 then
    insert into stock_movements(product_id, from_location, to_location, qty_base, type, ref_table, ref_id, shift_id, actor_id, note)
    values (p_product, null, bar, diff, 'count_adjust', 'stock_counts', v.id, current_shift(), auth.uid(), p_explanation);
  elsif diff < 0 then
    insert into stock_movements(product_id, from_location, to_location, qty_base, type, ref_table, ref_id, shift_id, actor_id, note)
    values (p_product, bar, null, -diff, 'count_adjust', 'stock_counts', v.id, current_shift(), auth.uid(), p_explanation);
  end if;
  perform write_audit('stock.count', 'stock_counts', v.id::text, null, to_jsonb(v), p_explanation);
  return v;
end $$;

-- ───────────── Read views ─────────────
create or replace view bar_stock as
select p.id as product_id, p.name, p.base_unit, c.name as category, p.reorder_level,
       coalesce(b.qty_base, 0) as on_hand,
       (p.reorder_level is not null and coalesce(b.qty_base, 0) <= p.reorder_level) as low,
       coalesce(b.qty_base, 0) < 0 as negative
from products p
left join categories c on c.id = p.category_id
left join stock_balance b on b.product_id = p.id and b.location_id = loc('main_bar')
where p.active and p.station = 'bar'
  and (has_permission('station.bar') or has_permission('stock.view_all'));

create or replace view stock_log as
select m.id, m.at, p.name as product_name, m.type, m.qty_base,
       lf.name as from_name, lt.name as to_name, s.full_name as actor_name, m.note
from stock_movements m
join products p on p.id = m.product_id
left join locations lf on lf.id = m.from_location
left join locations lt on lt.id = m.to_location
join staff s on s.id = m.actor_id
where has_permission('stock.view_all');

create or replace view approvals_inbox as
select a.id, a.kind, a.reason, a.payload, a.status, a.created_at, s.full_name as requester_name
from approvals a join staff s on s.id = a.requested_by
where has_permission('approval.grant') or a.requested_by = auth.uid();

grant select on bar_stock, stock_log, approvals_inbox to authenticated;
revoke all on bar_stock, stock_log, approvals_inbox from anon;

revoke execute on function loc(location_kind), deduct_for_item(uuid), _post_out(uuid, numeric, movement_type, text, uuid, uuid, text),
  stock_in(uuid, numeric, movement_type, text, text), post_stock_out(uuid, numeric, movement_type, text, text),
  request_stock_out(uuid, numeric, movement_type, text, text), decide_approval(uuid, boolean),
  record_stock_count(uuid, numeric, text), update_item_status(uuid, item_status) from public, anon;
grant execute on function stock_in(uuid, numeric, movement_type, text, text),
  post_stock_out(uuid, numeric, movement_type, text, text),
  request_stock_out(uuid, numeric, movement_type, text, text), decide_approval(uuid, boolean),
  record_stock_count(uuid, numeric, text), update_item_status(uuid, item_status) to authenticated;
