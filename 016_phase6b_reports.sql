-- Grills Lounge POS — Phase 6B: the four owner reports (run after 015)
--   1. Sales by day, product and waiter     2. Profit and cost of sales
--   3. Stock valuation and shrinkage        4. Cash, M-Pesa and credit summary
-- Read-only: nothing here changes any record. Each report is one function that checks the
-- caller's permission itself and returns JSON for the screen.

-- ───────────── Permissions ─────────────
insert into permissions(code, description) values
  ('report.sales',  'View the sales and the cash / M-Pesa / credit reports'),
  ('report.profit', 'View profit, cost of sales and stock valuation (these show costs)')
on conflict (code) do nothing;
insert into role_permissions(role_code, permission_code) values
  ('director',   'report.sales'), ('director',   'report.profit'),
  ('accountant', 'report.sales'), ('accountant', 'report.profit'),
  ('manager',    'report.sales')
on conflict do nothing;

-- ───────────── Internal helpers (not callable from the app) ─────────────

-- Every served line in the period. The sale date is the business day the line was SERVED
-- (that is when it becomes billable); older lines with no event fall back to the order time.
create or replace function _sold_lines(p_start date, p_end date)
returns table(item_id uuid, sale_date date, tab_id uuid, waiter_id uuid, product_id uuid,
              qty numeric, unit_price numeric, line_total numeric)
language sql stable security definer set search_path = public as $$
  select i.id, d.sale_date, i.tab_id, t.waiter_id, i.product_id, i.qty, i.unit_price, i.qty * i.unit_price
  from order_items i
  join tabs t on t.id = i.tab_id
  left join lateral (select min(ev.at) as at from order_item_events ev
                      where ev.item_id = i.id and ev.status = 'served') e on true
  cross join lateral (select business_date(coalesce(e.at, i.created_at)) as sale_date) d
  where i.status = 'served' and d.sale_date between p_start and p_end
$$;

-- Cost per BASE unit: the latest delivery price on or before the date, else the product's stored
-- cost. NULL means "no cost known" so the screens can warn instead of silently using zero.
create or replace function _unit_cost(p_product uuid, p_date date) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select l.unit_cost from goods_receipt_lines l join goods_receipts g on g.id = l.receipt_id
      where l.product_id = p_product and g.business_date <= p_date
      order by g.created_at desc, l.id desc limit 1),
    (select purchase_cost from products where id = p_product))
$$;

-- ═════════════ 1. Sales by day, product and waiter ═════════════
create or replace function report_sales(p_start date, p_end date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not has_permission('report.sales') then raise exception 'not permitted'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'choose a valid period'; end if;
  if p_end - p_start > 400 then raise exception 'choose a period of 400 days or less'; end if;

  with s as (select * from _sold_lines(p_start, p_end)),
  adj as (select a.kind::text as kind, a.amount, business_date(a.at) as d, t.waiter_id
            from tab_adjustments a join tabs t on t.id = a.tab_id
           where business_date(a.at) between p_start and p_end),
  by_day as (
    select d.d, coalesce(x.gross, 0) as gross, coalesce(x.tabs, 0) as tabs, coalesce(a.adj, 0) as adjustments
    from generate_series(p_start, p_end, interval '1 day') g(d0)
    cross join lateral (select g.d0::date as d) d
    left join (select sale_date, sum(line_total) as gross, count(distinct tab_id) as tabs from s group by 1) x on x.sale_date = d.d
    left join (select adj.d, sum(amount) as adj from adj group by 1) a on a.d = d.d),
  by_product as (
    select p.id, p.name, coalesce(c.name, 'Other') as category, p.station::text as station,
           sum(s.qty) as qty, sum(s.line_total) as gross, count(distinct s.tab_id) as tabs
    from s join products p on p.id = s.product_id left join categories c on c.id = p.category_id
    group by p.id, p.name, c.name, p.station),
  by_waiter as (
    select st.id, st.full_name, st.staff_no,
           coalesce(x.gross, 0) as gross, coalesce(x.tabs, 0) as tabs, coalesce(x.items, 0) as items,
           coalesce(a.adj, 0) as adjustments
    from staff st
    left join (select waiter_id, sum(line_total) as gross, count(distinct tab_id) as tabs, count(*) as items from s group by 1) x on x.waiter_id = st.id
    left join (select waiter_id, sum(amount) as adj from adj group by 1) a on a.waiter_id = st.id
    where x.waiter_id is not null or a.waiter_id is not null)
  select jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'totals', jsonb_build_object(
        'gross', coalesce((select sum(line_total) from s), 0),
        'adjustments', coalesce((select sum(amount) from adj), 0),
        'tabs', (select count(distinct tab_id) from s),
        'items', (select count(*) from s),
        'adjustments_by_kind', coalesce((select jsonb_object_agg(kind, tot) from (select kind, sum(amount) as tot from adj group by 1) k), '{}'::jsonb)),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'gross', gross, 'adjustments', adjustments, 'tabs', tabs) order by d) from by_day), '[]'::jsonb),
    'by_product', coalesce((select jsonb_agg(jsonb_build_object('product', name, 'category', category, 'station', station, 'qty', qty, 'gross', gross, 'tabs', tabs) order by gross desc, name) from by_product), '[]'::jsonb),
    'by_waiter', coalesce((select jsonb_agg(jsonb_build_object('waiter', full_name, 'staff_no', staff_no, 'tabs', tabs, 'items', items, 'gross', gross, 'adjustments', adjustments) order by gross desc, full_name) from by_waiter), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- ═════════════ 2. Profit and cost of sales ═════════════
-- Bar and drinks: cost of what was actually deducted from the bar when items were served.
-- Kitchen and choma have no recipes, so their cost is the stock USED, taken from stock counts
-- (purchases are not a cost until the stock is used). That figure is only as good as the counts.
create or replace function report_profit(p_start date, p_end date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not has_permission('report.profit') then raise exception 'not permitted'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'choose a valid period'; end if;
  if p_end - p_start > 400 then raise exception 'choose a period of 400 days or less'; end if;

  with s as (select sl.*, p.station::text as station from _sold_lines(p_start, p_end) sl join products p on p.id = sl.product_id),
  sales_by as (select station, sum(line_total) as v from s group by 1),
  adj as (select coalesce(sum(amount), 0) as v from tab_adjustments where business_date(at) between p_start and p_end),
  bar_mv as (select product_id, sum(qty_base) as qty from stock_movements
              where type in ('tab_sale', 'direct_sale') and business_date(at) between p_start and p_end group by 1),
  bar_sold as (select product_id, sum(qty) as qty, sum(line_total) as sales from s where station = 'bar' group by 1),
  bar_rows as (
    select p.id, p.name, coalesce(bs.qty, 0) as qty_sold, coalesce(bs.sales, 0) as sales,
           coalesce(bm.qty, 0) as qty_base, uc.c as unit_cost, p.base_unit,
           round(coalesce(bm.qty, 0) * coalesce(uc.c, 0), 2) as cost
    from products p
    left join bar_sold bs on bs.product_id = p.id
    left join bar_mv bm on bm.product_id = p.id
    cross join lateral (select _unit_cost(p.id, p_end) as c) uc
    where bs.product_id is not null or bm.product_id is not null),
  food_mv as (
    select m.product_id, l.kind::text as kind,
           sum(case when m.from_location = l.id then m.qty_base else 0 end)
         - sum(case when m.to_location = l.id and m.type <> 'purchase' then m.qty_base else 0 end) as used
    from stock_movements m join locations l on l.id in (m.to_location, m.from_location)
    where l.kind in ('kitchen', 'choma') and l.custodian_id is null and business_date(m.at) between p_start and p_end
    group by m.product_id, l.kind),
  food_rows as (
    select p.name, f.kind, p.base_unit, f.used as qty_used, uc.c as unit_cost, round(f.used * coalesce(uc.c, 0), 2) as cost
    from food_mv f join products p on p.id = f.product_id
    cross join lateral (select _unit_cost(p.id, p_end) as c) uc
    where f.used <> 0),
  loss_mv as (
    select m.type::text as kind, p.name, p.base_unit, sum(m.qty_base) as qty,
           round(sum(m.qty_base) * coalesce(_unit_cost(p.id, p_end), 0), 2) as cost
    from stock_movements m join products p on p.id = m.product_id
    where m.type in ('wastage', 'breakage', 'complimentary', 'staff_meal') and business_date(m.at) between p_start and p_end
    group by m.type, p.id, p.name, p.base_unit),
  loss_cnt as (   -- count differences in the bar and store are stock lost (kitchen/choma differences are the "food used" above)
    select 'count_difference'::text as kind, p.name, p.base_unit, -sum(c.variance) as qty,
           round(-sum(c.variance) * coalesce(_unit_cost(p.id, p_end), 0), 2) as cost
    from stock_counts c join locations l on l.id = c.location_id join products p on p.id = c.product_id
    where l.kind in ('main_bar', 'store') and c.business_date between p_start and p_end and c.variance <> 0
    group by p.id, p.name, p.base_unit),
  loss as (select * from loss_mv union all select * from loss_cnt),
  exp as (select e.category, sum(e.amount) as v from expenses e
           where e.business_date between p_start and p_end and e.category <> 'Supplier payment'
             and not exists (select 1 from expense_voids v where v.expense_id = e.id)
           group by 1),
  t as (select
      coalesce((select v from sales_by where station = 'bar'), 0) as s_bar,
      coalesce((select v from sales_by where station = 'kitchen'), 0) as s_kitchen,
      coalesce((select v from sales_by where station = 'choma'), 0) as s_choma,
      coalesce((select v from sales_by where station = 'none'), 0) as s_none,
      coalesce((select sum(v) from sales_by), 0) as gross,
      (select v from adj) as adjustments,
      coalesce((select sum(cost) from bar_rows), 0) as bar_cost,
      coalesce((select sum(cost) from food_rows), 0) as food_cost,
      coalesce((select sum(cost) from loss), 0) as loss_total,
      coalesce((select sum(v) from exp), 0) as exp_total)
  select jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'sales', jsonb_build_object('bar', t.s_bar, 'kitchen', t.s_kitchen, 'choma', t.s_choma, 'untracked', t.s_none,
                                'gross', t.gross, 'adjustments', t.adjustments, 'net', t.gross - t.adjustments),
    'cost', jsonb_build_object('bar', t.bar_cost, 'food_used', t.food_cost, 'total', t.bar_cost + t.food_cost),
    'gross_profit', t.gross - t.adjustments - t.bar_cost - t.food_cost,
    'losses_total', t.loss_total,
    'expenses_total', t.exp_total,
    'operating_result', t.gross - t.adjustments - t.bar_cost - t.food_cost - t.loss_total - t.exp_total,
    'bar_rows', coalesce((select jsonb_agg(jsonb_build_object('product', name, 'unit', base_unit, 'qty_sold', qty_sold, 'sales', sales, 'qty_base', qty_base, 'unit_cost', unit_cost, 'cost', case when unit_cost is null then null else cost end, 'margin', case when unit_cost is null then null else sales - cost end) order by sales desc, name) from bar_rows), '[]'::jsonb),
    'food_rows', coalesce((select jsonb_agg(jsonb_build_object('product', name, 'location', kind, 'unit', base_unit, 'qty_used', qty_used, 'unit_cost', unit_cost, 'cost', cost) order by cost desc, name) from food_rows), '[]'::jsonb),
    'loss_rows', coalesce((select jsonb_agg(jsonb_build_object('type', kind, 'product', name, 'unit', base_unit, 'qty', qty, 'cost', cost) order by kind, cost desc) from loss), '[]'::jsonb),
    'expense_rows', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'amount', v) order by v desc) from exp), '[]'::jsonb),
    'flags', jsonb_build_object(
       'uncosted_products', coalesce((select jsonb_agg(distinct name) from (
            select name from bar_rows where unit_cost is null and (qty_base > 0 or sales > 0)
            union all select name from food_rows where unit_cost is null) u), '[]'::jsonb),
       'bar_items_without_stock_deduction', (select count(*) from s where station = 'bar'
            and not exists (select 1 from stock_movements m where m.ref_table = 'order_items' and m.ref_id = s.item_id)),
       'counts', coalesce((select jsonb_object_agg(kind, jsonb_build_object('products', n, 'first', first_d, 'last', last_d)) from (
            select l.kind::text as kind, count(distinct c.product_id) as n, min(c.business_date) as first_d, max(c.business_date) as last_d
            from stock_counts c join locations l on l.id = c.location_id
            where l.kind in ('kitchen', 'choma') and c.business_date between p_start and p_end group by l.kind) k), '{}'::jsonb))
  ) into r from t;
  return r;
end $$;

-- ═════════════ 3. Stock valuation and shrinkage ═════════════
-- Valuation is the book quantity at the END of p_end (from the movement ledger) at the latest cost.
-- Shrinkage covers p_start to p_end.
create or replace function report_stock(p_start date, p_end date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not has_permission('report.profit') then raise exception 'not permitted'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'choose a valid period'; end if;
  if p_end - p_start > 400 then raise exception 'choose a period of 400 days or less'; end if;

  with bal as (
    select m.product_id, l.kind::text as kind,
           sum(case when m.to_location = l.id then m.qty_base else 0 end)
         - sum(case when m.from_location = l.id then m.qty_base else 0 end) as qty
    from stock_movements m join locations l on l.id in (m.to_location, m.from_location)
    where l.kind <> 'wastage' and business_date(m.at) <= p_end
    group by m.product_id, l.kind),
  val as (
    select p.name, p.base_unit, b.kind, b.qty, uc.c as unit_cost, round(b.qty * coalesce(uc.c, 0), 2) as value
    from bal b join products p on p.id = b.product_id
    cross join lateral (select _unit_cost(p.id, p_end) as c) uc
    where b.qty <> 0),
  loss_mv as (
    select m.type::text as kind, p.name, p.base_unit, sum(m.qty_base) as qty,
           round(sum(m.qty_base) * coalesce(_unit_cost(p.id, p_end), 0), 2) as value
    from stock_movements m join products p on p.id = m.product_id
    where m.type in ('wastage', 'breakage', 'complimentary', 'staff_meal') and business_date(m.at) between p_start and p_end
    group by m.type, p.id, p.name, p.base_unit),
  cnt as (
    select c.business_date as d, l.kind::text as location, p.name as product, p.base_unit,
           c.expected_qty, c.counted_qty, c.variance,
           round(c.variance * coalesce(_unit_cost(p.id, p_end), 0), 2) as value,
           c.explanation, s.full_name as counted_by
    from stock_counts c join locations l on l.id = c.location_id join products p on p.id = c.product_id
         join staff s on s.id = c.counted_by
    where c.business_date between p_start and p_end and c.variance <> 0)
  select jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'by_location', coalesce((select jsonb_agg(jsonb_build_object('location', kind, 'items', n, 'value', v) order by kind)
                             from (select kind, count(*) as n, sum(value) as v from val group by kind) x), '[]'::jsonb),
    'total_value', coalesce((select sum(value) from val), 0),
    'stock_rows', coalesce((select jsonb_agg(jsonb_build_object('location', kind, 'product', name, 'unit', base_unit, 'qty', qty, 'unit_cost', unit_cost, 'value', value) order by kind, name) from val), '[]'::jsonb),
    'losses_total', coalesce((select sum(value) from loss_mv), 0) - coalesce((select sum(value) from cnt), 0),
    'loss_rows', coalesce((select jsonb_agg(jsonb_build_object('type', kind, 'product', name, 'unit', base_unit, 'qty', qty, 'value', value) order by kind, value desc) from loss_mv), '[]'::jsonb),
    'count_rows', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'location', location, 'product', product, 'unit', base_unit, 'expected', expected_qty, 'counted', counted_qty, 'variance', variance, 'value', value, 'explanation', explanation, 'counted_by', counted_by) order by d desc, product) from cnt), '[]'::jsonb),
    'flags', jsonb_build_object(
       'negative', coalesce((select jsonb_agg(jsonb_build_object('product', name, 'location', kind, 'qty', qty)) from val where qty < 0), '[]'::jsonb),
       'uncosted', coalesce((select jsonb_agg(distinct name) from val where unit_cost is null and qty > 0), '[]'::jsonb))
  ) into r;
  return r;
end $$;

-- ═════════════ 4. Cash, M-Pesa and credit summary ═════════════
create or replace function report_cash(p_start date, p_end date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not has_permission('report.sales') then raise exception 'not permitted'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'choose a valid period'; end if;
  if p_end - p_start > 400 then raise exception 'choose a period of 400 days or less'; end if;

  with s as (select sale_date, line_total from _sold_lines(p_start, p_end)),
  adj as (select business_date(at) as d, amount from tab_adjustments where business_date(at) between p_start and p_end),
  pay as (
    select p.business_date as d, p.method::text as method, p.amount,
           coalesce((select v.status::text from mpesa_verifications v where v.payment_id = p.id order by v.id desc limit 1), 'recorded') as vstatus
    from payments p where p.business_date between p_start and p_end),
  exp as (select e.business_date as d, e.amount from expenses e
           where e.business_date between p_start and p_end and not exists (select 1 from expense_voids v where v.expense_id = e.id)),
  hand as (select h.business_date as d, h.actual_amount as received,
                  coalesce((select x.expected_cash from waiter_cash_expected x
                             where x.waiter_id = h.waiter_id and x.business_date = h.business_date
                               and x.shift_id is not distinct from h.shift_id), 0) as expected
             from cash_handovers h where h.business_date between p_start and p_end and h.received_by is not null),
  credit as (select business_date(coalesce(t.closed_at, t.opened_at)) as d, tb.balance from tabs t join tab_balances tb on tb.tab_id = t.id
              where t.status = 'closed_credit' and business_date(coalesce(t.closed_at, t.opened_at)) between p_start and p_end),
  days as (
    select d.d,
      coalesce((select sum(line_total) from s where sale_date = d.d), 0) as gross,
      coalesce((select sum(amount) from adj where adj.d = d.d), 0) as adjustments,
      coalesce((select sum(amount) from pay where pay.d = d.d and method = 'cash'), 0) as cash_taken,
      coalesce((select sum(amount) from pay where pay.d = d.d and method = 'mpesa'), 0) as mpesa,
      coalesce((select sum(amount) from pay where pay.d = d.d and method = 'mpesa' and vstatus = 'verified'), 0) as mpesa_verified,
      coalesce((select sum(amount) from pay where pay.d = d.d and method = 'mpesa' and vstatus = 'disputed'), 0) as mpesa_disputed,
      coalesce((select sum(balance) from credit where credit.d = d.d), 0) as credit_given,
      coalesce((select sum(received) from hand where hand.d = d.d), 0) as cash_received,
      coalesce((select sum(expected - received) from hand where hand.d = d.d), 0) as cash_short,
      coalesce((select sum(amount) from exp where exp.d = d.d), 0) as expenses
    from generate_series(p_start, p_end, interval '1 day') g(d0)
    cross join lateral (select g.d0::date as d) d),
  owing as (
    select coalesce(nullif(btrim(t.customer_name), ''), 'Unnamed') as customer, w.full_name as waiter,
           business_date(coalesce(t.closed_at, t.opened_at)) as since, tb.balance
    from tabs t join tab_balances tb on tb.tab_id = t.id join staff w on w.id = t.waiter_id
    where t.status = 'closed_credit' and tb.balance > 0),
  open_t as (
    select count(*) as n, coalesce(sum(tb.balance), 0) as bal
    from tabs t join tab_balances tb on tb.tab_id = t.id
    where t.status not in ('settled', 'closed_credit') and tb.balance > 0)
  select jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'totals', jsonb_build_object(
       'net_sales', (select sum(gross - adjustments) from days),
       'cash', (select sum(cash_taken) from days), 'mpesa', (select sum(mpesa) from days),
       'mpesa_verified', (select sum(mpesa_verified) from days), 'mpesa_disputed', (select sum(mpesa_disputed) from days),
       'mpesa_awaiting', (select sum(mpesa - mpesa_verified - mpesa_disputed) from days),
       'credit_given', (select sum(credit_given) from days),
       'cash_received', (select sum(cash_received) from days), 'cash_short', (select sum(cash_short) from days),
       'expenses', (select sum(expenses) from days),
       'cash_to_bank', (select sum(cash_received - expenses) from days)),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'net_sales', gross - adjustments, 'cash', cash_taken, 'mpesa', mpesa,
                'mpesa_verified', mpesa_verified, 'mpesa_disputed', mpesa_disputed, 'credit', credit_given,
                'cash_received', cash_received, 'cash_short', cash_short, 'expenses', expenses, 'cash_to_bank', cash_received - expenses) order by d) from days), '[]'::jsonb),
    'credit_owing', coalesce((select jsonb_agg(jsonb_build_object('customer', customer, 'waiter', waiter, 'since', since, 'balance', balance) order by since, customer) from owing), '[]'::jsonb),
    'credit_owing_total', coalesce((select sum(balance) from owing), 0),
    'open_tabs', (select jsonb_build_object('count', n, 'balance', bal) from open_t)
  ) into r;
  return r;
end $$;

revoke execute on function _sold_lines(date, date), _unit_cost(uuid, date),
  report_sales(date, date), report_profit(date, date), report_stock(date, date), report_cash(date, date) from public, anon;
grant execute on function report_sales(date, date), report_profit(date, date),
  report_stock(date, date), report_cash(date, date) to authenticated;
