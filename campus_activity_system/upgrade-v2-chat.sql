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
