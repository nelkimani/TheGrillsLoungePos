-- Grills Lounge POS — 009: bartender must see the stock the manager added (run after 008)
-- bar_stock now totals stock_movements itself and runs with the view owner's rights,
-- so it no longer depends on stock_balance or on the caller's row-level access.
-- Who may SEE the rows is still decided by has_permission() inside the view.

create or replace view bar_stock with (security_invoker = false) as
with bar as (select loc('main_bar') as id),
bal as (
  select m.product_id,
         sum(case when m.to_location   = bar.id then m.qty_base else 0 end)
       - sum(case when m.from_location = bar.id then m.qty_base else 0 end) as qty
  from stock_movements m, bar
  where m.to_location = bar.id or m.from_location = bar.id
  group by m.product_id
)
select p.id as product_id, p.name, p.base_unit, c.name as category, p.reorder_level,
       coalesce(b.qty, 0) as on_hand,
       (p.reorder_level is not null and coalesce(b.qty, 0) <= p.reorder_level) as low,
       coalesce(b.qty, 0) < 0 as negative
from products p
left join categories c on c.id = p.category_id
left join bal b on b.product_id = p.id
where p.active and p.station = 'bar'
  and (has_permission('station.bar') or has_permission('stock.view_all'));

grant select on bar_stock to authenticated;
revoke all on bar_stock from anon;