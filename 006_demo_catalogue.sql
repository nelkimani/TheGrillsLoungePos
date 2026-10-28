-- Grills Lounge POS — DEMO catalogue (fake names and prices, every row flagged is_demo)
-- Delete later with: delete from products where is_demo;  (only safe before any orders use them)

insert into categories(name) values ('Beer'),('Spirits'),('Soft drinks'),('Nyama choma'),('Kitchen')
on conflict (name) do nothing;

insert into products(sku, name, category_id, station, is_liquor, base_unit, sale_unit, selling_price, purchase_cost, is_demo)
select v.sku, v.name, (select id from categories where name = v.cat), v.station::station, v.liquor,
       v.unit, v.unit, v.price, v.cost, true
from (values
  ('DEMO-B01','Demo Lager 500ml',   'Beer',        'bar',     true,  'bottle',  300, 200),
  ('DEMO-B02','Demo Stout 500ml',   'Beer',        'bar',     true,  'bottle',  320, 220),
  ('DEMO-S01','Demo Whisky tot',    'Spirits',     'bar',     true,  'tot',     200, 90),
  ('DEMO-S02','Demo Vodka tot',     'Spirits',     'bar',     true,  'tot',     180, 80),
  ('DEMO-D01','Demo Soda 300ml',    'Soft drinks', 'bar',     false, 'bottle',  100, 55),
  ('DEMO-D02','Demo Water 500ml',   'Soft drinks', 'bar',     false, 'bottle',  80,  40),
  ('DEMO-C01','Demo Goat choma 1/2kg','Nyama choma','choma',  false, 'portion', 900, 600),
  ('DEMO-C02','Demo Beef choma 1/2kg','Nyama choma','choma',  false, 'portion', 800, 520),
  ('DEMO-K01','Demo Chips',         'Kitchen',     'kitchen', false, 'portion', 250, 100),
  ('DEMO-K02','Demo Ugali',         'Kitchen',     'kitchen', false, 'portion', 120, 40),
  ('DEMO-K03','Demo Chicken stew',  'Kitchen',     'kitchen', false, 'portion', 450, 250)
) as v(sku, name, cat, station, liquor, unit, price, cost)
on conflict (sku) do nothing;
