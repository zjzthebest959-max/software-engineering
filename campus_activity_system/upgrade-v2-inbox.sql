-- 在 V2 聊天升级之后执行。只增加已读状态和收件箱接口，保留全部历史。
begin;
alter table public.campus_messages add column if not exists read_at timestamptz;
create index if not exists campus_messages_unread on public.campus_messages(recipient_id,sender_id) where read_at is null;

create or replace function public.campus_chat_inbox() returns jsonb
language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid(); result jsonb;
begin
  if me is null or not exists(select 1 from public.campus_profiles where id=me) then raise exception '请先登录'; end if;
  with mine as (
    select m.*,case when sender_id=me then recipient_id else sender_id end as peer_id
    from public.campus_messages m where sender_id=me or recipient_id=me
  ), latest as (
    select distinct on (peer_id) peer_id,id,body,sender_id,created_at
    from mine order by peer_id,created_at desc,id desc
  ), unread as (
    select peer_id,count(*) as amount from mine where recipient_id=me and read_at is null group by peer_id
  ), conversations as (
    select l.peer_id,p.display_name,p.role,l.body as last_body,l.sender_id as last_sender_id,
      l.created_at as last_at,l.id as last_id,coalesce(u.amount,0) as unread_count
    from latest l join public.campus_profiles p on p.id=l.peer_id left join unread u on u.peer_id=l.peer_id
  ) select jsonb_build_object(
    'conversations',coalesce(jsonb_agg(to_jsonb(c) order by c.last_at desc,c.last_id desc),'[]'::jsonb),
    'total_unread',coalesce(sum(c.unread_count),0)) into result from conversations c;
  return result;
end $$;

create or replace function public.campus_chat_mark_read(p_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid();
begin
  if me is null or not exists(select 1 from public.campus_profiles where id=me) then raise exception '请先登录'; end if;
  if p_ids is null or cardinality(p_ids)>500 then raise exception '一次最多标记 500 条消息'; end if;
  -- 只更新当前用户收到、客户端已经加载的指定消息；并发到来的新消息不受影响。
  update public.campus_messages set read_at=clock_timestamp()
    where id=any(p_ids) and recipient_id=me and read_at is null;
end $$;
revoke all on function public.campus_chat_inbox(),public.campus_chat_mark_read(uuid[]) from public,anon,authenticated;
grant execute on function public.campus_chat_inbox(),public.campus_chat_mark_read(uuid[]) to authenticated;
commit;
-- 旧历史没有已读记录，升级后默认未读；只在打开并加载这些消息后清除提醒。
