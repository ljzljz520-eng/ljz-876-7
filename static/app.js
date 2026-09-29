'use strict';
/* ============================ 全局状态与工具 ============================ */
const state = {
    token: localStorage.getItem('gw_token') || '',
    user: JSON.parse(localStorage.getItem('gw_user') || 'null'),
    staffTab: 'scores',
    overview: null,
    examinerData: null,
    candidateScore: null,
    candidateAppeals: null,
};

const ROLE_NAME = { staff: '考务人员', examiner: '考官', candidate: '考生' };

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function scoreFmt(v) { return v == null ? '—' : (Math.round(v * 100) / 100).toFixed(2); }

let toastTimer = null;
function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (state.token) init.headers['X-Auth-Token'] = state.token;
    if (opts.body) init.body = JSON.stringify(opts.body);
    let res, data;
    try {
        res = await fetch(path, init);
        data = await res.json();
    } catch (e) {
        throw new Error('网络错误，请检查服务');
    }
    if (res.status === 401) {
        doLogout(true);
        throw new Error(data.error || '登录已过期');
    }
    if (!data.ok) throw new Error(data.error || '操作失败');
    return data;
}

function doLogout(silent) {
    api('/api/logout', { method: 'POST' }).catch(() => {});
    state.token = ''; state.user = null;
    localStorage.removeItem('gw_token'); localStorage.removeItem('gw_user');
    if (!silent) toast('已退出登录', 'success');
    render();
}

function modal(html, wide) {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.id = 'modal-mask';
    mask.innerHTML = '<div class="modal' + (wide ? ' wide' : '') + '">' + html + '</div>';
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    document.body.appendChild(mask);
}
function closeModal() {
    const m = document.getElementById('modal-mask');
    if (m) m.remove();
}
function confirmBox(msg, fn) {
    modal('<div class="modal-head"><h3>操作确认</h3></div>' +
        '<p style="line-height:1.9;color:#445366">' + esc(msg) + '</p>' +
        '<div class="modal-foot"><button class="btn btn-ghost" data-close="1">取消</button>' +
        '<button class="btn btn-danger" data-confirm="1">确认执行</button></div>');
    document.querySelector('[data-confirm]').onclick = () => { closeModal(); fn(); };
    document.querySelector('[data-close]').onclick = closeModal;
}

/* ============================ 渲染入口 ============================ */
function render() {
    const app = document.getElementById('app');
    if (!state.user) { app.innerHTML = viewLogin(); bindLogin(); return; }
    app.innerHTML = viewShell();
    bindShell();
    if (state.user.role === 'examiner') loadExaminer();
    else if (state.user.role === 'staff') loadStaff();
    else loadCandidate();
}

function viewShell() {
    const u = state.user;
    return '<div class="topbar"><div class="brand">公务员面试打分系统<span>结构化面试 · 公正公开</span></div>' +
        '<div class="userbox"><span class="badge-role">' + ROLE_NAME[u.role] + '</span>' +
        '<span>' + esc(u.name) + '</span>' +
        '<button class="btn btn-sm btn-ghost" id="btn-logout">退出</button></div></div>' +
        '<div class="container" id="view-body"><div class="panel" style="text-align:center;color:#8a97a6;padding:50px">加载中…</div></div>';
}
function bindShell() {
    document.getElementById('btn-logout').onclick = () => doLogout();
}
function setBody(html) { document.getElementById('view-body').innerHTML = html; }

/* ============================ 登录页 ============================ */
function viewLogin() {
    return '<div class="login-wrap"><div class="login-card">' +
        '<div class="emblem">公</div><h1>公务员面试打分系统</h1>' +
        '<div class="sub">Civil Servant Interview Scoring Platform</div>' +
        '<div class="field"><label>账号</label><input id="lg-id" placeholder="如 eg001 / u001 / ks001" autocomplete="username"></div>' +
        '<div class="field"><label>密码</label><input id="lg-pwd" type="password" placeholder="初始密码 123456" autocomplete="current-password"></div>' +
        '<button class="btn btn-block" id="btn-login">登 录</button>' +
        '<div class="login-tip">' +
        '考务主管：<b>u001</b>　考官：<b>eg001 ~ eg015</b><br>' +
        '考生：<b>ks001 ~ ks015</b>　初始密码均为 <b>123456</b></div>' +
        '</div></div>';
}
function bindLogin() {
    const go = async () => {
        const id = document.getElementById('lg-id').value.trim();
        const pwd = document.getElementById('lg-pwd').value;
        if (!id || !pwd) return toast('请输入账号和密码', 'error');
        try {
            const d = await api('/api/login', { method: 'POST', body: { id, password: pwd } });
            state.token = d.token; state.user = d.user;
            localStorage.setItem('gw_token', d.token);
            localStorage.setItem('gw_user', JSON.stringify(d.user));
            toast('欢迎，' + d.user.name, 'success');
            render();
        } catch (e) { toast(e.message, 'error'); }
    };
    document.getElementById('btn-login').onclick = go;
    document.getElementById('lg-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

/* ============================ 考官端 ============================ */
async function loadExaminer() {
    setBody('<div class="panel" style="text-align:center;color:#8a97a6;padding:50px">正在加载本组考生…</div>');
    try {
        const d = await api('/api/examiner/candidates');
        state.examinerData = d;
        renderExaminer();
    } catch (e) { setBody('<div class="panel">' + esc(e.message) + '</div>'); }
}

function renderExaminer() {
    const d = state.examinerData;
    let cards = d.candidates.map((c, idx) => {
        const s = c.score || {};
        const canEdit = c.status !== 'absent' && !c.published && !c.recused;
        let headTags = '';
        if (c.status === 'absent') headTags += '<span class="tag tag-gray">缺考</span>';
        if (c.published) headTags += '<span class="tag tag-green">已锁定发布</span>';
        if (c.recused) headTags += '<span class="tag tag-purple">须回避</span>';
        if (!c.published && c.status === 'present' && !c.recused && !c.score)
            headTags += '<span class="tag tag-orange">待评分</span>';
        if (c.score && !c.published) headTags += '<span class="tag tag-blue">已提交/可修改</span>';

        let body;
        if (c.status === 'absent') {
            body = '<div class="muted" style="padding:14px 0;text-align:center">该考生缺考，无需评分</div>';
        } else if (c.recused) {
            body = '<div style="padding:10px 0;line-height:1.9;color:#6f42c1">回避事由：' +
                esc(c.recusal_reason || '已登记回避') + '<br><span class="muted" style="font-size:12.5px">按规定不得对该考生评分</span></div>';
        } else if (c.published) {
            body = '<div class="note-bar" style="margin:0">成绩已由考务发布，评分记录已锁定。<br>' +
                '各维度：结构化 ' + s.structured + ' / 仪态 ' + s.demeanor +
                ' / 政策 ' + s.policy + ' / 应变 ' + s.adaptability +
                '　合计 <b>' + s.total + '</b> 分</div>';
        } else {
            body = d.dims.map(dim =>
                '<div class="dim-row"><label>' + dim.name + '</label>' +
                '<input type="number" min="0" max="' + dim.max + '" data-idx="' + idx +
                '" data-dim="' + dim.key + '" value="' + (s[dim.key] != null ? s[dim.key] : '') +
                '" oninput="onDimInput(this)" onkeydown="if(event.key===\'Enter\')submitExaminerScore(' + idx + ')">' +
                '<span class="cap">满分' + dim.max + '</span></div>').join('') +
                '<div class="dim-total"><span class="t">本人打分合计（百分制）</span><span class="v" id="total-' + idx + '">' +
                (s.total != null ? s.total : '0') + '</span></div>' +
                '<div style="margin-top:12px;text-align:right"><button class="btn btn-sm ' +
                (c.score ? 'btn-gold' : '') + '" data-ex-score="' + idx + '">' +
                (c.score ? '修改并重新提交' : '提交评分') + '</button></div>';
        }
        return '<div class="cand-card' + (c.status === 'absent' ? ' absent' : '') +
            (c.published ? ' locked' : '') + '"><div class="cand-head"><div class="cand-seq">' +
            c.seq + '</div><div style="flex:1"><h3>' + esc(c.name) +
            ' <span class="muted" style="font-size:12px;font-weight:400">(' + esc(c.id) + ')</span></h3>' +
            '<div class="meta">本组第 ' + c.seq + ' 号考生</div></div>' + headTags + '</div>' + body + '</div>';
    }).join('');

    setBody(
        '<div class="panel"><div class="panel-title">' + esc(d.group.name) + ' · 考官评分台' +
        '<span class="tools" style="font-size:13px;color:#7d8b9c">考官：' + esc(d.examiner_name) +
        '　按四个维度独立打分，系统实时合计</span></div>' +
        '<div class="note-bar">评分规则：四维度满分分别为 结构化题目40分、仪态表达20分、政策理解20分、应变能力20分，合计100分。' +
        '成绩发布前可修改本人评分；最终成绩由系统<b>去掉一个最高分、一个最低分</b>后取其余考官平均分。' +
        '存在回避关系的考生请不要评分，系统将自动剔除相关分数。</div></div>' +
        '<div class="score-grid">' + cards + '</div>');

    document.querySelectorAll('[data-ex-score]').forEach(btn => {
        btn.onclick = () => submitExaminerScore(parseInt(btn.dataset.exScore));
    });
}

function onDimInput(inp) {
    const idx = inp.dataset.idx;
    const card = inp.closest('.cand-card');
    let total = 0;
    state.examinerData.dims.forEach(dim => {
        const el = card.querySelector('[data-dim="' + dim.key + '"]');
        let v = parseInt(el.value);
        if (isNaN(v)) v = 0;
        if (v < 0) { v = 0; el.value = 0; }
        if (v > dim.max) { v = dim.max; el.value = dim.max; toast(dim.name + '最高 ' + dim.max + ' 分', 'error'); }
        total += v;
    });
    document.getElementById('total-' + idx).textContent = total;
}

async function submitExaminerScore(idx) {
    const c = state.examinerData.candidates[idx];
    const card = document.querySelectorAll('.cand-card')[idx];
    const body = { candidate_id: c.id };
    let ok = true;
    state.examinerData.dims.forEach(dim => {
        const el = card.querySelector('[data-dim="' + dim.key + '"]');
        const v = el.value.trim();
        if (v === '') { ok = false; toast('请为「' + dim.name + '」打分', 'error'); return; }
        body[dim.key] = parseInt(v);
    });
    if (!ok) return;
    try {
        const r = await api('/api/examiner/score', { method: 'POST', body });
        toast('评分已提交，合计 ' + r.total + ' 分', 'success');
        loadExaminer();
    } catch (e) { toast(e.message, 'error'); }
}

/* ============================ 考务端 ============================ */
async function loadStaff() {
    if (!state.overview)
        setBody('<div class="panel" style="text-align:center;color:#8a97a6;padding:50px">正在加载考务数据…</div>');
    try {
        const d = await api('/api/staff/overview');
        state.overview = d.data;
        renderStaff();
    } catch (e) { setBody('<div class="panel">' + esc(e.message) + '</div>'); }
}

function gname(gid) {
    const g = state.overview.groups.find(x => x.id === gid);
    return g ? g.name : '—';
}

function renderStaff() {
    const ov = state.overview;
    const tabs = [['scores', '成绩管理'], ['affairs', '考务管理'], ['recusal', '回避管理'], ['appeals', '申诉处理']];
    let html = '<div class="tabs">' + tabs.map(([k, n]) =>
        '<div class="tab' + (state.staffTab === k ? ' active' : '') + '" data-tab="' + k + '">' +
        n + (k === 'appeals' ? staffAppealBadge(ov) : '') + '</div>').join('') + '</div>';
    html += '<div id="tab-content"></div>';
    setBody(html);
    document.querySelectorAll('.tab').forEach(t => t.onclick = () => { state.staffTab = t.dataset.tab; renderStaff(); });

    if (state.staffTab === 'scores') renderStaffScores();
    else if (state.staffTab === 'affairs') renderStaffAffairs();
    else if (state.staffTab === 'recusal') renderStaffRecusal();
    else renderStaffAppeals();
}

function staffAppealBadge(ov) {
    const n = ov.appeals.filter(a => a.status === 'pending').length;
    return n ? ' <span class="tag tag-red">' + n + '</span>' : '';
}

function staffStats(ov) {
    let published = 0, absent = 0, pending = 0, rec = ov.recusals.length, ap = 0;
    ov.candidates.forEach(c => {
        if (c.published) published++;
        if (c.status === 'absent') absent++;
        else if (!c.published) pending++;
    });
    ap = ov.appeals.filter(a => a.status === 'pending').length;
    return '<div class="stat-row">' +
        statCard(ov.candidates.length, '考生总数') +
        statCard(published, '成绩已公布', 'green') +
        statCard(pending, '待处理考生', 'gold') +
        statCard(absent, '缺考', 'red') +
        statCard(rec, '回避登记') +
        statCard(ap, '待复申诉', 'red') + '</div>';
}
function statCard(n, l, cls) {
    return '<div class="stat-card ' + (cls || '') + '"><div class="num">' + n + '</div><div class="lbl">' + l + '</div></div>';
}

function renderStaffScores() {
    const ov = state.overview;
    const rows = ov.candidates.map((c, i) => {
        const n = c.counts;
        let status;
        if (c.status === 'absent') status = '<span class="tag tag-gray">缺考</span>';
        else if (c.published) {
            status = '<span class="tag tag-green">已公布</span>';
            // 公布后若发生换组/回避等导致明细变化，提示考务核对
            if (c.provisional != null && Math.abs(c.provisional - c.final_score) > 0.001)
                status += ' <span class="tag tag-red">明细已变动，需复核</span>';
        }
        else if (n.submitted < n.expected) status = '<span class="tag tag-orange">评分中 ' + n.submitted + '/' + n.expected + '</span>';
        else status = '<span class="tag tag-blue">可发布</span>';
        const shown = c.published ? c.final_score : c.provisional;
        return '<tr><td class="center">' + esc(gname(c.group_id)) + '</td>' +
            '<td class="center">' + c.seq + '</td><td>' + esc(c.name) +
            ' <span class="muted">(' + esc(c.id) + ')</span></td>' +
            '<td class="center">' + n.submitted + '/' + n.expected +
            (n.recused ? ' <span class="tag tag-purple">回避' + n.recused + '</span>' : '') + '</td>' +
            '<td class="center" style="font-weight:700;color:' + (c.published ? '#c0392b' : '#1f5a9e') + '">' +
            (c.status === 'absent' ? '—' : scoreFmt(shown)) +
            (c.published ? '' : '<div class="muted" style="font-size:11px;font-weight:400">预计算</div>') + '</td>' +
            '<td class="center">' + status + '</td>' +
            '<td class="center">' + (c.pending_appeals ? '<span class="tag tag-red">申诉' + c.pending_appeals + '</span>' : '') + '</td>' +
            '<td class="center" style="white-space:nowrap">' +
            '<button class="btn btn-sm btn-ghost" data-detail="' + esc(c.id) + '">评分明细</button> ' +
            (c.status !== 'absent' && !c.published
                ? '<button class="btn btn-sm" data-publish="' + esc(c.id) + '"' +
                  (n.submitted < n.expected || n.valid < 3 ? ' disabled' : '') + '>公布成绩</button>'
                : '') +
            (c.published ? '<button class="btn btn-sm btn-gold" data-unpublish="' + esc(c.id) + '">撤回公布</button>' : '') +
            '</td></tr>';
    }).join('');

    document.getElementById('tab-content').innerHTML =
        staffStats(ov) +
        '<div class="panel"><div class="panel-title">考生成绩总表' +
        '<span class="tools">规则：去掉一个最高分、一个最低分，取剩余平均分；不足3份有效分不可公布</span></div>' +
        '<table><thead><tr><th class="center">面试组</th><th class="center">序号</th><th>考生</th>' +
        '<th class="center">打分进度</th><th class="center">成绩</th><th class="center">状态</th>' +
        '<th class="center">申诉</th><th class="center">操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

    document.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => openResultDetail(b.dataset.detail));
    document.querySelectorAll('[data-publish]').forEach(b => b.onclick = () =>
        confirmBox('确认公布该考生最终成绩？公布后考官评分将锁定，考生端可查分并可申诉。',
            () => staffPublish(b.dataset.publish)));
    document.querySelectorAll('[data-unpublish]').forEach(b => b.onclick = () =>
        confirmBox('撤回公布后，考生端将无法查看该成绩，考官可继续修改评分。确认撤回？',
            () => staffUnpublish(b.dataset.unpublish)));
}

async function staffPublish(cid) {
    try {
        const d = await api('/api/staff/publish', { method: 'POST', body: { candidate_id: cid } });
        toast('成绩已公布：' + scoreFmt(d.final_score) + ' 分', 'success');
        await loadStaff();
    } catch (e) { toast(e.message, 'error'); }
}
async function staffUnpublish(cid) {
    try {
        await api('/api/staff/unpublish', { method: 'POST', body: { candidate_id: cid } });
        toast('已撤回公布', 'success');
        await loadStaff();
    } catch (e) { toast(e.message, 'error'); }
}

async function openResultDetail(cid) {
    try {
        const d = await api('/api/staff/result?cid=' + encodeURIComponent(cid));
        const r = d.result;
        const c = r.candidate;
        let recHtml = '';
        if (r.recusals.length) {
            recHtml = '<div class="note-bar" style="border-left-color:#6f42c1">回避考官：' +
                r.recusals.map(x => esc(x.examiner_name) + '（' + esc(x.reason) + '）').join('；') + '</div>';
        }
        const rows = r.entries.map(e =>
            '<tr class="' + (e.status === 'valid' ? (e.dropped ? 'row-drop' : '') : 'row-invalid') + '">' +
            '<td>' + esc(e.examiner_name) + ' <span class="muted">(' + esc(e.examiner_id) + ')</span></td>' +
            '<td class="center">' + e.structured + '</td><td class="center">' + e.demeanor +
            '</td><td class="center">' + e.policy + '</td><td class="center">' + e.adaptability +
            '</td><td class="center"><b>' + e.total + '</b></td>' +
            '<td class="center">' +
            (e.drop_tag ? '<span class="tag tag-red">' + e.drop_tag + '剔除</span>'
                : e.status === 'recused' ? '<span class="tag tag-purple">回避作废</span>'
                : e.status === 'out_of_panel' ? '<span class="tag tag-gray">非本组考官</span>'
                : '<span class="tag tag-green">计入平均</span>') + '</td></tr>').join('');
        const n = r.counts;
        let finalDesc = r.final != null
            ? ('<div class="box"><div class="n" style="color:#c0392b">' + scoreFmt(r.final) + '</div><div class="l">最终/预计算成绩</div></div>')
            : '<div class="box"><div class="n muted">—</div><div class="l">有效分不足3份</div></div>';
        modal('<div class="modal-head"><h3>评分明细 · ' + esc(c.name) + '（' + esc(gname(c.group_id)) +
            ' 第' + c.seq + '号）</h3><button class="modal-close" data-close="1">✕</button></div>' + recHtml +
            '<div class="detail-final"><div class="box"><div class="n">' + n.panel + '</div><div class="l">本组考官</div></div>' +
            '<div class="box"><div class="n">' + n.recused + '</div><div class="l">回避</div></div>' +
            '<div class="box"><div class="n">' + n.valid + '</div><div class="l">有效评分</div></div>' + finalDesc + '</div>' +
            '<table><thead><tr><th>考官</th><th class="center">结构化(40)</th><th class="center">仪态(20)</th>' +
            '<th class="center">政策(20)</th><th class="center">应变(20)</th><th class="center">合计</th><th class="center">处理</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>' +
            '<div class="modal-foot"><button class="btn btn-ghost" data-close="1">关闭</button></div>', true);
        document.querySelector('[data-close]').onclick = closeModal;
    } catch (e) { toast(e.message, 'error'); }
}

/* ---------- 考务管理：缺考 / 换组 / 新增考生 ---------- */
function renderStaffAffairs() {
    const ov = state.overview;
    const groupOpts = ov.groups.map(g => '<option value="' + g.id + '">' + esc(g.name) + '</option>').join('');

    const candRows = ov.candidates.map(c =>
        '<tr><td>' + esc(gname(c.group_id)) + '</td><td class="center">' + c.seq + '</td>' +
        '<td>' + esc(c.name) + ' <span class="muted">(' + esc(c.id) + ')</span></td>' +
        '<td class="center">' + (c.status === 'absent' ? '<span class="tag tag-gray">缺考</span>' : '<span class="tag tag-green">正常</span>') + '</td>' +
        '<td class="center" style="white-space:nowrap">' +
        (c.status === 'present'
            ? '<button class="btn btn-sm btn-danger" data-set-absent="' + esc(c.id) + '">标记缺考</button>'
            : '<button class="btn btn-sm" data-set-present="' + esc(c.id) + '">恢复正常</button>') +
        ' <button class="btn btn-sm btn-ghost" data-move-cand="' + esc(c.id) + '">换组</button></td></tr>').join('');

    const examRows = ov.examiners.map(e =>
        '<tr><td>' + esc(e.name) + ' <span class="muted">(' + esc(e.id) + ')</span></td>' +
        '<td class="center">' + esc(gname(e.group_id)) + '</td>' +
        '<td class="center"><button class="btn btn-sm btn-ghost" data-move-exam="' + esc(e.id) + '">调动组别</button></td></tr>').join('');

    document.getElementById('tab-content').innerHTML =
        '<div class="panel"><div class="panel-title">新增考生' +
        '<span class="tools">新考生初始密码 123456，按组内末尾自动编号</span></div>' +
        '<div class="inline-form"><div class="field"><label>姓名</label><input id="nc-name" placeholder="考生姓名"></div>' +
        '<div class="field"><label>分配面试组</label><select id="nc-group">' + groupOpts + '</select></div>' +
        '<button class="btn" id="btn-add-cand">新增考生</button></div></div>' +
        '<div class="panel"><div class="panel-title">考生缺考与换组<span class="tools">换组将清空原评分记录，成绩需重新评定</span></div>' +
        '<table><thead><tr><th>当前组别</th><th class="center">序号</th><th>考生</th><th class="center">应考状态</th><th class="center">操作</th></tr></thead>' +
        '<tbody>' + candRows + '</tbody></table></div>' +
        '<div class="panel"><div class="panel-title">考官换组<span class="tools">考官换组后，其在原组所打分数自动失效；回避登记保留备查</span></div>' +
        '<table><thead><tr><th>考官</th><th class="center">当前组别</th><th class="center">操作</th></tr></thead>' +
        '<tbody>' + examRows + '</tbody></table></div>';

    document.getElementById('btn-add-cand').onclick = staffAddCandidate;
    document.querySelectorAll('[data-set-absent]').forEach(b => b.onclick = () =>
        confirmBox('标记缺考后将清空该考生的全部评分且不能发布成绩，确认？',
            () => staffSetStatus(b.dataset.setAbsent, 'absent')));
    document.querySelectorAll('[data-set-present]').forEach(b => b.onclick = () =>
        staffSetStatus(b.dataset.setPresent, 'present'));
    document.querySelectorAll('[data-move-cand]').forEach(b => b.onclick = () =>
        openMoveCandidate(b.dataset.moveCand));
    document.querySelectorAll('[data-move-exam]').forEach(b => b.onclick = () =>
        openMoveExaminer(b.dataset.moveExam));
}

async function staffAddCandidate() {
    const name = document.getElementById('nc-name').value.trim();
    const group_id = parseInt(document.getElementById('nc-group').value);
    if (!name) return toast('请填写考生姓名', 'error');
    try {
        const d = await api('/api/staff/candidate', { method: 'POST', body: { name, group_id } });
        toast('新增成功，考生账号：' + d.id + '（初始密码 123456）', 'success');
        await loadStaff();
    } catch (e) { toast(e.message, 'error'); }
}

async function staffSetStatus(cid, status) {
    try {
        await api('/api/staff/absent', { method: 'POST', body: { candidate_id: cid, status } });
        toast(status === 'absent' ? '已标记缺考并清空评分' : '已恢复正常应考', 'success');
        await loadStaff();
    } catch (e) { toast(e.message, 'error'); }
}

function moveGroupModal(title, bodyHint, onOk) {
    const ov = state.overview;
    const opts = ov.groups.map(g => '<option value="' + g.id + '">' + esc(g.name) + '</option>').join('');
    modal('<div class="modal-head"><h3>' + esc(title) + '</h3><button class="modal-close" data-close="1">✕</button></div>' +
        '<div class="note-bar">' + bodyHint + '</div>' +
        '<div class="field"><label>目标面试组</label><select id="mv-group">' + opts + '</select></div>' +
        '<div class="field"><label>组内序号（留空自动排到末尾）</label><input id="mv-seq" type="number" min="1" placeholder="自动编号"></div>' +
        '<div class="modal-foot"><button class="btn btn-ghost" data-close="1">取消</button>' +
        '<button class="btn" id="mv-ok">确认调动</button></div>');
    document.querySelector('[data-close]').onclick = closeModal;
    document.getElementById('mv-ok').onclick = onOk;
}
function openMoveCandidate(cid) {
    const c = state.overview.candidates.find(x => x.id === cid);
    document.getElementById('mv-group').value = c.group_id;
    moveGroupModal('考生换组 · ' + c.name,
        '换组后该考生原有评分记录将被清空，最终成绩作废，需由新组考官重新打分；已公布成绩同步撤回。',
        async () => {
            const group_id = parseInt(document.getElementById('mv-group').value);
            const seqRaw = document.getElementById('mv-seq').value.trim();
            const seq = seqRaw ? parseInt(seqRaw) : null;
            try {
                await api('/api/staff/move-candidate', { method: 'POST', body: { candidate_id: cid, group_id, seq } });
                toast('考生已调整至新面试组', 'success');
                closeModal(); await loadStaff();
            } catch (e) { toast(e.message, 'error'); }
        });
}
function openMoveExaminer(eid) {
    const ov = state.overview;
    const e = ov.examiners.find(x => x.id === eid);
    moveGroupModal('考官换组 · ' + e.name,
        '换组后该考官在原面试组所打分数自动失效；其回避登记记录保留，由系统自动识别适用组别。',
        async () => {
            const group_id = parseInt(document.getElementById('mv-group').value);
            try {
                await api('/api/staff/move-examiner', { method: 'POST', body: { examiner_id: eid, group_id } });
                toast('考官已调动组别', 'success');
                closeModal(); await loadStaff();
            } catch (e2) { toast(e2.message, 'error'); }
        });
}

/* ---------- 回避管理 ---------- */
function renderStaffRecusal() {
    const ov = state.overview;
    const examOpts = ov.examiners.map(e =>
        '<option value="' + esc(e.id) + '">' + esc(e.name) + '（' + esc(gname(e.group_id)) + ' · ' + esc(e.id) + '）</option>').join('');
    const candOpts = ov.candidates.filter(c => c.status !== 'absent').map(c =>
        '<option value="' + esc(c.id) + '">' + esc(gname(c.group_id)) + ' · ' + c.seq + '号 ' +
        esc(c.name) + '</option>').join('');

    const rows = ov.recusals.map(r => {
        const e = ov.examiners.find(x => x.id === r.examiner_id);
        const c = ov.candidates.find(x => x.id === r.candidate_id);
        return '<tr><td>' + (e ? esc(e.name) : '—') +
            (e && e.group_id !== (c ? c.group_id : -1) ? ' <span class="tag tag-gray">现非同组</span>' : '') +
            '</td><td>' + (c ? esc(c.name) + '（' + esc(gname(c.group_id)) + '）' : '—') + '</td>' +
            '<td>' + esc(r.reason) + '</td><td class="muted">' + esc(r.created_at) + '</td>' +
            '<td class="center"><button class="btn btn-sm btn-danger" data-del-rec="' + r.id + '">解除回避</button></td></tr>';
    }).join('');

    document.getElementById('tab-content').innerHTML =
        '<div class="panel"><div class="panel-title">登记回避关系</div>' +
        '<div class="note-bar">回避情形包括：夫妻关系、直系血亲、三代以内旁系血亲及姻亲，或其他可能影响公正评分的关系。' +
        '登记后，该考官对此考生的评分将从有效分中剔除（已提交的评分立即作废）。</div>' +
        '<div class="inline-form"><div class="field"><label>考官</label><select id="rc-exam" style="min-width:220px">' + examOpts + '</select></div>' +
        '<div class="field"><label>考生</label><select id="rc-cand" style="min-width:220px">' + candOpts + '</select></div>' +
        '<div class="field" style="min-width:260px"><label>回避事由</label><input id="rc-reason" placeholder="如：夫妻关系 / 师生关系"></div>' +
        '<button class="btn" id="btn-add-rec">登记回避</button></div></div>' +
        '<div class="panel"><div class="panel-title">回避关系列表</div>' +
        (rows ? '<table><thead><tr><th>考官</th><th>考生</th><th>回避事由</th><th>登记时间</th><th class="center">操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<p class="muted" style="padding:10px 0">暂无回避登记</p>') + '</div>';

    document.getElementById('btn-add-rec').onclick = staffAddRecusal;
    document.querySelectorAll('[data-del-rec]').forEach(b => b.onclick = () =>
        confirmBox('确认解除该回避关系？解除后该考官可恢复对该考生评分。',
            () => staffDelRecusal(b.dataset.delRec)));
}
async function staffAddRecusal() {
    const examiner_id = document.getElementById('rc-exam').value;
    const candidate_id = document.getElementById('rc-cand').value;
    const reason = document.getElementById('rc-reason').value.trim();
    if (!reason) return toast('请填写回避事由', 'error');
    try {
        await api('/api/staff/recusal', { method: 'POST', body: { examiner_id, candidate_id, reason } });
        toast('回避关系已登记，相关评分已剔除', 'success');
        await loadStaff();
    } catch (e) { toast(e.message, 'error'); }
}
async function staffDelRecusal(id) {
    try {
        await api('/api/staff/recusal/remove', { method: 'POST', body: { id: parseInt(id) } });
        toast('回避关系已解除', 'success');
        await loadStaff();
    } catch (e) { toast(e.message, 'error'); }
}

/* ---------- 申诉处理 ---------- */
function appealItem(a, forStaff) {
    const head = '<div class="ah"><span>申诉编号 #' + a.id +
        (forStaff ? '　考生：' + esc(a.candidate_name) + '（' + esc(a.candidate_id) + '）' : '') +
        '</span><span>' + esc(a.created_at) + '</span></div>';
    let status;
    if (a.status === 'pending') status = '<span class="tag tag-orange">待处理</span>';
    else status = '<span class="tag tag-green">已答复</span>';
    let reply = '';
    if (a.status === 'replied') {
        reply = '<div class="appeal-reply"><b>考务答复' + (a.replied_at ? '（' + esc(a.replied_at) + '）' : '') +
            '：</b><br>' + esc(a.reply) + '</div>';
    }
    let act = '';
    if (forStaff && a.status === 'pending')
        act = '<div style="margin-top:12px;text-align:right"><button class="btn btn-sm" data-reply="' + a.id + '">填写答复</button></div>';
    return '<div class="appeal-item"><div class="ah"><span>申诉内容</span>' + status + '</div>' +
        head + '<div class="body">' + esc(a.content) + '</div>' + reply + act + '</div>';
}
function renderStaffAppeals() {
    const list = state.overview.appeals;
    document.getElementById('tab-content').innerHTML =
        '<div class="panel"><div class="panel-title">考生申诉处理</div>' +
        (list.length ? list.map(a => appealItem(a, true)).join('')
            : '<p class="muted" style="padding:10px 0">暂无申诉</p>') + '</div>';
    document.querySelectorAll('[data-reply]').forEach(b => b.onclick = () => openReply(b.dataset.reply));
}
function openReply(id) {
    const a = state.overview.appeals.find(x => String(x.id) === String(id));
    modal('<div class="modal-head"><h3>答复申诉 #' + a.id + '</h3><button class="modal-close" data-close="1">✕</button></div>' +
        '<div class="appeal-item" style="margin-bottom:14px"><div class="body">' + esc(a.content) + '</div></div>' +
        '<div class="field"><label>答复内容（将展示给考生）</label><textarea id="rp-text" placeholder="请填写复核结论与答复意见"></textarea></div>' +
        '<div class="modal-foot"><button class="btn btn-ghost" data-close="1">取消</button>' +
        '<button class="btn" id="rp-ok">提交答复</button></div>');
    document.querySelector('[data-close]').onclick = closeModal;
    document.getElementById('rp-ok').onclick = async () => {
        const reply = document.getElementById('rp-text').value.trim();
        if (reply.length < 2) return toast('请填写答复内容', 'error');
        try {
            await api('/api/staff/reply-appeal', { method: 'POST', body: { id: a.id, reply } });
            toast('答复已提交', 'success');
            closeModal(); await loadStaff();
        } catch (e) { toast(e.message, 'error'); }
    };
}

/* ============================ 考生端 ============================ */
async function loadCandidate() {
    setBody('<div class="panel" style="text-align:center;color:#8a97a6;padding:50px">正在加载成绩…</div>');
    try {
        const [s, a] = await Promise.all([api('/api/candidate/score'), api('/api/candidate/appeals')]);
        state.candidateScore = s.info;
        state.candidateAppeals = a.appeals;
        renderCandidate();
    } catch (e) { setBody('<div class="panel">' + esc(e.message) + '</div>'); }
}

function renderCandidate() {
    const info = state.candidateScore;
    let cert;
    if (info.status === 'absent') {
        cert = '<div class="score-cert"><div class="title">面 试 成 绩 通 知</div><div class="line"></div>' +
            '<div class="waiting"><div class="icon">📋</div><p style="font-size:16px;color:#77849a">缺考，无面试成绩</p></div>' +
            '<div class="meta">考生：' + esc(info.name) + '　|　' + esc(info.group_name) + '　第 ' + info.seq + ' 号</div></div>';
    } else if (!info.published) {
        cert = '<div class="score-cert"><div class="title">面 试 成 绩 通 知</div><div class="line"></div>' +
            '<div class="waiting"><div class="icon">⏳</div><p style="font-size:16px;color:#77849a">成绩尚未公布，请耐心等待</p>' +
            '<p style="margin-top:8px;font-size:13px">公布后可在此查看最终成绩并提交申诉</p></div>' +
            '<div class="meta">考生：' + esc(info.name) + '　|　' + esc(info.group_name) + '　第 ' + info.seq + ' 号</div></div>';
    } else {
        cert = '<div class="score-cert"><div class="title">面 试 成 绩 通 知</div><div class="line"></div>' +
            '<div class="final">' + scoreFmt(info.final_score) + '<span class="unit"> 分</span></div>' +
            '<div class="meta">考生：' + esc(info.name) + '　|　' + esc(info.group_name) + '　第 ' + info.seq + ' 号<br>' +
            '计分方式：去掉一个最高分、一个最低分后取剩余考官评分平均值（百分制）</div></div>';
    }

    const canAppeal = info.published && info.status === 'present' &&
        !state.candidateAppeals.some(a => a.status === 'pending');

    let appealPanel = '<div class="panel"><div class="panel-title">我的申诉</div>';
    if (state.candidateAppeals.length) {
        appealPanel += state.candidateAppeals.map(a => appealItem(a, false)).join('');
    } else {
        appealPanel += '<p class="muted" style="padding:6px 0">暂无申诉记录</p>';
    }
    if (info.status === 'present' && info.published) {
        if (canAppeal) {
            appealPanel += '<div style="margin-top:14px"><button class="btn" id="btn-new-appeal">📮 提交成绩申诉</button>' +
                '<span class="muted" style="margin-left:12px;font-size:12.5px">同一时间仅可提交一条待处理申诉</span></div>';
        } else {
            appealPanel += '<div class="note-bar" style="margin-top:12px">您有一条申诉正在处理中，请等待考务答复。</div>';
        }
    } else if (info.status === 'present') {
        appealPanel += '<div class="note-bar" style="margin-top:12px">成绩公布后方可提交申诉。</div>';
    }
    appealPanel += '</div>';

    setBody(cert + appealPanel);
    const btn = document.getElementById('btn-new-appeal');
    if (btn) btn.onclick = openCandidateAppeal;
}

function openCandidateAppeal() {
    modal('<div class="modal-head"><h3>提交成绩申诉</h3><button class="modal-close" data-close="1">✕</button></div>' +
        '<div class="note-bar">申诉仅限对成绩计算、评分程序等提出异议。提交后由考务人员复核并答复，期间不可重复提交。</div>' +
        '<div class="field"><label>申诉内容</label><textarea id="ap-text" placeholder="请客观说明申诉理由（不少于5个字）"></textarea></div>' +
        '<div class="modal-foot"><button class="btn btn-ghost" data-close="1">取消</button>' +
        '<button class="btn" id="ap-ok">确认提交</button></div>');
    document.querySelector('[data-close]').onclick = closeModal;
    document.getElementById('ap-ok').onclick = async () => {
        const content = document.getElementById('ap-text').value.trim();
        if (content.length < 5) return toast('申诉内容不少于5个字', 'error');
        try {
            await api('/api/candidate/appeal', { method: 'POST', body: { content } });
            toast('申诉已提交，请等待复核答复', 'success');
            closeModal(); loadCandidate();
        } catch (e) { toast(e.message, 'error'); }
    };
}

/* ============================ 启动 ============================ */
render();
