(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const config = {
    url: document.querySelector('meta[name="supabase-url"]').content.replace(/\/$/, ''),
    key: document.querySelector('meta[name="supabase-publishable-key"]').content
  };
  const sessionKey = `campus.cloud.session:${config.url}`;
  const priorityLabels = { high: '高', medium: '中', low: '低' };
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
    $('identity').textContent = p ? `${p.display_name} · ${p.role === 'teacher' ? '教师' : '学生'}` : '尚未登录';
    $('add-task').hidden = p?.role !== 'teacher';
    $('personal-label').textContent = p?.role === 'teacher' ? '我发布的' : '我的报名';
    $('view-filter').replaceChildren(new Option('全部任务', 'all'), new Option('可报名', 'available'),
      new Option(p?.role === 'teacher' ? '我发布的' : '我的报名', 'personal'));
    if (!p) $('task-list').replaceChildren();
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
    } else if (state.profile.id === task.teacher_id) {
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
    renderIdentity(); await sync();
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
  window.addEventListener('online',() => sync().catch(error => notice(error.message,true)));
  document.addEventListener('visibilitychange',() => { if (!document.hidden) sync().catch(error => notice(error.message,true)); });
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
