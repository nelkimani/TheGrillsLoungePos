-- Grills Lounge POS — 010: let named bartenders collect payment on their OWN sales.
-- Edit the list below, run, then have the bartender sign out and in again (permissions load at login).

do $$
declare ids text[] := array['B001'];            -- <- staff IDs allowed to collect payments
        s record;
begin
  for s in select id, staff_no from staff where upper(staff_no) = any (select upper(unnest(ids))) loop
    delete from staff_permission_overrides where staff_id = s.id and permission_code = 'payment.record';
    insert into staff_permission_overrides(staff_id, permission_code, granted)
    values (s.id, 'payment.record', true);
    raise notice 'granted payment.record to %', s.staff_no;
  end loop;
end $$;

-- Check: should list the bartender(s) you named
select s.staff_no, s.full_name, o.permission_code, o.granted
from staff_permission_overrides o join staff s on s.id = o.staff_id
where o.permission_code = 'payment.record';

-- To take it away again:
-- delete from staff_permission_overrides
--  where permission_code = 'payment.record'
--    and staff_id = (select id from staff where upper(staff_no) = 'B001');
