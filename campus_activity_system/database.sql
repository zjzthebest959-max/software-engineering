-- 在新的 Supabase Free 项目 SQL Editor 中执行一次。不会访问旧版 localStorage。
begin;
create table public.campus_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 50),
  role text not null default 'student' check (role in ('student', 'teacher'))
);
create table public.campus_tasks (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.campus_profiles(id),
  title text not null check (length(btrim(title)) between 1 and 100),
  course text not null check (length(btrim(course)) between 1 and 50),
  category text not null check (length(btrim(category)) between 1 and 50),
  deadline timestamptz not null,
  priority text not null check (priority in ('high','medium','low')),
  status text not null default 'published' check (status in ('published','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.campus_enrollments (
  task_id uuid not null references public.campus_tasks(id),
  student_id uuid not null references public.campus_profiles(id),
  created_at timestamptz not null default now(),
  primary key(task_id, student_id)
);
create index campus_enrollments_student on public.campus_enrollments(student_id);
create index campus_tasks_teacher on public.campus_tasks(teacher_id);
alter table public.campus_profiles enable row level security;
alter table public.campus_tasks enable row level security;
alter table public.campus_enrollments enable row level security;
-- 不授予浏览器任何直接表访问；只能调用下面逐项鉴权的函数。
revoke all on public.campus_profiles, public.campus_tasks, public.campus_enrollments from public, anon, authenticated;

create function public.campus_create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.campus_profiles(id, display_name, role)
  values(new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'),''),'同学'),50), 'student');
  return new;
end;
$$;
revoke all on function public.campus_create_profile() from public, anon, authenticated;
create trigger campus_new_user after insert on auth.users
for each row execute function public.campus_create_profile();
insert into public.campus_profiles(id, display_name)
select id, left(coalesce(nullif(btrim(raw_user_meta_data->>'display_name'),''),'同学'),50) from auth.users
on conflict(id) do nothing;

create function public.campus_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select to_jsonb(p) into result from public.campus_profiles p where p.id = auth.uid();
  if result is null then raise exception '账号资料不存在，请联系管理员'; end if;
  return result;
end;
$$;

create function public.campus_list_tasks() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object(
    'teacher_name',p.display_name,
    'enrollment_count',(select count(*) from public.campus_enrollments e where e.task_id=t.id),
    'enrolled',exists(select 1 from public.campus_enrollments e where e.task_id=t.id and e.student_id=auth.uid())
  ) order by t.created_at desc), '[]'::jsonb) into result
  from public.campus_tasks t join public.campus_profiles p on p.id=t.teacher_id
  where t.status='published' or t.teacher_id=auth.uid()
    or exists(select 1 from public.campus_enrollments e where e.task_id=t.id and e.student_id=auth.uid());
  return result;
end;
$$;

create function public.campus_save_task(p_title text, p_course text, p_category text,
  p_deadline timestamptz, p_priority text, p_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid; existing public.campus_tasks;
begin
  if not exists(select 1 from public.campus_profiles where id=auth.uid() and role='teacher') then
    raise exception '仅教师可以发布或编辑任务';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 100
    or p_course is null or length(btrim(p_course)) not between 1 and 50
    or p_category is null or length(btrim(p_category)) not between 1 and 50
    or p_priority is null or p_priority not in ('high','medium','low')
    or p_deadline is null or not isfinite(p_deadline) or p_deadline <= clock_timestamp() then
    raise exception '请填写有效内容，报名截止时间必须在未来';
  end if;
  if p_id is null then
    insert into public.campus_tasks(teacher_id,title,course,category,deadline,priority)
    values(auth.uid(),btrim(p_title),btrim(p_course),btrim(p_category),p_deadline,p_priority)
    returning id into result;
  else
    select * into existing from public.campus_tasks where id=p_id for update;
    if not found or existing.teacher_id <> auth.uid() then raise exception '无权编辑此任务'; end if;
    if existing.status <> 'published' then raise exception '已取消的任务不能编辑'; end if;
    update public.campus_tasks set title=btrim(p_title),course=btrim(p_course),category=btrim(p_category),
      deadline=p_deadline,priority=p_priority,updated_at=now() where id=p_id returning id into result;
  end if;
  return result;
end;
$$;

create function public.campus_cancel_task(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.campus_profiles where id=auth.uid() and role='teacher') then raise exception '仅教师可以取消任务'; end if;
  update public.campus_tasks set status='cancelled',updated_at=now() where id=p_id and teacher_id=auth.uid();
  if not found then raise exception '无权取消此任务'; end if;
end;
$$;

create function public.campus_enroll(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare task public.campus_tasks;
begin
  if not exists(select 1 from public.campus_profiles where id=auth.uid() and role='student') then raise exception '仅学生可以报名'; end if;
  -- 与教师修改、取消串行，统一使用数据库时间，避免客户端改时间绕过限制。
  select * into task from public.campus_tasks where id=p_id for update;
  if not found or task.status <> 'published' then raise exception '任务已取消或不存在'; end if;
  if task.deadline <= clock_timestamp() then raise exception '报名已截止'; end if;
  insert into public.campus_enrollments(task_id, student_id) values(p_id,auth.uid());
exception when unique_violation then raise exception '你已经报名过该任务';
end;
$$;

create function public.campus_roster(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.campus_tasks t join public.campus_profiles p on p.id=t.teacher_id
    where t.id=p_id and t.teacher_id=auth.uid() and p.role='teacher') then raise exception '仅发布教师可以查看名单'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('display_name',p.display_name,'student_id',e.student_id,'created_at',e.created_at)
    order by e.created_at), '[]'::jsonb) into result from public.campus_enrollments e
    join public.campus_profiles p on p.id=e.student_id where e.task_id=p_id;
  return result;
end;
$$;

revoke all on function public.campus_me(),public.campus_list_tasks(),
  public.campus_save_task(text,text,text,timestamptz,text,uuid),public.campus_cancel_task(uuid),
  public.campus_enroll(uuid),public.campus_roster(uuid) from public,anon,authenticated;
grant execute on function public.campus_me(),public.campus_list_tasks(),
  public.campus_save_task(text,text,text,timestamptz,text,uuid),public.campus_cancel_task(uuid),
  public.campus_enroll(uuid),public.campus_roster(uuid) to authenticated;
commit;

-- 教师授权仅由项目所有者在 SQL Editor 执行。先让教师注册，再用其邮箱定位：
-- update public.campus_profiles set role='teacher'
-- where id=(select id from auth.users where email='教师注册邮箱');
