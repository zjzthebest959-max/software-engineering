-- 已有项目升级：在 Supabase SQL Editor 执行，可重复执行。
-- 不删除账号、任务或报名，不修改已存在账号的角色。
begin;
create or replace function public.campus_create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.campus_profiles(id, display_name, role)
  values(new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'),''),'同学'),50),
    case when new.raw_user_meta_data->>'role' = 'teacher' then 'teacher' else 'student' end);
  return new;
end;
$$;
revoke all on function public.campus_create_profile() from public, anon, authenticated;
commit;

-- 另需在 Authentication 设置中关闭 Confirm email，并保持邮箱密码注册开启。
-- 这是课堂 Demo 的公开教师注册策略，不是教师身份认证。
