-- 仅在独立测试 Supabase/PostgreSQL 执行，需已初始化 V1/V2。不要对线上项目运行。
-- psql -v ON_ERROR_STOP=1 -f tests/chat-permissions.sql
begin;
insert into auth.users(id,raw_user_meta_data) values
 ('a0000000-0000-4000-8000-000000000001','{"display_name":"测试学生"}'),
 ('a0000000-0000-4000-8000-000000000002','{"display_name":"测试教师","role":"teacher"}'),
 ('a0000000-0000-4000-8000-000000000003','{"display_name":"测试管理员","role":"admin"}');
do $$ begin
  assert (select role='student' from public.campus_profiles where id='a0000000-0000-4000-8000-000000000003'), '注册不能自授管理员';
end $$;
update public.campus_profiles set role='admin' where id='a0000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub','a0000000-0000-4000-8000-000000000001',true);
do $$ declare m jsonb; again jsonb; rejected boolean; begin
  m:=public.campus_chat_send('a0000000-0000-4000-8000-000000000002','  你好  ','b0000000-0000-4000-8000-000000000001');
  assert m->>'body'='你好';
  assert m->>'sender_id'='a0000000-0000-4000-8000-000000000001';
  again:=public.campus_chat_send('a0000000-0000-4000-8000-000000000002','你好','b0000000-0000-4000-8000-000000000001');
  assert m->>'id'=again->>'id', '重试不能重复插入';
  rejected:=false;
  begin perform public.campus_chat_send('a0000000-0000-4000-8000-000000000002','不同内容','b0000000-0000-4000-8000-000000000001'); exception when others then rejected:=true; end;
  assert rejected, '同幂等键不能修改正文';
  rejected:=false;
  begin perform public.campus_chat_send('a0000000-0000-4000-8000-000000000001','自己',gen_random_uuid()); exception when others then rejected:=true; end;
  assert rejected;
  rejected:=false;
  begin perform public.campus_chat_send('a0000000-0000-4000-8000-000000000099','不存在',gen_random_uuid()); exception when others then rejected:=true; end;
  assert rejected;
  rejected:=false;
  begin perform public.campus_chat_send('a0000000-0000-4000-8000-000000000002',E' \n\t ',gen_random_uuid()); exception when others then rejected:=true; end;
  assert rejected;
  rejected:=false;
  begin perform public.campus_chat_send('a0000000-0000-4000-8000-000000000002',repeat('好',2001),gen_random_uuid()); exception when others then rejected:=true; end;
  assert rejected;
  rejected:=false;
  begin perform 1 from public.campus_messages; exception when insufficient_privilege then rejected:=true; end;
  assert rejected, '不能直接读表';
end $$;
select set_config('request.jwt.claim.sub','a0000000-0000-4000-8000-000000000002',true);
do $$ begin assert jsonb_array_length(public.campus_chat_messages('a0000000-0000-4000-8000-000000000001'))=1; end $$;
select set_config('request.jwt.claim.sub','a0000000-0000-4000-8000-000000000003',true);
do $$ begin assert public.campus_chat_messages('a0000000-0000-4000-8000-000000000002')='[]'::jsonb, '管理员不能读取其他两人的对话'; end $$;
reset role;
insert into public.campus_messages(sender_id,recipient_id,body,created_at,client_message_id)
select 'a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','分页'||i,'2099-01-01 00:00:00.123456+00',gen_random_uuid()
from generate_series(1,51) i;
set local role authenticated;
select set_config('request.jwt.claim.sub','a0000000-0000-4000-8000-000000000001',true);
do $$ declare first_page jsonb; second_page jsonb; begin
  first_page:=public.campus_chat_messages('a0000000-0000-4000-8000-000000000002');
  assert jsonb_array_length(first_page)=50;
  second_page:=public.campus_chat_messages('a0000000-0000-4000-8000-000000000002',(first_page->0->>'created_at')::timestamptz,(first_page->0->>'id')::uuid);
  assert jsonb_array_length(second_page)=2;
  assert not exists(select 1 from jsonb_array_elements(first_page) a join jsonb_array_elements(second_page) b on a->>'id'=b->>'id');
end $$;
reset role;
set local role anon;
do $$ declare rejected boolean:=false; begin
  begin perform public.campus_chat_contacts(); exception when insufficient_privilege then rejected:=true; end;
  assert rejected, '匿名必须被拒绝';
end $$;
reset role;
rollback;
