// Front-end contract checks, NOT a substitute for real Supabase / two-device testing.
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[2] || 'cloud-campus';
const html = readFileSync(path.join(root,'index.html'),'utf8');
const code = readFileSync(path.join(root,'app.js'),'utf8');
class Element {
  constructor() { this.children=[]; this.events={}; this.value=''; this.hidden=false; }
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  addEventListener(type,fn){this.events[type]=fn;}
  setAttribute(){}
  focus(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  async fire(type){return this.events[type]?.({preventDefault(){},currentTarget:this,submitter:new Element()});}
}
const tasks = [{id:'task-1',teacher_id:'teacher',teacher_name:'老师',title:'软件工程课程设计',course:'软件工程',category:'课程作业',deadline:'2099-10-15T09:00:00Z',priority:'high',status:'published',enrollment_count:0,enrolled:false}];
const requests=[];
async function boot(role, configured=true, authConfirmed=true){
  const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  const fields=Object.fromEntries(['title','course','category','deadline','priority','email','username','role','password','display_name'].map(k=>[k,new Element()]));
  for(const id of ['task-form','auth-form']){
    nodes[id].elements={namedItem:k=>fields[k]}; nodes[id].reset=()=>{};
  }
  nodes['view-filter'].value='all';
  let timer;
  const session={access_token:role,refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600};
  const storage=new Map([['campus.cloud.session:https://example.supabase.co',JSON.stringify(session)]]);
  const request=async(url,options)=>{
    const name=url.split('/').pop(); requests.push({name,body:options.body ? JSON.parse(options.body) : null,auth:options.headers.Authorization});
    let data;
    if(name==='settings') data={mailer_autoconfirm:authConfirmed};
    else if(name==='campus_chat_inbox') data={conversations:[],total_unread:0};
    else if(name==='signup'||name==='token?grant_type=password') data={...session,expires_in:3600};
    else if(name==='campus_me') data={id:role,role,display_name:role};
    else if(name==='campus_list_tasks') data=tasks;
    else if(name==='campus_enroll'){tasks[0].enrolled=true;tasks[0].enrollment_count=1;data=null;}
    else if(name==='campus_roster') data=[{student_id:'student-123456',display_name:'学生',created_at:new Date().toISOString()}];
    else if(name==='campus_cancel_task'){tasks[0].status='cancelled';data=null;}
    else throw new Error(`Unexpected request ${name}`);
    return {ok:true,text:async()=>JSON.stringify(data)};
  };
  vm.runInNewContext(code,{
    document:{getElementById:id=>nodes[id],createElement:()=>new Element(),querySelector:q=>({content:configured?(q.includes('supabase-url')?'https://example.supabase.co':'public-key'):''}),addEventListener(){}},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    window:{addEventListener(){}},location:{reload(){}},fetch:request,AbortSignal,
    Option:function(text,value){const n=new Element();n.textContent=text;n.value=value;return n;},
    FormData:function(){return Object.entries(fields).map(([k,v])=>[k,v.value]);},
    setInterval:fn=>{timer=fn;},clearInterval(){},confirm:()=>true,console,Date,Math,Set
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {nodes,fields,cards:()=>nodes['task-list'].children,timer};
}
(async()=>{
  const signup=await boot('teacher');
  await signup.nodes['auth-mode'].fire('click');
  Object.entries({username:' Teacher_01 ',display_name:'张老师',password:'test-password-only',role:'teacher'}).forEach(([k,v])=>signup.fields[k].value=v);
  await signup.nodes['auth-form'].fire('submit');
  const sent=requests.find(r=>r.name==='signup');
  assert.ok(sent,'注册必须发出请求，而不是依赖邮箱输入');
  assert.equal(sent.body.email,'teacher_01@accounts.campus-demo.example');
  assert.equal(sent.body.data.role,'teacher');
  assert.equal(sent.body.data.display_name,'张老师');
  await signup.nodes['auth-mode'].fire('click');
  signup.fields.password.value='test-password-only';
  await signup.nodes['auth-form'].fire('submit');
  const login=requests.find(r=>r.name==='token?grant_type=password');
  assert.equal(login.body.email,sent.body.email);
  assert.equal(login.body.data,undefined,'登录不得重新提交角色');
  const before=requests.length;
  signup.fields.username.value='bad name';
  await signup.nodes['auth-form'].fire('submit');
  assert.equal(requests.length,before,'非法用户名不应发出请求');
  const blocked=await boot('student',true,false);
  await blocked.nodes['auth-mode'].fire('click');
  Object.entries({username:'student01',display_name:'学生',password:'test-password-only',role:'student'}).forEach(([k,v])=>blocked.fields[k].value=v);
  const count=requests.filter(r=>r.name==='signup').length;
  await blocked.nodes['auth-form'].fire('submit');
  assert.equal(requests.filter(r=>r.name==='signup').length,count,'未关闭邮件验证时不得创建无法验证的虚拟邮箱账号');
  assert.match(blocked.nodes.notice.textContent,/邮箱确认/);
  console.log('PASS 用户名注册登录映射一致、教师角色提交、非法用户名与未配置确认设置被拦截');
  const student=await boot('student');
  assert.equal(student.nodes['add-task'].hidden,true);
  assert.equal(student.nodes['workspace-panel'].hidden,false);
  assert.equal(student.cards()[0].children[1].children.length,1);
  assert.equal(student.cards()[0].children[1].children[0].textContent,'报名');
  await student.cards()[0].children[1].children[0].fire('click');
  assert.equal(student.cards()[0].children[1].children[0].textContent,'已报名');
  assert.equal(student.cards()[0].children[1].children[0].disabled,true);
  assert.equal(requests.find(r=>r.name==='campus_enroll').auth,'Bearer student');
  console.log('PASS 学生只显示报名操作；发往 RPC 的请求携带登录令牌；刷新后显示已报名');
  const teacher=await boot('teacher');
  assert.equal(teacher.nodes['add-task'].hidden,false);
  assert.deepEqual(teacher.cards()[0].children[1].children.map(b=>b.textContent),['报名名单','编辑','取消任务']);
  await teacher.cards()[0].children[1].children[0].fire('click');
  assert.equal(teacher.nodes['roster-dialog'].open,true);
  assert.equal(teacher.nodes['roster-list'].children.length,1);
  await teacher.cards()[0].children[1].children[2].fire('click');
  assert.match(teacher.cards()[0].className,/cancelled/);
  await student.nodes.refresh.fire('click');
  assert.match(student.cards()[0].className,/cancelled/);
  console.log('PASS 教师显示发布管理与名单；另一个页面上下文刷新后呈现服务端取消状态（模拟接口）');
  const unconfigured=await boot('student',false);
  assert.equal(unconfigured.nodes['auth-submit'].disabled,true);
  assert.match(unconfigured.nodes.notice.textContent,/尚未配置/);
  const formSubmit=teacher.nodes['task-form'];
  Object.entries({title:' ',course:'软件工程',category:'作业',deadline:'2099-10-15T09:00',priority:'high'}).forEach(([k,v])=>teacher.fields[k].value=v);
  await formSubmit.fire('submit');
  assert.match(teacher.nodes['form-error'].textContent,/不能为空/);
  console.log('PASS 未配置项目时禁止假登录；发布表单拒绝空白输入');
  for(const [,id] of code.matchAll(/\$\('([^']+)'\)/g)) assert.ok(html.includes(`id="${id}"`),`Missing HTML id ${id}`);
  console.log('PASS HTML 与 JS 控件引用一致');
})().catch(error=>{console.error(error);process.exitCode=1;});
