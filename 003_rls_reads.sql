-- Grills Lounge Ndagani POS — Phase 1 RLS read policies (run after 002_phase1.sql)
-- Writes still happen only through SECURITY DEFINER RPCs. These are read-only.

-- Enable RLS everywhere (idempotent). Tables with no policy below stay fully locked.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Reference data: any signed-in person (including terminal device accounts) can read
create policy ref_read_categories on categories for select to authenticated using (true);
create policy ref_read_units on units for select to authenticated using (true);
create policy ref_read_products on products for select to authenticated using (active);
create policy ref_read_tables on floor_tables for select to authenticated using (true);
create policy ref_read_locations on locations for select to authenticated using (true);
create policy ref_read_terminals on terminals for select to authenticated using (true);
create policy ref_read_shifts on shifts for select to authenticated using (true);
create policy ref_read_favs on product_favourites for select to authenticated using (true);
create policy ref_read_settings on business_settings for select to authenticated using (true);

-- Staff: your own row, or everything if you manage staff. pin_hash must never reach the browser.
create policy staff_read on staff for select to authenticated
  using (id = auth.uid() or has_permission('staff.manage'));
revoke select on staff from authenticated, anon;
grant select (id, staff_no, full_name, is_captain, active, created_at) on staff to authenticated;

-- Safe directory for pickers (names only, no PIN data)
create or replace view staff_directory as
  select id, staff_no, full_name, is_captain from staff where active;
grant select on staff_directory to authenticated;

-- Tables that views and screens need to read
create policy adj_read on tab_adjustments for select to authenticated
  using (has_permission('tab.view_all')
         or exists (select 1 from tabs t where t.id = tab_id and t.waiter_id = auth.uid()));
create policy mv_read on mpesa_verifications for select to authenticated
  using (has_permission('recon.view_all'));
create policy close_read on daily_closes for select to authenticated
  using (has_permission('recon.view_all'));
create policy count_read on stock_counts for select to authenticated
  using (counted_by = auth.uid() or has_permission('stock.view_all'));
create policy reqline_read on requisition_lines for select to authenticated
  using (exists (select 1 from requisitions r where r.id = requisition_id
                 and (r.waiter_id = auth.uid() or has_permission('requisition.release')
                      or has_permission('stock.view_all'))));
create policy approvals_read on approvals for select to authenticated
  using (requested_by = auth.uid() or has_permission('approval.grant'));
create policy events_read on order_item_events for select to authenticated
  using (exists (select 1 from order_items i where i.id = item_id));  -- inherits order_items policy

-- Views must run as the caller so the policies above apply (otherwise they leak across waiters)
alter view stock_balance set (security_invoker = true);
alter view tab_totals set (security_invoker = true);
alter view tab_balances set (security_invoker = true);
alter view waiter_cash_expected set (security_invoker = true);
alter view waiter_cash_variance set (security_invoker = true);

-- No grants to anon at all
revoke all on all tables in schema public from anon;
