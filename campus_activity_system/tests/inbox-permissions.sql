-- 只对独立测试数据库运行，需初始化到包含收件箱升级的结构。最后回滚所有测试数据。
begin;
insert into auth.users(id,raw_user_meta_data) values
 ('c0000000-0000-4000-8000-000000000001','{"display_name":"收件人A"}'),
 ('c0000000-0000-4000-8000-000000000002','{"display_name":"发件人B"}'),
 ('c0000000-0000-4000-8000-000000000003','{"display_name":"第三人C"}');
insert into public.campus_messages(id,sender_id,recipient_id,body,client_message_id) values
 ('d0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001','第一条',gen_random_uuid()),
 ('d0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001','第二条',gen_random_uuid());
set local role authenticated;
select set_config('request.jwt.claim.sub','c0000000-0000-4000-8000-000000000001',true);
do $$ declare box jsonb; begin
  box:=public.campus_chat_inbox();
  assert (box->>'total_unread')::integer=2;
  assert jsonb_array_length(box->'conversations')=1;
  assert box->'conversations'->0->>'last_body'='第二条';
  perform public.campus_chat_mark_read(array['d0000000-0000-4000-8000-000000000001'::uuid]);
  assert (public.campus_chat_inbox()->>'total_unread')::integer=1, '只能清除指定的已加载消息';
  perform public.campus_chat_mark_read(array['d0000000-0000-4000-8000-000000000001'::uuid]);
  assert (public.campus_chat_inbox()->>'total_unread')::integer=1, '已读操作幂等';
end $$;
select set_config('request.jwt.claim.sub','c0000000-0000-4000-8000-000000000002',true);
do $$ begin
  assert (public.campus_chat_inbox()->>'total_unread')::integer=0, '自己的发送不能计为自己的未读';
  perform public.campus_chat_mark_read(array['d0000000-0000-4000-8000-000000000002'::uuid]);
end $$;
select set_config('request.jwt.claim.sub','c0000000-0000-4000-8000-000000000003',true);
do $$ begin
  assert public.campus_chat_inbox()->'conversations'='[]'::jsonb, '第三人看不到别人的会话';
  perform public.campus_chat_mark_read(array['d0000000-0000-4000-8000-000000000002'::uuid]);
end $$;
select set_config('request.jwt.claim.sub','c0000000-0000-4000-8000-000000000001',true);
do $$ begin
  assert (public.campus_chat_inbox()->>'total_unread')::integer=1, '其他人不能清除我的未读';
  perform public.campus_chat_mark_read(array['d0000000-0000-4000-8000-000000000002'::uuid]);
  assert (public.campus_chat_inbox()->>'total_unread')::integer=0;
  assert jsonb_array_length(public.campus_chat_inbox()->'conversations')=1, '已读后保留会话';
end $$;
reset role;
set local role anon;
do $$ declare denied boolean:=false; begin
  begin perform public.campus_chat_inbox(); exception when insufficient_privilege then denied:=true; end;
  assert denied;
  denied:=false;
  begin perform public.campus_chat_mark_read(array[]::uuid[]); exception when insufficient_privilege then denied:=true; end;
  assert denied;
end $$;
reset role;
rollback;
