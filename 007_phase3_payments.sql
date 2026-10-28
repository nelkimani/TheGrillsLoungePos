-- Grills Lounge POS — Phase 3: payments, bills, tab closing (run after 005 and 006)

-- ───────────── Settle a tab only when nothing is owed AND nothing is still unserved ─────────────
create or replace function settle_if_clear(p_tab uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_bal numeric; v_pending int; v_table uuid;
begin
  select balance into v_bal from tab_balances where tab_id = p_tab;
  select count(*) into v_pending from order_items where tab_id = p_tab and status not in ('served', 'cancelled');
  if v_bal = 0 and v_pending = 0
     and exists (select 1 from order_items where tab_id = p_tab and status = 'served') then
    update tabs set status = 'settled', closed_at = now()
     where id = p_tab and status not in ('settled', 'closed_credit')
    returning table_id into v_table;
    if v_table is not null then update floor_tables set status = 'available' where id = v_table; end if;
  end if;
end $$;

-- ───────────── record_payment v2: change due, M-Pesa code rules, safe retries ─────────────
drop function if exists record_payment(uuid, pay_method, numeric, timestamptz, text, text);

create or replace function record_payment(
  p_tab uuid, p_method pay_method, p_amount numeric, p_mpesa_code text, p_key text,
  p_tendered numeric default null) returns payments
language plpgsql security definer set search_path = public as $$
declare v_tab tabs; v_bal numeric; v_row payments; v_code text; v_change numeric;
begin
  if not has_permission('payment.record') then raise exception 'not permitted'; end if;
  select * into v_row from payments where idempotency_key = p_key;
  if found then return v_row; end if;                              -- retry-safe: same key, same payment
  select * into v_tab from tabs where id = p_tab for update;
  if not found then raise exception 'tab not found'; end if;
  if v_tab.waiter_id <> auth.uid() and not has_permission('payment.record_any') then
    raise exception 'tab belongs to another waiter'; end if;
  if v_tab.status in ('settled', 'closed_credit') then raise exception 'tab already closed'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  select balance into v_bal from tab_balances where tab_id = p_tab;
  if p_amount > v_bal then raise exception 'amount exceeds the balance (KES %)', v_bal; end if;

  if p_method = 'mpesa' then
    v_code := upper(btrim(coalesce(p_mpesa_code, '')));
    if v_code !~ '^[A-Z0-9]{10}$' then raise exception 'M-Pesa code must be 10 letters/numbers'; end if;
  else
    v_code := null;
    if p_tendered is not null then
      if p_tendered < p_amount then raise exception 'cash given is less than the amount'; end if;
      v_change := p_tendered - p_amount;
    end if;
  end if;

  begin
    insert into payments(tab_id, method, amount, waiter_id, shift_id, txn_time, mpesa_code,
                         tendered_amount, change_given, idempotency_key)
    values (p_tab, p_method, p_amount, auth.uid(), coalesce(v_tab.shift_id, current_shift()), now(), v_code,
            case when p_method = 'cash' then p_tendered end, v_change, p_key)
    returning * into v_row;
  exception when unique_violation then
    select * into v_row from payments where idempotency_key = p_key;
    if found then return v_row; end if;
    raise exception 'This M-Pesa code has already been recorded';
  end;

  update tabs set status = 'partially_paid' where id = p_tab and status in ('open', 'bill_requested', 'reopened');
  perform settle_if_clear(p_tab);
  perform write_audit('payment.record', 'payments', v_row.id::text, null, to_jsonb(v_row));
  return v_row;
end $$;

-- ───────────── request_bill / close_tab ─────────────
create or replace function request_bill(p_tab uuid) returns tabs
language plpgsql security definer set search_path = public as $$
declare v tabs;
begin
  select * into v from tabs where id = p_tab for update;
  if not found then raise exception 'tab not found'; end if;
  if v.waiter_id <> auth.uid() and not has_permission('tab.view_all') then raise exception 'not permitted'; end if;
  update tabs set status = 'bill_requested' where id = p_tab and status in ('open', 'reopened') returning * into v;
  if not found then select * into v from tabs where id = p_tab; end if;
  return v;
end $$;

create or replace function close_tab(p_tab uuid) returns tabs
language plpgsql security definer set search_path = public as $$
declare v tabs;
begin
  select * into v from tabs where id = p_tab for update;
  if not found then raise exception 'tab not found'; end if;
  if v.waiter_id <> auth.uid() and not has_permission('tab.view_all') then raise exception 'not permitted'; end if;
  if not exists (select 1 from order_items where tab_id = p_tab) then       -- opened by mistake, nothing ordered
    update tabs set status = 'settled', closed_at = now() where id = p_tab and status not in ('settled', 'closed_credit');
    if v.table_id is not null then update floor_tables set status = 'available' where id = v.table_id; end if;
  else
    perform settle_if_clear(p_tab);
  end if;
  select * into v from tabs where id = p_tab;
  if v.status <> 'settled' then raise exception 'Cannot close: money is owed or items are not served yet'; end if;
  perform write_audit('tab.close', 'tabs', p_tab::text, null, jsonb_build_object('status', v.status));
  return v;
end $$;

-- Serving the last item on an already-paid tab settles it
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
  if p_status = 'served' then perform settle_if_clear(v.tab_id); end if;
  return v;
end $$;

-- ───────────── Bill lines (interim bill and receipts) ─────────────
create or replace view tab_bill_lines as
select i.id as item_id, i.tab_id, p.name as product_name, i.qty, i.unit_price,
       i.qty * i.unit_price as line_total, i.status, i.created_at
from order_items i
join products p on p.id = i.product_id
join tabs t on t.id = i.tab_id
where i.status <> 'cancelled'
  and (t.waiter_id = auth.uid() or has_permission('tab.view_all'));

grant select on tab_bill_lines to authenticated;
revoke all on tab_bill_lines from anon;

revoke execute on function record_payment(uuid, pay_method, numeric, text, text, numeric),
  request_bill(uuid), close_tab(uuid), settle_if_clear(uuid), update_item_status(uuid, item_status)
  from public, anon;
grant execute on function record_payment(uuid, pay_method, numeric, text, text, numeric),
  request_bill(uuid), close_tab(uuid), update_item_status(uuid, item_status) to authenticated;
