-- Grills Lounge POS — Phase 1 patch: profile and staff-list RPCs (run after 003_rls_reads.sql)
-- The app reads who-am-I and the staff list through these, so no extra table policies are needed.

create or replace function my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'staff_no', s.staff_no, 'full_name', s.full_name, 'is_captain', s.is_captain,
    'roles', coalesce((select jsonb_agg(role_code) from staff_roles where staff_id = s.id), '[]'::jsonb),
    'permissions', coalesce((select jsonb_agg(distinct rp.permission_code)
        from staff_roles sr join role_permissions rp on rp.role_code = sr.role_code
        where sr.staff_id = s.id), '[]'::jsonb))
  from staff s where s.id = auth.uid() and s.active
$$;

create or replace function list_staff() returns table (
  id uuid, staff_no text, full_name text, is_captain boolean, active boolean,
  roles text[], has_pin boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('staff.manage') then raise exception 'not permitted'; end if;
  return query
    select s.id, s.staff_no, s.full_name, s.is_captain, s.active,
           coalesce(array(select role_code from staff_roles where staff_id = s.id), '{}'),
           s.pin_hash is not null
    from staff s order by s.staff_no;
end $$;

create or replace function set_staff_active(p_staff uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_permission('staff.manage') then raise exception 'not permitted'; end if;
  if p_staff = auth.uid() and not p_active then raise exception 'you cannot deactivate yourself'; end if;
  update staff set active = p_active where id = p_staff;
  perform write_audit('staff.set_active','staff', p_staff::text, null, jsonb_build_object('active', p_active));
end $$;

grant execute on function my_profile(), list_staff(), set_staff_active(uuid, boolean) to authenticated;
