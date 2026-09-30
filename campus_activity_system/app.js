(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const config = {
    url: document.querySelector('meta[name="supabase-url"]').content.replace(/\/$/, ''),
    key: document.querySelector('meta[name="supabase-publishable-key"]').content
  };
  const sessionKey = `campus.cloud.session:${config.url}`;
  const priorityLabels = { high: '高', medium: '中', low: '低' };
  const roleLabels = { student: '学生', teacher: '教师', admin: '系统管理员' };
  const chat = { active: false, peer: null, contacts: [], messages: [], generation: 0, contactRequest: 0,
    loading: false, sending: false, timer: null, hasOlder: false, hasContacts: false, drafts: new Map(), pending: new Map() };
  const inbox = { rows: [], sequence: 0, loading: false, viewGeneration: 0 };
  const state = { session: null, profile: null, tasks: [], editingId: null, register: false, syncing: false, generation: 0 };
  let refreshPromise = null;
  function notice(text, error = false) {
    $('notice').textContent = text; $('notice').className = error ? 'error' : ''; $('notice').hidden = false;
  }
  function el(tag, className = '', text) {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clearSession() {
    resetChat();
    state.generation++; state.session = null; state.profile = null; state.tasks = [];
    localStorage.removeItem(sessionKey);
    $('task-dialog').close(); $('roster-dialog').close();
    renderIdentity();
  }
  function setSession(data) {
    if (!data.access_token || !data.refresh_token) throw new Error('登录返回数据不完整');
    const session = { access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + data.expires_in };
    localStorage.setItem(sessionKey, JSON.stringify(session));
    state.session = session;
  }
  async function request(path, body, token, method = 'POST') {
    const headers = { apikey: config.key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(`${config.url}${path}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    } catch (error) { throw new Error('网络连接失败，请检查网络后重试。操作结果不确定时，请先刷新列表确认。'); }
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch (error) { throw new Error('云端响应异常，请稍后重试'); }
    if (!response.ok) {
      const code = data?.error_code || data?.code;
      const messages = { invalid_credentials: '用户名或密码不正确', email_not_confirmed: '账号未激活，请联系项目管理者检查云端邮箱确认设置',
        over_email_send_rate_limit: '云端邮箱确认尚未关闭，请联系项目管理者', user_already_exists: '该用户名已注册，请直接登录' };
      const failure = new Error(messages[code] || data?.msg || data?.message || data?.error_description || '云端请求失败');
      failure.status = response.status;
      throw failure;
    }
    return data;
  }
  async function accessToken() {
    if (!state.session) throw new Error('请先登录');
    if (state.session.expires_at * 1000 > Date.now() + 60000) return state.session.access_token;
    if (!refreshPromise) {
      const generation = state.generation;
      refreshPromise = request('/auth/v1/token?grant_type=refresh_token', { refresh_token: state.session.refresh_token })
        .then(data => {
          if (generation !== state.generation) throw new Error('登录状态已变更');
          setSession(data); return data.access_token;
        }).catch(error => {
          if ((error.status === 400 || error.status === 401 || error.status === 403) && generation === state.generation) clearSession();
          throw error;
        }).finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }
  async function rpc(name, args = {}) {
    return request(`/rest/v1/rpc/${name}`, args, await accessToken());
  }
  function renderIdentity() {
    const p = state.profile;
    $('auth-panel').hidden = Boolean(p); $('workspace-panel').hidden = !p;
    $('logout').hidden = !state.session;
    $('identity').textContent = p ? `${p.display_name} · ${roleLabels[p.role] || '未知身份'}` : '尚未登录';
    $('add-task').hidden = p?.role !== 'teacher';
    $('personal-label').textContent = p?.role === 'admin' ? '个人参与（不适用）' : p?.role === 'teacher' ? '我发布的' : '我的报名';
    $('view-filter').replaceChildren(new Option('全部任务', 'all'), new Option('可报名', 'available'),
      new Option(p?.role === 'teacher' ? '我发布的' : '我的报名', 'personal'));
    if (p?.role === 'admin') $('view-filter').replaceChildren(new Option('全部任务','all'),new Option('可报名','available'));
    if (!p) { $('task-list').replaceChildren(); showPage(false); }
  }
  function available(task) { return task.status === 'published' && new Date(task.deadline).getTime() > Date.now(); }
  function localDateTime(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  }
  const displayDate = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });
  function action(label, className, callback, disabled = false) {
    const button = el('button', className, label); button.disabled = disabled;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await callback(); } catch (error) { notice(error.message, true); }
      finally { button.disabled = disabled; }
    });
    return button;
  }
  async function mutate(name, args, message) {
    await rpc(name, args);
    notice(message);
    try { await sync(); } catch (error) { notice(`${message}；列表刷新失败，请点击刷新。`, true); }
  }
  function card(task) {
    const node = el('article', `task-card ${task.priority} ${task.status === 'cancelled' ? 'cancelled' : ''}`);
    const content = el('div','task-content');
    const meta = el('div','task-meta');
    meta.append(el('span','badge',task.course),el('span','badge',task.category),
      el('span',`badge priority-${task.priority}`,`${priorityLabels[task.priority]}优先级`),
      el('span',available(task) ? '' : 'overdue',`截止：${displayDate(task.deadline)}`),
      el('span','',`发布教师：${task.teacher_name}`),el('span','',`${task.enrollment_count} 人报名`));
    if (task.status === 'cancelled') meta.append(el('span','badge','已取消'));
    else if (!available(task)) meta.append(el('span','badge','报名已截止'));
    if (task.enrolled) meta.append(el('span','badge enrolled','✓ 已报名'));
    content.append(el('h3','task-title',task.title),meta);
    const controls = el('div','task-actions');
    if (state.profile.role === 'student') {
      controls.append(action(task.enrolled ? '已报名' : '报名', 'primary',
        () => mutate('campus_enroll',{p_id:task.id},'报名成功，记录已保存到云端。'), task.enrolled || !available(task)));
    } else if (state.profile.role === 'teacher' && state.profile.id === task.teacher_id) {
      controls.append(action('报名名单','quiet',async () => {
        const generation = state.generation;
        const rows = await rpc('campus_roster',{p_id:task.id});
        if (generation !== state.generation) return;
        $('roster-title').textContent = `${task.title} · 报名名单`;
        $('roster-note').textContent = `共 ${rows.length} 人。名单仅对发布教师可见。`;
        $('roster-list').replaceChildren(...rows.map(row => el('li','',`${row.display_name}（${row.student_id.slice(0,8)}） · ${displayDate(row.created_at)}`)));
        $('roster-dialog').showModal();
      }));
      if (task.status === 'published') controls.append(action('编辑','quiet',() => edit(task)),action('取消任务','danger',async () => {
        if (confirm(`确定取消“${task.title}”？已报名记录会保留，学生不能继续报名。`))
          await mutate('campus_cancel_task',{p_id:task.id},'任务已取消。');
      }));
    }
    node.append(content,controls); return node;
  }
  function renderTasks() {
    if (!state.profile) return;
    const course = $('course-filter').value;
    const courses = [...new Set(state.tasks.map(t => t.course))].sort((a,b) => a.localeCompare(b,'zh-CN'));
    if (course && !courses.includes(course)) courses.push(course);
    $('course-filter').replaceChildren(new Option('全部课程',''),...courses.map(name => new Option(name,name)));
    $('course-filter').value = course;
    const view = $('view-filter').value;
    const personal = (t) => state.profile.role === 'teacher' ? t.teacher_id === state.profile.id : t.enrolled;
    const tasks = state.tasks.filter(t => (!course || t.course === course) && (view === 'all' || (view === 'available' ? available(t) : personal(t))));
    $('total').textContent = state.tasks.length;
    $('available').textContent = state.tasks.filter(available).length;
    $('personal').textContent = state.tasks.filter(personal).length;
    $('task-list').replaceChildren(...tasks.map(card));
    $('empty-state').hidden = tasks.length !== 0;
  }
  async function sync() {
    if (!state.profile || state.syncing) return;
    state.syncing = true;
    const generation = state.generation;
    $('refresh').disabled = true;
    try {
      const data = await rpc('campus_list_tasks');
      if (generation !== state.generation) return;
      if (!Array.isArray(data)) throw new Error('任务响应格式异常');
      state.tasks = data; renderTasks();
      $('sync-status').textContent = `最近同步 ${new Date().toLocaleTimeString('zh-CN')} · 每 20 秒更新`;
    } catch (error) { $('sync-status').textContent = '同步失败，显示上次结果；请重试'; throw error; }
    finally { state.syncing = false; $('refresh').disabled = false; }
  }
  async function enter() {
    const generation = state.generation;
    const profile = await rpc('campus_me');
    if (generation !== state.generation) return;
    state.profile = profile;
    renderIdentity(); scheduleChat(); loadInbox(); await sync();
  }
  // 私聊只调用显式鉴权的云端 RPC。generation 防止切换用户/联系人后的过期响应串聊。
  function chatStatus(message, error = false) {
    $('chat-status').textContent = message;
    $('chat-status').className = error ? 'hint chat-error' : 'hint';
  }
  function chatFailure(error) {
    return /schema cache|could not find.*function/i.test(error.message)
      ? '聊天数据库尚未升级，请依次执行 upgrade-v2-chat.sql 和 upgrade-v2-inbox.sql。' : error.message;
  }
  function stopChat() { if (chat.timer !== null) clearInterval(chat.timer); chat.timer = null; }
  function scheduleChat() {
    stopChat();
    if (state.profile && !document.hidden)
      chat.timer = setInterval(async () => {await loadMessages(false); await loadInbox();}, 5000);
  }
  function showPage(messages) {
    if (chat.active !== (messages && Boolean(state.profile))) inbox.viewGeneration++;
    chat.active = messages && Boolean(state.profile);
    $('tasks-panel').hidden = chat.active; $('chat-panel').hidden = !chat.active;
    $('nav-tasks').className = chat.active ? 'quiet' : 'primary';
    $('nav-messages').className = chat.active ? 'primary' : 'quiet';
    $('nav-tasks').setAttribute('aria-pressed', String(!chat.active));
    $('nav-messages').setAttribute('aria-pressed', String(chat.active));
    scheduleChat();
  }
  function resetChat() {
    stopChat(); chat.generation++; chat.contactRequest++;
    inbox.sequence++; inbox.viewGeneration++; inbox.rows = []; inbox.loading = false;
    $('inbox-list').replaceChildren(); $('nav-unread').hidden = true; $('nav-unread').textContent = '';
    $('inbox-health').textContent = ''; $('inbox-status').textContent = ''; $('inbox-empty').hidden = true;
    $('nav-messages').setAttribute('aria-label','消息');
    chat.active = false; chat.peer = null; chat.contacts = []; chat.messages = [];
    chat.loading = false; chat.sending = false; chat.hasOlder = false;
    chat.drafts.clear(); chat.pending.clear();
    $('chat-input').value = ''; $('chat-input').disabled = true; $('chat-send').disabled = true;
    $('message-list').replaceChildren(); $('contact-list').replaceChildren();
    $('message-empty').hidden = false; $('chat-title').textContent = '选择联系人';
    $('chat-peer').textContent = '与学生、教师或系统管理员一对一交流';
    $('contact-status').textContent = ''; $('contacts-more').hidden = true;
    $('chat-older').hidden = true; $('chat-refresh').disabled = true;
    chatStatus('消息仅对双方开放；数据库项目所有者拥有维护权限。');
  }
  function renderInbox() {
    $('inbox-list').replaceChildren(...inbox.rows.map(row => {
      const button = el('button',`inbox-item ${chat.peer?.id===row.peer_id?'selected':''}`);
      button.type='button';button.setAttribute('aria-pressed',String(chat.peer?.id===row.peer_id));
      const header=el('span','inbox-item-heading');
      header.append(el('strong','',row.display_name),el('span','inbox-time',displayDate(row.last_at)));
      const preview=el('span','inbox-preview');
      preview.append(el('span','inbox-summary',`${row.last_sender_id===state.profile.id?'我：':''}${row.last_body}`));
      if(row.unread_count>0){const badge=el('span','unread-badge',row.unread_count>99?'99+':String(row.unread_count));badge.setAttribute('aria-label',`${row.unread_count} 条未读`);preview.append(badge);}
      button.append(header,el('span','inbox-role',`${roleLabels[row.role] || '用户'} · ${row.peer_id.slice(-8)}`),preview);
      button.addEventListener('click',()=>selectPeer({id:row.peer_id,display_name:row.display_name,role:row.role}));
      return button;
    }));
    $('inbox-empty').hidden=inbox.rows.length!==0;
  }
  async function loadInbox(force=false) {
    if(!state.profile || document.hidden || (inbox.loading && !force)) return;
    const seq=++inbox.sequence;inbox.loading=true;
    try {
      const data=await rpc('campus_chat_inbox');
      if(seq!==inbox.sequence || !state.profile) return;
      if(!Array.isArray(data?.conversations) || !Number.isSafeInteger(data.total_unread) || data.total_unread<0) throw new Error('收件箱响应格式异常');
      inbox.rows=data.conversations;renderInbox();
      $('nav-unread').textContent=data.total_unread>99?'99+':String(data.total_unread);
      $('nav-unread').hidden=data.total_unread===0;
      $('nav-messages').setAttribute('aria-label',data.total_unread?`消息，${data.total_unread} 条未读`:'消息，无未读');
      $('inbox-status').textContent=data.total_unread?`${data.total_unread} 条未读消息 · 每 5 秒检查`:'暂无未读消息 · 每 5 秒检查';
      $('inbox-health').textContent='';
    } catch(error) {
      if(seq===inbox.sequence){$('inbox-status').textContent=chatFailure(error);$('inbox-health').textContent='消息提醒同步失败，请打开收件箱重试';}
    } finally {if(seq===inbox.sequence)inbox.loading=false;}
  }
  async function showSidebar(contacts=false) {
    $('inbox-pane').hidden=contacts;$('contacts-directory').hidden=!contacts;
    $('tab-inbox').className=contacts?'quiet':'primary';$('tab-contacts').className=contacts?'primary':'quiet';
    $('tab-inbox').setAttribute('aria-pressed',String(!contacts));$('tab-contacts').setAttribute('aria-pressed',String(contacts));
    if(contacts) await loadContacts(true); else await loadInbox(true);
  }
  async function markLoadedRead(gen,view,peer) {
    const visible=()=>state.profile && gen===chat.generation && view===inbox.viewGeneration && chat.peer?.id===peer && chat.active && !document.hidden;
    if(!visible()) return;
    const ids=chat.messages.filter(m=>m.recipient_id===state.profile.id && !m.read_at).map(m=>m.id);
    try {
      for(let i=0;i<ids.length && visible();i+=500){
        const batch=ids.slice(i,i+500);await rpc('campus_chat_mark_read',{p_ids:batch});
        if(gen!==chat.generation || !state.profile) return;
        // 只在服务器确认后更新本地已读状态；角标以重新读取的云端总数为准。
        const marked=new Set(batch);chat.messages.forEach(m=>{if(marked.has(m.id))m.read_at='confirmed';});
      }
      if(ids.length && state.profile) await loadInbox(true);
    } catch(error) {
      if(visible()) chatStatus(`已读状态保存失败，未读提醒暂时保留。${chatFailure(error)}`,true);
    }
  }
  function renderContacts() {
    $('contact-list').replaceChildren(...chat.contacts.map(peer => {
      const button = el('button', `contact ${chat.peer?.id === peer.id ? 'selected' : ''}`);
      button.type = 'button'; button.setAttribute('aria-pressed', String(chat.peer?.id === peer.id));
      button.append(el('strong','',peer.display_name),el('span','hint',`${roleLabels[peer.role] || '用户'} · ${peer.id.slice(-8)}`));
      button.addEventListener('click', () => selectPeer(peer)); return button;
    }));
  }
  async function loadContacts(reset = true) {
    if (!state.profile) return;
    const seq = ++chat.contactRequest;
    const offset = reset ? 0 : chat.contacts.length;
    if (reset) {chat.contacts = []; renderContacts(); $('contacts-more').hidden = true;}
    $('contacts-more').disabled = true; $('contact-status').textContent = '正在查找联系人…';
    try {
      const rows = await rpc('campus_chat_contacts', { p_role: $('contact-role').value || null,
        p_query: $('contact-query').value.trim(), p_offset: offset });
      if (seq !== chat.contactRequest) return;
      if (!Array.isArray(rows)) throw new Error('联系人响应格式异常');
      chat.contacts = [...new Map([...(reset ? [] : chat.contacts),...rows].filter(p => p.id !== state.profile.id).map(p=>[p.id,p])).values()];
      chat.hasContacts = rows.length === 50; $('contacts-more').hidden = !chat.hasContacts;
      renderContacts(); $('contact-status').textContent = chat.contacts.length ? `已显示 ${chat.contacts.length} 位联系人` : '暂无匹配联系人，可尝试其他身份或姓名。';
    } catch(error) { if (seq === chat.contactRequest) $('contact-status').textContent = chatFailure(error); }
    finally { if (seq === chat.contactRequest) $('contacts-more').disabled = false; }
  }
  async function openMessages() { showPage(true); await showSidebar(false); await loadMessages(false); }
  async function selectPeer(peer) {
    if (chat.peer) chat.drafts.set(chat.peer.id, $('chat-input').value);
    chat.generation++; chat.peer = peer; chat.messages = []; chat.loading = false; chat.sending = false; chat.hasOlder = false;
    $('chat-title').textContent = peer.display_name; $('chat-peer').textContent = `${roleLabels[peer.role] || '用户'} · ${peer.id.slice(-8)} · 一对一私聊`;
    $('chat-input').value = chat.drafts.get(peer.id) || ''; $('chat-input').disabled = false;
    $('chat-send').disabled = false; $('chat-refresh').disabled = false;
    renderContacts(); renderInbox(); renderMessages(); await loadMessages(false); $('chat-input').focus();
  }
  function renderMessages(older = false) {
    const scroll = $('message-scroll'); const height = scroll.scrollHeight; const top = scroll.scrollTop;
    const nearBottom = height - top - scroll.clientHeight < 90;
    $('message-list').replaceChildren(...chat.messages.map(m => {
      const item = el('div', `message ${m.sender_id === state.profile.id ? 'mine' : 'theirs'}`);
      item.setAttribute('role','listitem');
      item.append(el('p','message-body',m.body),el('span','message-time',`${m.sender_id === state.profile.id ? '我' : chat.peer.display_name} · ${displayDate(m.created_at)}`));
      return item;
    }));
    $('message-empty').hidden = chat.messages.length !== 0;
    $('message-empty').replaceChildren(el('h3','','还没有消息'),el('p','','发送第一句问候，开始你们的对话。'));
    $('chat-older').hidden = !chat.hasOlder;
    if (older) scroll.scrollTop = top + scroll.scrollHeight - height;
    else if (nearBottom || chat.messages.length <= 1) scroll.scrollTop = scroll.scrollHeight;
  }
  function mergeMessages(rows) {
    const me = state.profile.id, peer = chat.peer.id;
    if (!Array.isArray(rows) || rows.some(m=>!m.id || typeof m.body !== 'string' ||
      !((m.sender_id===me && m.recipient_id===peer)||(m.sender_id===peer && m.recipient_id===me)))) throw new Error('消息响应与当前会话不一致');
    chat.messages = [...new Map([...chat.messages,...rows].map(m=>[m.id,m])).values()]
      .sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
  }
  async function loadMessages(older = false) {
    if (!state.profile || !chat.peer || chat.loading || !chat.active || document.hidden) return;
    const gen = chat.generation, peer = chat.peer.id, view=inbox.viewGeneration;
    const valid = () => gen === chat.generation && chat.peer?.id === peer && Boolean(state.profile);
    chat.loading = true; $('chat-older').disabled = true; $('chat-refresh').disabled = true;
    let cursor = older ? chat.messages[0] : null;
    const known = new Set(chat.messages.map(m=>m.id)); const collected = [];
    try {
      let rows;
      // 若后台期间超过 50 条新消息，向前追页直到与已加载历史衔接，避免静默漏消息。
      do {
        rows = await rpc('campus_chat_messages',{p_peer:peer,p_before_time:cursor?.created_at || null,p_before_id:cursor?.id || null});
        if (!valid()) return;
        if (!Array.isArray(rows)) throw new Error('消息响应格式异常');
        collected.push(...rows);
        if (older || !known.size || rows.length < 50 || rows.some(m=>known.has(m.id))) break;
        if (cursor?.id === rows[0]?.id) throw new Error('历史分页未推进，请重试');
        cursor = rows[0];
      } while(valid());
      if (!known.size || older) chat.hasOlder = rows.length === 50;
      mergeMessages(collected); renderMessages(older);
      chatStatus(chat.messages.length ? '消息已同步 · 每 5 秒更新' : '还没有消息，发送第一句问候吧。');
      await markLoadedRead(gen,view,peer);
    } catch(error) { if(valid()) chatStatus(chatFailure(error),true); }
    finally { if(valid()) {chat.loading=false; $('chat-older').disabled=false; $('chat-refresh').disabled=false;} }
  }
  async function sendMessage() {
    if (!state.profile || !chat.peer || chat.sending) return;
    const raw = $('chat-input').value, body = raw.trim();
    if (!body || [...body].length>2000) {chatStatus('消息需为 1–2000 字符，不能只输入空白。',true);return;}
    const peer = chat.peer.id, gen = chat.generation, account = state.generation;
    let pending = chat.pending.get(peer);
    if (!pending || pending.body !== body) {pending={body,id:crypto.randomUUID()};chat.pending.set(peer,pending);}
    chat.sending = true; $('chat-send').disabled = true; chatStatus('正在发送…');
    try {
      const message = await rpc('campus_chat_send',{p_peer:peer,p_body:body,p_client_id:pending.id});
      if (account !== state.generation) return;
      if(chat.pending.get(peer)===pending) chat.pending.delete(peer);
      if(chat.drafts.get(peer)===raw) chat.drafts.delete(peer);
      if(gen!==chat.generation) return;
      mergeMessages([message]); renderMessages();
      if($('chat-input').value===raw) $('chat-input').value='';
      $('message-scroll').scrollTop=$('message-scroll').scrollHeight;
      chatStatus('已保存到云端（不代表对方已读）');
      await loadInbox(true);
    } catch(error) { if(gen===chat.generation) chatStatus(`${chatFailure(error)} 输入已保留，可点击发送重试。`,true); }
    finally { if(gen===chat.generation) {chat.sending=false; $('chat-send').disabled=false;} }
  }
  function edit(task = null) {
    if (state.profile?.role !== 'teacher') return;
    state.editingId = task?.id || null;
    const form = $('task-form'); form.reset(); $('form-error').hidden = true;
    $('dialog-title').textContent = task ? '编辑任务' : '发布任务';
    if (task) {
      for (const key of ['title','course','category','priority']) form.elements.namedItem(key).value = task[key];
      form.elements.namedItem('deadline').value = localDateTime(task.deadline);
    }
    $('task-dialog').showModal(); form.elements.namedItem('title').focus();
  }
  $('task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (!values.title.trim() || !values.course.trim() || !values.category.trim()) throw new Error('名称、课程和分类不能为空');
      const deadline = new Date(values.deadline);
      if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw new Error('报名截止时间必须在未来');
      await rpc('campus_save_task',{p_title:values.title.trim(),p_course:values.course.trim(),p_category:values.category.trim(),p_deadline:deadline.toISOString(),p_priority:values.priority,p_id:state.editingId});
      $('task-dialog').close(); notice('任务已保存到云端。');
      try { await sync(); } catch (error) { notice('任务保存成功，但刷新失败。请点击刷新查看。',true); }
    } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
    finally { button.disabled = false; }
  });
  $('auth-mode').addEventListener('click', () => {
    state.register = !state.register;
    $('auth-title').textContent = state.register ? '注册校园账号' : '登录校园账号';
    $('auth-submit').textContent = state.register ? '注册' : '登录';
    $('auth-mode').textContent = state.register ? '已有账号，去登录' : '注册账号';
    $('role-field').hidden = !state.register;
    $('name-field').hidden = !state.register; $('register-hint').hidden = !state.register;
    $('auth-form').elements.namedItem('display_name').required = state.register;
    $('auth-form').elements.namedItem('password').autocomplete = state.register ? 'new-password' : 'current-password';
  });
  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const register = state.register;
    $('auth-submit').disabled = true; $('auth-mode').disabled = true;
    try {
      if (register && !values.display_name.trim()) throw new Error('请输入姓名或昵称');
      const username = values.username.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new Error('用户名需为 3–32 位字母、数字或下划线');
      if (values.password.length < 8 || values.password.length > 128) throw new Error('密码需为 8–128 位');
      if (register) {
        if (!['student','teacher'].includes(values.role)) throw new Error('请选择学生或教师身份');
        // Supabase 使用内部邮箱格式标识账号；不收集真实邮箱，也不发送邮件。
        const settings = await request('/auth/v1/settings', undefined, undefined, 'GET');
        if (settings?.mailer_autoconfirm !== true) throw new Error('云端尚未关闭邮箱确认，请由项目管理者关闭 Confirm email 后再注册');
      }
      const data = await request(register ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password',
        { email: `${username}@accounts.campus-demo.example`, password: values.password,
          ...(register ? { data: { display_name: values.display_name.trim(), role: values.role } } : {}) });
      $('auth-form').elements.namedItem('password').value = '';
      if (!data.access_token) throw new Error('注册未返回登录会话，请联系项目管理者检查邮箱确认设置');
      setSession(data); state.generation++; await enter(); notice('登录成功。');
    } catch (error) { notice(error.message,true); }
    finally { $('auth-submit').disabled = false; $('auth-mode').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    const token = state.session?.access_token;
    clearSession(); notice('已退出当前设备。');
    if (token) try { await request('/auth/v1/logout?scope=local',{},token); }
      catch (error) { notice('本机已退出；网络异常，云端会话撤销未确认。',true); }
  });
  $('add-task').addEventListener('click', () => edit());
  $('close-task').addEventListener('click', () => $('task-dialog').close());
  $('cancel-edit').addEventListener('click', () => $('task-dialog').close());
  $('close-roster').addEventListener('click', () => $('roster-dialog').close());
  $('course-filter').addEventListener('change',renderTasks);
  $('view-filter').addEventListener('change',renderTasks);
  $('refresh').addEventListener('click',() => sync().catch(error => notice(error.message,true)));
  $('nav-messages').addEventListener('click',openMessages);
  $('nav-tasks').addEventListener('click',() => showPage(false));
  $('tab-inbox').addEventListener('click',()=>showSidebar(false));
  $('tab-contacts').addEventListener('click',()=>showSidebar(true));
  $('inbox-refresh').addEventListener('click',()=>loadInbox(true));
  $('contact-role').addEventListener('change',() => loadContacts(true));
  $('contact-search-form').addEventListener('submit',event => {event.preventDefault();return loadContacts(true);});
  $('contacts-more').addEventListener('click',() => loadContacts(false));
  $('chat-refresh').addEventListener('click',() => loadMessages(false));
  $('chat-older').addEventListener('click',() => loadMessages(true));
  $('chat-form').addEventListener('submit',event => {event.preventDefault();return sendMessage();});
  $('chat-input').addEventListener('keydown',event => {
    if (event.key==='Enter' && !event.shiftKey && !event.isComposing && event.keyCode!==229) {event.preventDefault();return sendMessage();}
  });
  window.addEventListener('online',() => sync().catch(error => notice(error.message,true)));
  document.addEventListener('visibilitychange',() => {
    scheduleChat();
    if (!document.hidden) {sync().catch(error => notice(error.message,true));loadMessages(false);loadInbox();}
  });
  window.addEventListener('storage',event => {
    if (event.key === sessionKey) location.reload();
  });
  async function start() {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url) || !config.key) {
      notice('云端项目尚未配置，当前无法登录或共享数据。请由项目管理者完成部署配置。',true);
      $('auth-submit').disabled = true; $('auth-mode').disabled = true; return;
    }
    try {
      state.session = JSON.parse(localStorage.getItem(sessionKey) || 'null');
      if (state.session) await enter();
    } catch (error) { notice(error.message,true); renderIdentity(); }
    setInterval(() => { if (!document.hidden && state.profile) sync().catch(() => {}); },20000);
  }
  start();
})();
