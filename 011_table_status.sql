-- Grills Lounge POS — 011: every waiter can see which tables are in use (and by whom), without seeing amounts.
create or replace view table_status with (security_invoker = false) as
select ft.id as table_id, ft.number as table_number,
       t.id as tab_id, t.waiter_id, s.full_name as waiter_name
from floor_tables ft
left join tabs t on t.table_id = ft.id and t.status in ('open','bill_requested','partially_paid','reopened')
left join staff s on s.id = t.waiter_id
where auth.uid() is not null;

grant select on table_status to authenticated;
revoke all on table_status from anon;

-- A waiter can no longer "open" a table that someone else is serving
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
    if found then
      if v.waiter_id <> auth.uid() and not has_permission('tab.view_all') then
        raise exception 'This table is being served by another waiter';
      end if;
      return v;
    end if;
  end if;
  insert into tabs(table_id, customer_name, waiter_id, shift_id, idempotency_key)
  values (p_table, nullif(btrim(p_customer), ''), auth.uid(), current_shift(), p_key)
  returning * into v;
  if p_table is not null then update floor_tables set status = 'occupied' where id = p_table; end if;
  perform write_audit('tab.open', 'tabs', v.id::text, null, to_jsonb(v));
  return v;
end $$;
