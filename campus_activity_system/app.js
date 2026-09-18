(function (global) {
  'use strict';

  const DATA_KEY = 'campusActivityDataV1';
  const SESSION_KEY = 'campusActivitySessionV1';

  function createInitialState() {
    return {
      users: [
        { id: 'teacher-demo', username: 'teacher', password: '123456', role: 'teacher' },
        { id: 'student-demo', username: 'student', password: '123456', role: 'student' }
      ],
      activities: [
        { id: 'activity-demo-1', title: '校园羽毛球友谊赛', time: '2026-10-10T14:00', location: '体育馆一楼', capacity: 20, deadline: '2026-10-08T18:00', status: 'published', teacherId: 'teacher-demo' },
        { id: 'activity-demo-2', title: '软件工程学习交流会', time: '2026-10-15T19:00', location: '教学楼 A201', capacity: 30, deadline: '2026-10-13T18:00', status: 'published', teacherId: 'teacher-demo' }
      ],
      registrations: []
    };
  }

  function loadState() {
    try {
      const value = global.localStorage && global.localStorage.getItem(DATA_KEY);
      if (value) return JSON.parse(value);
    } catch (error) {
      // localStorage 不可用时，仍返回一个可供页面使用的初始状态。
    }
    return createInitialState();
  }

  function saveState(state) {
    global.localStorage.setItem(DATA_KEY, JSON.stringify(state));
  }

  function getSessionUserId() {
    return global.localStorage.getItem(SESSION_KEY);
  }

  function getCurrentUser(state) {
    const userId = getSessionUserId();
    return state.users.find((user) => user.id === userId) || null;
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function formatTime(value) {
    if (!value) return '未填写';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString('zh-CN', { hour12: false });
  }

  function registrationCount(state, activityId) {
    return state.registrations.filter((item) => item.activityId === activityId).length;
  }

  function validateSignUp(user, activity, registrations, now = Date.now()) {
    if (!user || user.role !== 'student') return { ok: false, message: '仅学生可以报名' };
    if (!activity || activity.status !== 'published') return { ok: false, message: '活动不可报名' };
    if (new Date(activity.deadline).getTime() < now) return { ok: false, message: '报名已截止' };
    if (registrations.some((item) => item.userId === user.id && item.activityId === activity.id)) return { ok: false, message: '不可重复报名' };
    if (registrations.filter((item) => item.activityId === activity.id).length >= Number(activity.capacity)) return { ok: false, message: '名额已满' };
    return { ok: true };
  }

  function showNotice(message, type = 'info') {
    const notice = document.getElementById('notice');
    notice.textContent = message;
    notice.className = `notice ${type}`;
    notice.hidden = false;
  }

  function clearNotice() {
    const notice = document.getElementById('notice');
    notice.hidden = true;
    notice.textContent = '';
  }

  function setHidden(id, hidden) {
    document.getElementById(id).hidden = hidden;
  }

  function renderActivities(state, user) {
    const container = document.getElementById('activity-list');
    const activities = state.activities.filter((activity) => activity.status === 'published');
    if (!activities.length) {
      container.innerHTML = '<p class="empty">暂无可报名活动。</p>';
      return;
    }
    container.innerHTML = activities.map((activity) => {
      const teacher = state.users.find((item) => item.id === activity.teacherId);
      const count = registrationCount(state, activity.id);
      const enrolled = user && state.registrations.some((item) => item.userId === user.id && item.activityId === activity.id);
      const button = user && user.role === 'student'
        ? `<button class="button primary" data-action="signup" data-id="${activity.id}" ${enrolled ? 'disabled' : ''}>${enrolled ? '已报名' : '报名'}</button>`
        : '<span class="hint">登录学生账号后可报名</span>';
      return `<article class="activity-card"><div><h3>${escapeHtml(activity.title)}</h3><p>时间：${formatTime(activity.time)}</p><p>地点：${escapeHtml(activity.location)}</p><p>报名截止：${formatTime(activity.deadline)}</p><p>组织教师：${escapeHtml(teacher ? teacher.username : '未知')}</p></div><div class="card-footer"><span class="tag">已报名 ${count} / ${activity.capacity}</span>${button}</div></article>`;
    }).join('');
  }

  function renderStudentPanel(state, user) {
    const rows = state.registrations.filter((item) => item.userId === user.id).map((registration) => {
      const activity = state.activities.find((item) => item.id === registration.activityId);
      if (!activity) return '';
      return `<tr><td>${escapeHtml(activity.title)}</td><td>${formatTime(activity.time)}</td><td>${escapeHtml(activity.location)}</td><td>${activity.status === 'published' ? '已报名' : '活动已取消'}</td></tr>`;
    }).join('');
    document.getElementById('student-registrations').innerHTML = rows || '<tr><td colspan="4" class="empty">暂无报名记录。</td></tr>';
  }

  function renderTeacherPanel(state, user) {
    const activities = state.activities.filter((item) => item.teacherId === user.id);
    document.getElementById('teacher-activities').innerHTML = activities.map((activity) => {
      const count = registrationCount(state, activity.id);
      return `<tr><td>${escapeHtml(activity.title)}</td><td>${formatTime(activity.time)}</td><td>${count} / ${activity.capacity}</td><td>${activity.status === 'published' ? '已发布' : '已取消'}</td><td><button class="button secondary" data-action="roster" data-id="${activity.id}">报名名单</button>${activity.status === 'published' ? `<button class="button danger" data-action="cancel" data-id="${activity.id}">取消活动</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">暂未发布活动。</td></tr>';
  }

  function renderApp() {
    const state = loadState();
    const user = getCurrentUser(state);
    clearNotice();
    document.getElementById('current-user').textContent = user ? `${user.username}（${user.role === 'teacher' ? '教师' : '学生'}）` : '未登录';
    setHidden('auth-section', Boolean(user));
    setHidden('logout-button', !user);
    setHidden('student-panel', !user || user.role !== 'student');
    setHidden('teacher-panel', !user || user.role !== 'teacher');
    renderActivities(state, user);
    if (user && user.role === 'student') renderStudentPanel(state, user);
    if (user && user.role === 'teacher') renderTeacherPanel(state, user);
  }

  function handleAuthSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const action = event.submitter ? event.submitter.value : 'login';
    const username = form.username.value.trim();
    const password = form.password.value;
    const role = form.role.value;
    if (!username || !password) return showNotice('请填写用户名和密码', 'error');
    const state = loadState();
    const existing = state.users.find((user) => user.username === username);
    if (action === 'register') {
      if (existing) return showNotice('用户名已存在', 'error');
      state.users.push({ id: makeId('user'), username, password, role });
      saveState(state);
      form.reset();
      return showNotice('注册成功，请使用新账号登录', 'success');
    }
    if (!existing || existing.password !== password || existing.role !== role) return showNotice('用户名、密码或角色不匹配', 'error');
    global.localStorage.setItem(SESSION_KEY, existing.id);
    renderApp();
    showNotice(`登录成功，欢迎你，${existing.username}`, 'success');
  }

  function handleActivitySubmit(event) {
    event.preventDefault();
    const state = loadState();
    const user = getCurrentUser(state);
    if (!user || user.role !== 'teacher') return showNotice('仅教师可以发布活动', 'error');
    const form = event.currentTarget;
    const title = form.title.value.trim();
    const location = form.location.value.trim();
    const capacity = Number(form.capacity.value);
    const time = form.time.value;
    const deadline = form.deadline.value;
    if (!title || !location || !time || !deadline || !Number.isInteger(capacity) || capacity < 1) return showNotice('请正确填写活动名称、时间、地点、人数上限和报名截止时间', 'error');
    if (new Date(deadline).getTime() >= new Date(time).getTime()) return showNotice('报名截止时间必须早于活动时间', 'error');
    state.activities.unshift({ id: makeId('activity'), title, time, location, capacity, deadline, status: 'published', teacherId: user.id });
    saveState(state);
    form.reset();
    renderApp();
    showNotice('活动发布成功', 'success');
  }

  function signUp(activityId) {
    const state = loadState();
    const user = getCurrentUser(state);
    const activity = state.activities.find((item) => item.id === activityId);
    const result = validateSignUp(user, activity, state.registrations);
    if (!result.ok) return showNotice(result.message, 'error');
    state.registrations.push({ id: makeId('registration'), userId: user.id, activityId, createdAt: new Date().toISOString() });
    saveState(state);
    renderApp();
    showNotice('报名成功', 'success');
  }

  function cancelActivity(activityId) {
    const state = loadState();
    const user = getCurrentUser(state);
    const activity = state.activities.find((item) => item.id === activityId && item.teacherId === (user && user.id));
    if (!activity) return showNotice('无权操作该活动', 'error');
    activity.status = 'cancelled';
    saveState(state);
    renderApp();
    showNotice('活动已取消，报名记录保留供查看', 'success');
  }

  function showRoster(activityId) {
    const state = loadState();
    const user = getCurrentUser(state);
    const activity = state.activities.find((item) => item.id === activityId && item.teacherId === (user && user.id));
    if (!activity) return showNotice('无权查看该活动的报名名单', 'error');
    const names = state.registrations.filter((item) => item.activityId === activityId).map((item) => state.users.find((userItem) => userItem.id === item.userId)).filter(Boolean).map((item) => item.username);
    document.getElementById('roster-title').textContent = `${activity.title} 的报名名单`;
    document.getElementById('roster-list').innerHTML = names.length ? names.map((name) => `<li>${escapeHtml(name)}</li>`).join('') : '<li>暂无报名。</li>';
    document.getElementById('roster-dialog').showModal();
  }

  function resetDemoData() {
    if (!global.confirm('将清除当前浏览器中的账号、活动和报名数据，并恢复演示数据。是否继续？')) return;
    saveState(createInitialState());
    global.localStorage.removeItem(SESSION_KEY);
    renderApp();
    showNotice('已恢复演示数据', 'success');
  }

  function bindEvents() {
    document.getElementById('auth-form').addEventListener('submit', handleAuthSubmit);
    document.getElementById('activity-form').addEventListener('submit', handleActivitySubmit);
    document.getElementById('logout-button').addEventListener('click', () => { global.localStorage.removeItem(SESSION_KEY); renderApp(); });
    document.getElementById('reset-data').addEventListener('click', resetDemoData);
    document.getElementById('roster-close').addEventListener('click', () => document.getElementById('roster-dialog').close());
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      if (button.dataset.action === 'signup') signUp(button.dataset.id);
      if (button.dataset.action === 'cancel') cancelActivity(button.dataset.id);
      if (button.dataset.action === 'roster') showRoster(button.dataset.id);
    });
  }

  const api = { createInitialState, loadState, saveState, getCurrentUser, validateSignUp, escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => { bindEvents(); renderApp(); });
  }
}(typeof window !== 'undefined' ? window : globalThis));
