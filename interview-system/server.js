'use strict';
/**
 * 公务员面试打分系统
 * 角色：考官（评分）/ 考务（缺考、换组、回避、发布、申诉处理）/ 考生（查成绩、申诉）
 * 计分：四维度加权合成考官总分，去掉一个最高分和一个最低分后取平均
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const { sign, verify } = require('./lib/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const DIM_KEYS = ['structured', 'demeanor', 'policy', 'adaptability'];

// ---------- 工具函数 ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('请求体格式错误')); }
    });
    req.on('error', reject);
  });
}

function getAuth(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? verify(m[1]) : null;
}

function groupName(id) {
  const g = db.data.groups.find((g) => g.id === id);
  return g ? g.name : '';
}

function nextId(arr) {
  return arr.reduce((max, x) => Math.max(max, x.id || 0), 0) + 1;
}

/**
 * 计算考生成绩：
 * 1. 排除缺考；2. 排除存在回避关系的考官评分；
 * 3. 有效评分 >= 3 时，去掉一个最高分和一个最低分，取其余平均分
 */
function computeResult(candidate) {
  if (candidate.status === '缺考') {
    return { status: '缺考', final: null, validCount: 0, scores: [] };
  }
  const recusedExaminers = new Set(
    db.data.recusals.filter((r) => r.candidate_id === candidate.id).map((r) => r.examiner_id)
  );
  const scores = db.data.scores
    .filter((s) => s.candidate_id === candidate.id && !recusedExaminers.has(s.examiner_id))
    .map((s) => {
      const ex = db.data.examiners.find((e) => e.id === s.examiner_id);
      return { ...s, examiner_name: ex ? ex.name : '未知', examiner_code: ex ? ex.code : '' };
    })
    .sort((a, b) => a.total - b.total);

  if (scores.length < 3) {
    return { status: '评分不足', final: null, validCount: scores.length, scores };
  }
  scores[0].removed = '最低分（已去除）';
  scores[scores.length - 1].removed = '最高分（已去除）';
  const trimmed = scores.slice(1, -1);
  const final = Math.round((trimmed.reduce((sum, s) => sum + s.total, 0) / trimmed.length) * 100) / 100;
  return { status: '已完成', final, validCount: scores.length, scores };
}

// ---------- API 处理 ----------
async function handleApi(req, res, pathname) {
  const method = req.method;
  const body = ['POST', 'PUT', 'DELETE'].includes(method) ? await readBody(req) : {};

  // ===== 登录 =====
  if (method === 'POST' && pathname === '/api/login') {
    const { role, code, password } = body;
    if (role === 'examiner') {
      const ex = db.data.examiners.find((e) => e.code === code && e.password === password);
      if (!ex) return sendJson(res, 401, { error: '考官编号或密码错误' });
      return sendJson(res, 200, {
        token: sign({ role: 'examiner', id: ex.id }),
        user: { code: ex.code, name: ex.name, group: groupName(ex.group_id) },
      });
    }
    if (role === 'staff') {
      const st = db.data.staff.find((s) => s.code === code && s.password === password);
      if (!st) return sendJson(res, 401, { error: '账号或密码错误' });
      return sendJson(res, 200, {
        token: sign({ role: 'staff', id: st.id }),
        user: { code: st.code, name: st.name },
      });
    }
    return sendJson(res, 400, { error: '未知角色' });
  }

  if (method === 'POST' && pathname === '/api/candidate/login') {
    const { exam_number, name } = body;
    const c = db.data.candidates.find((c) => c.exam_number === exam_number && c.name === name);
    if (!c) return sendJson(res, 401, { error: '准考证号与姓名不匹配' });
    return sendJson(res, 200, { token: sign({ role: 'candidate', id: c.id }) });
  }

  // ===== 鉴权 =====
  const auth = getAuth(req);
  if (!auth) return sendJson(res, 401, { error: '未登录或登录已过期' });

  // ================= 考官端 =================
  if (auth.role === 'examiner') {
    const examiner = db.data.examiners.find((e) => e.id === auth.id);
    if (!examiner) return sendJson(res, 401, { error: '考官不存在' });

    if (method === 'GET' && pathname === '/api/examiner/candidates') {
      const list = db.data.candidates
        .filter((c) => c.group_id === examiner.group_id)
        .sort((a, b) => a.interview_order - b.interview_order)
        .map((c) => ({
          ...c,
          group_name: groupName(c.group_id),
          recused: db.data.recusals.some((r) => r.examiner_id === examiner.id && r.candidate_id === c.id),
          my_score: db.data.scores.find((s) => s.examiner_id === examiner.id && s.candidate_id === c.id) || null,
        }));
      return sendJson(res, 200, {
        examiner: { name: examiner.name, code: examiner.code, group: groupName(examiner.group_id) },
        published: db.data.settings.resultsPublished,
        dimensions: db.DIMENSIONS,
        candidates: list,
      });
    }

    if (method === 'POST' && pathname === '/api/examiner/score') {
      if (db.data.settings.resultsPublished) return sendJson(res, 403, { error: '成绩已发布，评分通道已关闭' });
      const candidate = db.data.candidates.find((c) => c.id === Number(body.candidate_id));
      if (!candidate) return sendJson(res, 404, { error: '考生不存在' });
      if (candidate.group_id !== examiner.group_id) return sendJson(res, 403, { error: '该考生不在您所在的面试组' });
      if (candidate.status === '缺考') return sendJson(res, 400, { error: '该考生已标记缺考，不能评分' });
      if (db.data.recusals.some((r) => r.examiner_id === examiner.id && r.candidate_id === candidate.id)) {
        return sendJson(res, 403, { error: '您与该考生存在回避关系，不能评分' });
      }
      const vals = {};
      for (const k of DIM_KEYS) {
        const v = Number(body[k]);
        if (!Number.isFinite(v) || v < 0 || v > 100) return sendJson(res, 400, { error: '各项得分须为 0-100 的数字' });
        vals[k] = v;
      }
      const total = db.calcTotal(vals);
      const existing = db.data.scores.find((s) => s.examiner_id === examiner.id && s.candidate_id === candidate.id);
      if (existing) {
        Object.assign(existing, vals, { total, submitted_at: new Date().toISOString() });
      } else {
        db.data.scores.push({
          id: nextId(db.data.scores), candidate_id: candidate.id, examiner_id: examiner.id,
          ...vals, total, submitted_at: new Date().toISOString(),
        });
      }
      if (candidate.status === '待面试') candidate.status = '已面试';
      db.save();
      return sendJson(res, 200, { ok: true, total });
    }

    return sendJson(res, 404, { error: '接口不存在' });
  }

  // ================= 考务端 =================
  if (auth.role === 'staff') {
    // --- 考生管理 ---
    if (method === 'GET' && pathname === '/api/staff/candidates') {
      const list = db.data.candidates
        .map((c) => ({
          ...c,
          group_name: groupName(c.group_id),
          score_count: db.data.scores.filter((s) => s.candidate_id === c.id).length,
        }))
        .sort((a, b) => a.exam_number.localeCompare(b.exam_number));
      return sendJson(res, 200, { candidates: list, groups: db.data.groups });
    }

    if (method === 'POST' && pathname === '/api/staff/candidates') {
      const { name, exam_number } = body;
      const group_id = Number(body.group_id);
      if (!name || !exam_number || !group_id) return sendJson(res, 400, { error: '请填写完整信息' });
      if (db.data.candidates.some((c) => c.exam_number === exam_number)) return sendJson(res, 400, { error: '准考证号已存在' });
      const g = db.data.groups.find((g) => g.id === group_id);
      if (!g) return sendJson(res, 400, { error: '面试组不存在' });
      const c = {
        id: nextId(db.data.candidates), exam_number, name, position: g.position,
        group_id: g.id, status: '待面试',
        interview_order: db.data.candidates.filter((x) => x.group_id === g.id).length + 1,
      };
      db.data.candidates.push(c);
      db.save();
      return sendJson(res, 200, { ok: true, candidate: c });
    }

    // 缺考 / 恢复
    const mStatus = pathname.match(/^\/api\/staff\/candidates\/(\d+)\/status$/);
    if (method === 'PUT' && mStatus) {
      const c = db.data.candidates.find((c) => c.id === Number(mStatus[1]));
      if (!c) return sendJson(res, 404, { error: '考生不存在' });
      const { status } = body;
      if (!['缺考', '待面试'].includes(status)) return sendJson(res, 400, { error: '非法状态' });
      c.status = status === '缺考' ? '缺考' : (db.data.scores.some((s) => s.candidate_id === c.id) ? '已面试' : '待面试');
      db.save();
      return sendJson(res, 200, { ok: true, status: c.status });
    }

    // 换组（清除原评分记录）
    const mGroup = pathname.match(/^\/api\/staff\/candidates\/(\d+)\/group$/);
    if (method === 'PUT' && mGroup) {
      const c = db.data.candidates.find((c) => c.id === Number(mGroup[1]));
      if (!c) return sendJson(res, 404, { error: '考生不存在' });
      const g = db.data.groups.find((g) => g.id === Number(body.group_id));
      if (!g) return sendJson(res, 400, { error: '面试组不存在' });
      if (g.id === c.group_id) return sendJson(res, 400, { error: '考生已在该面试组' });
      const removedScores = db.data.scores.filter((s) => s.candidate_id === c.id).length;
      db.data.scores = db.data.scores.filter((s) => s.candidate_id !== c.id);
      c.group_id = g.id;
      c.position = g.position;
      c.status = '待面试';
      c.interview_order = db.data.candidates.filter((x) => x.group_id === g.id && x.id !== c.id).length + 1;
      db.save();
      return sendJson(res, 200, { ok: true, removedScores });
    }

    // --- 考官管理 ---
    if (method === 'GET' && pathname === '/api/staff/examiners') {
      const list = db.data.examiners.map((e) => ({
        id: e.id, code: e.code, name: e.name, group_id: e.group_id, group_name: groupName(e.group_id),
      }));
      return sendJson(res, 200, { examiners: list, groups: db.data.groups });
    }

    if (method === 'POST' && pathname === '/api/staff/examiners') {
      const { code, name, password } = body;
      const group_id = Number(body.group_id);
      if (!code || !name || !group_id) return sendJson(res, 400, { error: '请填写完整信息' });
      if (db.data.examiners.some((e) => e.code === code)) return sendJson(res, 400, { error: '考官编号已存在' });
      if (!db.data.groups.some((g) => g.id === group_id)) return sendJson(res, 400, { error: '面试组不存在' });
      db.data.examiners.push({ id: nextId(db.data.examiners), code, name, group_id, password: password || '123456' });
      db.save();
      return sendJson(res, 200, { ok: true });
    }

    // --- 回避关系 ---
    if (method === 'GET' && pathname === '/api/staff/recusals') {
      const list = db.data.recusals.map((r) => {
        const e = db.data.examiners.find((x) => x.id === r.examiner_id);
        const c = db.data.candidates.find((x) => x.id === r.candidate_id);
        return {
          ...r,
          examiner_name: e ? e.name : '', examiner_code: e ? e.code : '',
          candidate_name: c ? c.name : '', exam_number: c ? c.exam_number : '',
        };
      });
      return sendJson(res, 200, { recusals: list });
    }

    if (method === 'POST' && pathname === '/api/staff/recusals') {
      const e = db.data.examiners.find((x) => x.id === Number(body.examiner_id));
      const c = db.data.candidates.find((x) => x.id === Number(body.candidate_id));
      if (!e || !c) return sendJson(res, 400, { error: '考官或考生不存在' });
      if (db.data.recusals.some((r) => r.examiner_id === e.id && r.candidate_id === c.id)) {
        return sendJson(res, 400, { error: '该回避关系已存在' });
      }
      db.data.recusals.push({ id: nextId(db.data.recusals), examiner_id: e.id, candidate_id: c.id, reason: body.reason || '' });
      // 回避生效：该考官对该考生已提交的评分作废
      const before = db.data.scores.length;
      db.data.scores = db.data.scores.filter((s) => !(s.examiner_id === e.id && s.candidate_id === c.id));
      db.save();
      return sendJson(res, 200, { ok: true, removedScores: before - db.data.scores.length });
    }

    const mRec = pathname.match(/^\/api\/staff\/recusals\/(\d+)$/);
    if (method === 'DELETE' && mRec) {
      const before = db.data.recusals.length;
      db.data.recusals = db.data.recusals.filter((r) => r.id !== Number(mRec[1]));
      if (db.data.recusals.length === before) return sendJson(res, 404, { error: '记录不存在' });
      db.save();
      return sendJson(res, 200, { ok: true });
    }

    // --- 成绩管理 ---
    if (method === 'GET' && pathname === '/api/staff/results') {
      const results = db.data.candidates
        .slice()
        .sort((a, b) => a.exam_number.localeCompare(b.exam_number))
        .map((c) => ({
          candidate: {
            id: c.id, exam_number: c.exam_number, name: c.name,
            position: c.position, group_name: groupName(c.group_id), status: c.status,
          },
          ...computeResult(c),
        }));
      return sendJson(res, 200, { published: db.data.settings.resultsPublished, results });
    }

    if (method === 'POST' && pathname === '/api/staff/publish') {
      db.data.settings.resultsPublished = !!body.published;
      db.save();
      return sendJson(res, 200, { ok: true, published: db.data.settings.resultsPublished });
    }

    // --- 申诉处理 ---
    if (method === 'GET' && pathname === '/api/staff/appeals') {
      const list = db.data.appeals
        .map((a) => {
          const c = db.data.candidates.find((x) => x.id === a.candidate_id);
          return { ...a, candidate_name: c ? c.name : '', exam_number: c ? c.exam_number : '' };
        })
        .sort((a, b) => b.id - a.id);
      return sendJson(res, 200, { appeals: list });
    }

    const mAppeal = pathname.match(/^\/api\/staff\/appeals\/(\d+)\/reply$/);
    if (method === 'POST' && mAppeal) {
      const a = db.data.appeals.find((x) => x.id === Number(mAppeal[1]));
      if (!a) return sendJson(res, 404, { error: '申诉不存在' });
      if (!body.reply || !body.reply.trim()) return sendJson(res, 400, { error: '请填写回复内容' });
      a.reply = body.reply.trim();
      a.status = '已回复';
      a.replied_at = new Date().toISOString();
      db.save();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: '接口不存在' });
  }

  // ================= 考生端 =================
  if (auth.role === 'candidate') {
    const c = db.data.candidates.find((x) => x.id === auth.id);
    if (!c) return sendJson(res, 401, { error: '考生不存在' });

    // 考生只能看到最终成绩，看不到评分明细
    if (method === 'GET' && pathname === '/api/candidate/result') {
      const published = db.data.settings.resultsPublished;
      const r = computeResult(c);
      const appeals = db.data.appeals
        .filter((a) => a.candidate_id === c.id)
        .sort((a, b) => b.id - a.id);
      return sendJson(res, 200, {
        published,
        candidate: {
          name: c.name, exam_number: c.exam_number, position: c.position,
          group_name: groupName(c.group_id), status: c.status,
        },
        result_status: r.status,
        final: published ? r.final : null,
        appeals,
      });
    }

    if (method === 'POST' && pathname === '/api/candidate/appeal') {
      if (!db.data.settings.resultsPublished) return sendJson(res, 400, { error: '成绩尚未公布，暂不能提交申诉' });
      const content = (body.content || '').trim();
      if (!content) return sendJson(res, 400, { error: '请填写申诉内容' });
      if (content.length > 500) return sendJson(res, 400, { error: '申诉内容不能超过500字' });
      db.data.appeals.push({
        id: nextId(db.data.appeals), candidate_id: c.id, content,
        status: '待处理', reply: '', created_at: new Date().toISOString(),
      });
      db.save();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: '接口不存在' });
  }

  return sendJson(res, 403, { error: '无权访问' });
}

// ---------- 静态文件 ----------
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('页面不存在');
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    sendJson(res, 500, { error: '服务器内部错误：' + e.message });
  }
});

server.listen(PORT, () => {
  console.log(`公务员面试打分系统已启动：http://localhost:${PORT}`);
  console.log('演示账号 → 考官: E101/123456  考务: admin/admin123  考生: 2026001/李文博');
});
