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
  values(new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'),''),'同学'),50),
    case when new.raw_user_meta_data->>'role' = 'teacher' then 'teacher' else 'student' end);
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

-- V1 课堂演示：学生和教师均可自行注册，无邀请码。
-- 角色只在创建账号时写入业务表；以后修改 Auth metadata 不会改变业务角色。
-- 正式使用前必须增加教师身份审核。已有项目请执行 upgrade-v1-auth.sql，不要重跑本文件。

-- V2 真人私聊升级；先完成 V1 初始化。可重复执行，不删除账号、任务和报名。
begin;
alter table public.campus_profiles drop constraint if exists campus_profiles_role_check;
alter table public.campus_profiles add constraint campus_profiles_role_check check (role in ('student','teacher','admin'));

create table if not exists public.campus_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.campus_profiles(id),
  recipient_id uuid not null references public.campus_profiles(id),
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  client_message_id uuid not null,
  check (sender_id <> recipient_id),
  unique(sender_id,client_message_id)
);
create index if not exists campus_messages_pair_time on public.campus_messages(sender_id,recipient_id,created_at desc,id desc);
create index if not exists campus_messages_recipient_time on public.campus_messages(recipient_id,sender_id,created_at desc,id desc);
alter table public.campus_messages enable row level security;
revoke all on public.campus_messages from public,anon,authenticated;

create or replace function public.campus_chat_contacts(p_role text default null,p_query text default '',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid(); result jsonb;
begin
  if me is null or not exists(select 1 from public.campus_profiles where id=me) then raise exception '请先登录'; end if;
  if (p_role is not null and p_role not in ('student','teacher','admin')) or p_query is null or length(p_query)>50
    or p_offset is null or p_offset<0 then raise exception '联系人筛选参数无效'; end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.display_name,p.id),'[]'::jsonb) into result
  from (select id,display_name,role from public.campus_profiles
    where id<>me and (p_role is null or role=p_role) and strpos(lower(display_name),lower(btrim(p_query)))>0
    order by display_name,id limit 50 offset p_offset) p;
  return result;
end $$;

create or replace function public.campus_chat_messages(p_peer uuid,p_before_time timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid(); result jsonb;
begin
  if me is null or not exists(select 1 from public.campus_profiles where id=me) then raise exception '请先登录'; end if;
  if p_peer is null or p_peer=me or not exists(select 1 from public.campus_profiles where id=p_peer) then raise exception '联系人不存在或不可选择'; end if;
  if (p_before_time is null)<>(p_before_id is null) or (p_before_time is not null and not isfinite(p_before_time)) then raise exception '历史消息游标无效'; end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at,m.id),'[]'::jsonb) into result
  from (select * from public.campus_messages
    where ((sender_id=me and recipient_id=p_peer) or (sender_id=p_peer and recipient_id=me))
      and (p_before_time is null or (created_at,id)<(p_before_time,p_before_id))
    order by created_at desc,id desc limit 50) m;
  return result;
end $$;

create or replace function public.campus_chat_send(p_peer uuid,p_body text,p_client_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid(); clean text; result public.campus_messages;
begin
  if me is null or not exists(select 1 from public.campus_profiles where id=me) then raise exception '请先登录'; end if;
  if p_peer is null or p_peer=me or not exists(select 1 from public.campus_profiles where id=p_peer) then raise exception '联系人不存在或不可选择'; end if;
  clean:=regexp_replace(p_body,'^[[:space:]]+|[[:space:]]+$','','g');
  if clean is null or length(clean) not between 1 and 2000 or p_client_id is null then raise exception '消息需为 1–2000 字符'; end if;
  insert into public.campus_messages(sender_id,recipient_id,body,client_message_id)
    values(me,p_peer,clean,p_client_id) on conflict(sender_id,client_message_id) do nothing returning * into result;
  if result.id is null then
    select * into result from public.campus_messages where sender_id=me and client_message_id=p_client_id;
    if result.id is null or result.recipient_id<>p_peer or result.body<>clean then raise exception '重复请求的内容不一致，请重新发送'; end if;
  end if;
  return to_jsonb(result);
end $$;
revoke all on function public.campus_chat_contacts(text,text,integer),public.campus_chat_messages(uuid,timestamptz,uuid),public.campus_chat_send(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.campus_chat_contacts(text,text,integer),public.campus_chat_messages(uuid,timestamptz,uuid),public.campus_chat_send(uuid,text,uuid) to authenticated;
commit;

-- 管理员需由项目所有者为指定现有用户授权（替换为真实用户 UUID 后执行）：
-- update public.campus_profiles set role='admin' where id='指定用户 UUID';
-- 不要将注册 trigger 改为允许用户自行指定 admin。管理员也不能通过 RPC 看他人私聊。
