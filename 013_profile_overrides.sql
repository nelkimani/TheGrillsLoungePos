-- Grills Lounge POS — 013: my_profile now includes per-person permission overrides.
-- Before this, a grant in staff_permission_overrides worked in the database but the app never showed the button.
create or replace function my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'staff_no', s.staff_no, 'full_name', s.full_name, 'is_captain', s.is_captain,
    'roles', coalesce((select jsonb_agg(role_code) from staff_roles where staff_id = s.id), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(distinct code) from (
        select rp.permission_code as code
          from staff_roles sr join role_permissions rp on rp.role_code = sr.role_code
         where sr.staff_id = s.id
           and not exists (select 1 from staff_permission_overrides o
                            where o.staff_id = s.id and o.permission_code = rp.permission_code and not o.granted)
        union
        select o.permission_code from staff_permission_overrides o
         where o.staff_id = s.id and o.granted
      ) p), '[]'::jsonb))
  from staff s where s.id = auth.uid() and s.active
$$;
