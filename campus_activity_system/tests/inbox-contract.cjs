const assert=require('node:assert/strict');
const {boot,flush,peers,text}=require('./chat-contract.cjs');
const incoming=(id,peer=peers[0].id)=>({id,sender_id:peer,recipient_id:'student',body:'老师的新通知 '+id,created_at:'2026-10-01T00:00:00Z',read_at:null});
(async()=>{
  const a=await boot('student',[incoming('m1'),incoming('m2'),incoming('m3',peers[1].id)]);
  await flush();assert.ok(a.nodes['nav-unread'],'顶部消息入口应有未读角标');
  assert.equal(a.nodes['nav-unread'].textContent,'3');assert.equal(a.nodes['nav-unread'].hidden,false);
  assert.equal(a.requests.filter(r=>r.name==='campus_chat_mark_read').length,0,'停留任务页不能标为已读');
  await a.nodes['nav-messages'].fire('click');await flush();
  assert.equal(a.nodes['inbox-pane'].hidden,false);assert.equal(a.nodes['contacts-directory'].hidden,true);
  assert.equal(a.nodes['inbox-list'].children.length,2);assert.match(text(a.nodes['inbox-list']),/老师的新通知/);
  await a.nodes['inbox-list'].children[0].fire('click');await flush();
  const marked=a.requests.find(r=>r.name==='campus_chat_mark_read');assert.deepEqual(marked.body.p_ids,['m1','m2']);
  assert.equal(a.nodes['nav-unread'].textContent,'1','仅清除已打开会话的已加载消息');
  assert.equal(a.messages.find(m=>m.id==='m3').read_at,null);
  await a.nodes['nav-tasks'].fire('click');
  a.messages.push({...incoming('m4'),created_at:'2026-10-02T00:00:00Z'});
  await [...a.timers.values()].find(t=>t.ms===5000).fn();await flush();
  assert.equal(a.nodes['nav-unread'].textContent,'2');assert.match(text(a.nodes['inbox-list'].children[0]),/m4/);
  const restored=await boot('student',a.messages);await flush();assert.equal(restored.nodes['nav-unread'].textContent,'2','刷新从服务端恢复未读');
  console.log('PASS 任务页提醒、默认收件箱、摘要与排序、点开清除本会话、刷新恢复');

  const b=await boot('student',[incoming('late')]);await b.nodes['nav-messages'].fire('click');let release;
  b.hooks.campus_chat_messages=()=>new Promise(r=>release=r);
  const selecting=b.nodes['inbox-list'].children[0].fire('click');await flush();
  await b.nodes['nav-tasks'].fire('click');release([incoming('late')]);await selecting;
  assert.equal(b.requests.filter(r=>r.name==='campus_chat_mark_read').length,0,'离开聊天后晚返回不能清未读');
  delete b.hooks.campus_chat_messages;await b.nodes['nav-messages'].fire('click');await flush();
  assert.equal(b.nodes['nav-unread'].hidden,true);
  console.log('PASS 离开会话后返回的消息不误标已读、回到会话后清除红点');

  const c=await boot('student',[incoming('error')]);await c.nodes['nav-messages'].fire('click');
  c.hooks.campus_chat_mark_read=()=>({httpError:'read failed'});
  await c.nodes['inbox-list'].children[0].fire('click');await flush();
  assert.equal(c.nodes['nav-unread'].textContent,'1');assert.equal(c.nodes['nav-unread'].hidden,false);
  assert.match(c.nodes['chat-status'].textContent,/已读|未读/);
  c.document.hidden=true;await c.docEvents.visibilitychange();
  assert.equal([...c.timers.values()].filter(t=>t.ms===5000).length,0);
  await c.nodes.logout.fire('click');assert.equal(c.nodes['nav-unread'].hidden,true);assert.equal(c.nodes['inbox-list'].children.length,0);
  console.log('PASS 标记失败保留红点、隐藏暂停轮询、退出清空会话提醒');

  const d=await boot('student',[incoming('loaded')]);await d.nodes['nav-messages'].fire('click');
  d.hooks.campus_chat_mark_read=body=>{
    d.messages.forEach(m=>{if(body.p_ids.includes(m.id))m.read_at='confirmed';});
    d.messages.push({...incoming('arrived-after-load'),created_at:'2026-10-02T00:00:00Z'});
    return null;
  };
  await d.nodes['inbox-list'].children[0].fire('click');
  assert.equal(d.nodes['nav-unread'].textContent,'1','标记期间新到且尚未加载的消息必须保留未读');
  assert.equal(d.messages.find(m=>m.id==='arrived-after-load').read_at,null);
  const e=await boot('student',[incoming('badge-race')]);await e.nodes['nav-messages'].fire('click');
  let resolveOld,attempt=0;
  e.hooks.campus_chat_inbox=()=>++attempt===1?new Promise(r=>resolveOld=r):{conversations:[],total_unread:0};
  const old=e.nodes['inbox-refresh'].fire('click');await flush();
  await e.nodes['inbox-list'].children[0].fire('click');
  resolveOld({conversations:[],total_unread:1});await old;
  assert.equal(e.nodes['nav-unread'].hidden,true,'旧收件箱响应不能让已经清除的角标回弹');
  console.log('PASS 标记期间新消息不被误清除、过期收件箱响应不恢复旧角标');
})().catch(e=>{console.error(e);process.exitCode=1;});
