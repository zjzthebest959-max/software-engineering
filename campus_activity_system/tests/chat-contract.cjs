// Runs the actual app with a minimal DOM and simulated HTTP boundary. No real cloud writes.
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const root=process.argv[2]||path.resolve(__dirname,'..');
const html=readFileSync(path.join(root,'index.html'),'utf8');
const code=readFileSync(path.join(root,'app.js'),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
class Element {
  constructor(){this.children=[];this.events={};this.value='';this.hidden=false;this.attrs={};this.scrollHeight=500;this.scrollTop=0;this.clientHeight=400;}
  append(...n){this.children.push(...n);}
  replaceChildren(...n){this.children=n;}
  addEventListener(k,f){this.events[k]=f;}
  setAttribute(k,v){this.attrs[k]=String(v);}
  focus(){} close(){} showModal(){}
  async fire(type,extra={}){return this.events[type]?.({preventDefault(){},currentTarget:this,submitter:this,...extra});}
}
const peers=[{id:'teacher-11111111',display_name:'王老师',role:'teacher'},{id:'teacher-22222222',display_name:'王老师',role:'teacher'},{id:'admin-11111111',display_name:'管理员',role:'admin'}];
const text=n=>[n.textContent||'',...n.children.map(text)].join(' ');
async function boot(role='student', initialMessages=[]){
  const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  const fields=Object.fromEntries(['display_name','username','password','role','title','course','category','priority','deadline'].map(k=>[k,new Element()]));
  for(const id of ['auth-form','task-form']) nodes[id].elements={namedItem:k=>fields[k]};
  nodes['view-filter'].value='all';
  const session={access_token:role,refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600};
  const storage=new Map([['campus.cloud.session:https://example.supabase.co',JSON.stringify(session)]]);
  const requests=[],timers=new Map(),messages=[...initialMessages];
  const hooks={}; const docEvents={}; let nextTimer=0;
  const document={hidden:false,getElementById:id=>nodes[id],createElement:()=>new Element(),
    querySelector:q=>({content:q.includes('supabase-url')?'https://example.supabase.co':'key'}),addEventListener:(k,f)=>docEvents[k]=f};
  const fetch=async(url,options)=>{
    const name=url.split('/').pop(),body=options.body?JSON.parse(options.body):null;
    requests.push({name,body}); let data;
    if(hooks[name]) data=await hooks[name](body);
    else if(name==='campus_me') data={id:role,role,display_name:'当前用户'};
    else if(name==='campus_list_tasks') data=[{id:'task',teacher_id:role,teacher_name:'老师',course:'软件工程',category:'作业',title:'设计',deadline:'2099-01-01',priority:'high',status:'published',enrollment_count:0,enrolled:false}];
    else if(name==='campus_chat_contacts') data=peers.filter(p=>!body.p_role||p.role===body.p_role);
    else if(name==='campus_chat_inbox') {
      const conversations=peers.map(p=>{
        const rows=messages.filter(m=>(m.sender_id===role&&m.recipient_id===p.id)||(m.sender_id===p.id&&m.recipient_id===role)).sort((a,b)=>b.created_at.localeCompare(a.created_at));
        return rows.length?{peer_id:p.id,display_name:p.display_name,role:p.role,last_body:rows[0].body,last_at:rows[0].created_at,last_sender_id:rows[0].sender_id,unread_count:rows.filter(m=>m.recipient_id===role&&!m.read_at).length}:null;
      }).filter(Boolean).sort((a,b)=>b.last_at.localeCompare(a.last_at));
      data={conversations,total_unread:conversations.reduce((n,c)=>n+c.unread_count,0)};
    }
    else if(name==='campus_chat_mark_read') {messages.forEach(m=>{if(m.recipient_id===role&&body.p_ids.includes(m.id))m.read_at='2026-10-01T00:00:00Z';});data=null;}
    else if(name==='campus_chat_messages') data=messages.filter(m=>m.recipient_id===body.p_peer||m.sender_id===body.p_peer);
    else if(name==='campus_chat_send') {data=messages.find(m=>m.client_message_id===body.p_client_id); if(!data){data={id:randomUUID(),sender_id:role,recipient_id:body.p_peer,body:body.p_body,created_at:new Date().toISOString(),client_message_id:body.p_client_id};messages.push(data);}}
    else if(name.startsWith('logout')) data=null;
    else throw Error(`Unexpected request ${name}`);
    if(data?.httpError) return {ok:false,status:404,text:async()=>JSON.stringify({code:'PGRST202',message:data.httpError})};
    return {ok:true,text:async()=>JSON.stringify(data)};
  };
  vm.runInNewContext(code,{document,window:{addEventListener(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    fetch,AbortSignal,crypto:{randomUUID},Option:function(label,value){const n=new Element();n.textContent=label;n.value=value;return n;},
    FormData:function(){return Object.entries(fields).map(([k,v])=>[k,v.value]);},
    setInterval:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),console,confirm:()=>true,location:{reload(){}}});
  await flush();return {nodes,requests,timers,messages,hooks,document,docEvents};
}
async function open(app){assert.ok(app.nodes['nav-messages'],'需要消息入口');await app.nodes['nav-messages'].fire('click');await app.nodes['tab-contacts']?.fire('click');await flush();}
async function select(app,i=0){await app.nodes['contact-list'].children[i].fire('click');await flush();}
async function run(){
  const a=await boot(); await open(a);
  assert.equal(a.nodes['chat-panel'].hidden,false);
  assert.equal(a.nodes['tasks-panel'].hidden,true);
  a.nodes['contact-role'].value='teacher';await a.nodes['contact-role'].fire('change');await flush();
  assert.equal(a.requests.filter(r=>r.name==='campus_chat_contacts').at(-1).body.p_role,'teacher');
  assert.equal(a.nodes['contact-list'].children.length,2);
  assert.notEqual(text(a.nodes['contact-list'].children[0]),text(a.nodes['contact-list'].children[1]));
  await select(a);
  a.nodes['chat-input'].value='  <script>中文</script>  ';
  await a.nodes['chat-form'].fire('submit');await flush();
  const sent=a.requests.find(r=>r.name==='campus_chat_send');
  assert.equal(sent.body.p_body,'<script>中文</script>');assert.equal(sent.body.sender_id,undefined);
  assert.equal(a.nodes['chat-input'].value,'');assert.match(text(a.nodes['message-list']),/<script>中文<\/script>/);
  assert.equal(a.nodes['message-list'].children.length,1);
  console.log('PASS 角色筛选、同名联系人、文字发送、成功清空及按文本渲染');

  a.nodes['chat-input'].value='输入法'; const count=a.requests.length;
  await a.nodes['chat-input'].fire('keydown',{key:'Enter',isComposing:true});
  await a.nodes['chat-input'].fire('keydown',{key:'Enter',shiftKey:true});await flush();
  assert.equal(a.requests.length,count);
  a.nodes['chat-input'].value=' '.repeat(10);await a.nodes['chat-form'].fire('submit');
  a.nodes['chat-input'].value='好'.repeat(2001);await a.nodes['chat-form'].fire('submit');await flush();
  assert.equal(a.requests.length,count);
  a.nodes['chat-input'].value='重试同一消息';let fail=true;
  a.hooks.campus_chat_send=body=>{if(fail){fail=false;throw Error('response lost');}return {id:'retry-id',sender_id:'student',recipient_id:body.p_peer,body:body.p_body,client_message_id:body.p_client_id,created_at:'2026-10-01T00:00:00Z'};};
  await a.nodes['chat-form'].fire('submit');assert.equal(a.nodes['chat-input'].value,'重试同一消息');
  await a.nodes['chat-form'].fire('submit');
  const attempts=a.requests.filter(r=>r.name==='campus_chat_send').slice(-2);
  assert.equal(attempts[0].body.p_client_id,attempts[1].body.p_client_id);
  assert.equal(a.nodes['message-list'].children.filter(n=>text(n).includes('重试同一消息')).length,1);
  console.log('PASS 输入法/换行不误发送、非法长度不发请求、失败保留输入、重试复用幂等 ID');

  const b=await boot();await open(b); let release;
  b.hooks.campus_chat_messages=body=>body.p_peer===peers[0].id?new Promise(r=>release=r):[];
  const first=b.nodes['contact-list'].children[0].fire('click');await flush();
  await select(b,1);
  release([{id:'late',sender_id:peers[0].id,recipient_id:'student',body:'过期消息',created_at:'2026-10-01',client_message_id:'late'}]);await first;await flush();
  assert.doesNotMatch(text(b.nodes['message-list']),/过期消息/);
  assert.equal(b.timers.size,2);b.document.hidden=true;await b.docEvents.visibilitychange();
  assert.equal([...b.timers.values()].filter(t=>t.ms===5000).length,0);
  b.document.hidden=false;await b.docEvents.visibilitychange();await flush();
  assert.equal([...b.timers.values()].filter(t=>t.ms===5000).length,1);
  await b.nodes['nav-tasks'].fire('click');assert.equal([...b.timers.values()].filter(t=>t.ms===5000).length,1,'任务页也应检查收件箱');
  await b.nodes.logout.fire('click');assert.equal(b.nodes['message-list'].children.length,0);
  console.log('PASS 切换联系人丢弃旧响应、隐藏/退出停止聊天轮询并清空消息');

  const c=await boot('admin');
  assert.match(c.nodes.identity.textContent,/系统管理员/);assert.equal(c.nodes['add-task'].hidden,true);
  assert.equal(c.nodes['task-list'].children[0].children[1].children.length,0);
  await open(c);await select(c);
  const page=Array.from({length:50},(_,i)=>({id:String(i).padStart(3,'0'),sender_id:peers[0].id,recipient_id:'admin',body:`历史${i}`,created_at:'2026-10-01T00:00:00.000001Z',client_message_id:String(i)}));
  c.hooks.campus_chat_messages=body=>body.p_before_id?[{...page[0],id:'older',body:'最早'}]:page;
  await c.nodes['chat-refresh'].fire('click');
  assert.equal(c.nodes['message-list'].children.length,50);assert.equal(c.nodes['chat-older'].hidden,false);
  await c.nodes['chat-older'].fire('click');assert.equal(c.nodes['message-list'].children.length,51);
  const older=c.requests.filter(r=>r.name==='campus_chat_messages').at(-1).body;
  assert.equal(older.p_before_time,'2026-10-01T00:00:00.000001Z');assert.equal(older.p_before_id,'000');
  await c.nodes['chat-refresh'].fire('click');assert.equal(c.nodes['message-list'].children.length,51);
  console.log('PASS 管理员身份无任务写权限、双字段历史游标、合并无重复');

  // A failed filter must not leave results belonging to a different role on screen.
  c.hooks.campus_chat_contacts=()=>{throw Error('offline');};
  c.nodes['contact-role'].value='student';await c.nodes['contact-role'].fire('change');
  assert.equal(c.nodes['contact-list'].children.length,0,'筛选失败不得显示旧分类的联系人');
  assert.ok(c.nodes['contact-status'].textContent);
  const d=await boot();await open(d);await select(d);
  d.messages.push({id:'first',sender_id:peers[0].id,recipient_id:'student',body:'first',created_at:'2026-01-01T00:00:00Z'});
  await d.nodes['chat-refresh'].fire('click');
  const recent=Array.from({length:50},(_,i)=>({id:`new-${i}`,sender_id:peers[0].id,recipient_id:'student',body:`new-${i}`,created_at:'2026-02-01T00:00:00Z'}));
  d.hooks.campus_chat_messages=body=>body.p_before_id?[d.messages[0],{id:'gap',sender_id:peers[0].id,recipient_id:'student',body:'补齐离线消息',created_at:'2026-01-15T00:00:00Z'}]:recent;
  await d.nodes['chat-refresh'].fire('click');
  assert.equal(d.nodes['message-list'].children.length,52);
  assert.match(text(d.nodes['message-list']),/补齐离线消息/);
  d.hooks.campus_chat_messages=()=>({httpError:'Could not find function in schema cache'});
  await d.nodes['chat-refresh'].fire('click');
  assert.match(d.nodes['chat-status'].textContent,/upgrade-v2-chat.sql/);
  assert.equal(d.nodes['message-list'].children.length,52,'网络失败保留已有消息');
  console.log('PASS 失败筛选不混入旧联系人、超过一页的新消息追页补齐、未升级数据库明确提示');
}
module.exports={boot,flush,peers,text};
if(require.main===module) run().catch(e=>{console.error(e);process.exitCode=1;});
