-- Grills Lounge POS — 012: a bartender serves his OWN bar orders in one tap, then payment can be recorded.
-- Also: a tab whose items were all cancelled can now be closed.

create or replace function serve_my_bar_items(p_tab uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_tab tabs; r record; n int := 0;
begin
  if not has_permission('station.bar') then raise exception 'not permitted'; end if;
  select * into v_tab from tabs where id = p_tab for update;
  if not found then raise exception 'tab not found'; end if;
  if v_tab.waiter_id <> auth.uid() then raise exception 'You can only serve drinks on your own tabs'; end if;
  if v_tab.status in ('settled', 'closed_credit') then raise exception 'tab is closed'; end if;
  for r in select id from order_items
            where tab_id = p_tab and station = 'bar' and status in ('new','accepted','preparing','ready')
            order by created_at for update loop
    update order_items set status = 'served', claimed_by = coalesce(claimed_by, auth.uid()),
           claimed_at = coalesce(claimed_at, now()) where id = r.id;
    insert into order_item_events(item_id, status, actor_id) values (r.id, 'served', auth.uid());
    perform deduct_for_item(r.id);                  -- stock leaves the bar once, even if retried
    n := n + 1;
  end loop;
  if n > 0 then perform write_audit('bar.serve_own', 'tabs', p_tab::text, null, jsonb_build_object('items', n)); end if;
  perform settle_if_clear(p_tab);
  return n;
end $$;

revoke execute on function serve_my_bar_items(uuid) from public, anon;
grant execute on function serve_my_bar_items(uuid) to authenticated;

create or replace function close_tab(p_tab uuid) returns tabs
language plpgsql security definer set search_path = public as $$
declare v tabs;
begin
  select * into v from tabs where id = p_tab for update;
  if not found then raise exception 'tab not found'; end if;
  if v.waiter_id <> auth.uid() and not has_permission('tab.view_all') then raise exception 'not permitted'; end if;
  if not exists (select 1 from order_items where tab_id = p_tab and status <> 'cancelled') then
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
revoke execute on function close_tab(uuid) from public, anon;
grant execute on function close_tab(uuid) to authenticated;
