#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
公务员面试打分系统
- 考官：按 结构化题目/仪态表达/政策理解/应变能力 四维度打分
- 规则：去掉一个最高分、一个最低分后取平均（百分制）
- 考务：缺考、换组（考生/考官）、回避关系、成绩发布、申诉处理
- 考生：仅查看最终成绩 + 提交申诉
无第三方依赖，Python 3.8+
"""
import json
import os
import sqlite3
import hashlib
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data.db')
STATIC_DIR = os.path.join(BASE_DIR, 'static')
PORT = int(os.environ.get('PORT', '8000'))

# 评分维度（权重满分，合计100）
DIMS = [
    {'key': 'structured',   'name': '结构化题目', 'max': 40},
    {'key': 'demeanor',     'name': '仪态表达',   'max': 20},
    {'key': 'policy',       'name': '政策理解',   'max': 20},
    {'key': 'adaptability', 'name': '应变能力',   'max': 20},
]
DIM_KEYS = [d['key'] for d in DIMS]
DEFAULT_PWD = '123456'

_lock = threading.Lock()
_local = threading.local()


def now():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def sha256(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def db():
    if not hasattr(_local, 'conn'):
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        _local.conn = conn
    return _local.conn


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


# ---------------------------------------------------------------- 数据库初始化
SCHEMA = """
CREATE TABLE IF NOT EXISTS groups(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('staff','examiner','candidate')),
    group_id INTEGER REFERENCES groups(id),
    pwd_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_id INTEGER NOT NULL REFERENCES groups(id),
    seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','absent')),
    final_score REAL,
    published INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scores(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    examiner_id TEXT NOT NULL REFERENCES users(id),
    structured INTEGER NOT NULL,
    demeanor INTEGER NOT NULL,
    policy INTEGER NOT NULL,
    adaptability INTEGER NOT NULL,
    total INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(candidate_id, examiner_id)
);
CREATE TABLE IF NOT EXISTS recusals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    examiner_id TEXT NOT NULL REFERENCES users(id),
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(examiner_id, candidate_id)
);
CREATE TABLE IF NOT EXISTS appeals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','replied')),
    reply TEXT,
    created_at TEXT NOT NULL,
    replied_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
);
"""


def init_db():
    fresh = not os.path.exists(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    if fresh:
        seed()


def seed():
    """初始化演示数据：3个面试组、15名考官、15名考生，含已发布/未发布/缺考/回避/申诉等场景"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    pwd = sha256(DEFAULT_PWD)

    groups = ['第一面试组', '第二面试组', '第三面试组']
    c.executemany('INSERT INTO groups(id,name) VALUES(?,?)',
                  [(i + 1, n) for i, n in enumerate(groups)])

    c.execute("INSERT INTO users(id,name,role,group_id,pwd_hash) VALUES('u001','考务主管','staff',NULL,?)", (pwd,))

    examiner_names = [
        '王建国', '李淑芬', '张志远', '刘德海', '陈雅琴',
        '赵文博', '孙丽华', '周国强', '吴晓梅', '郑海涛',
        '冯建华', '褚慧敏', '卫国立', '蒋春燕', '沈志鹏',
    ]
    for i, name in enumerate(examiner_names):
        gid = i // 5 + 1
        c.execute('INSERT INTO users(id,name,role,group_id,pwd_hash) VALUES(?,?,?,?,?)',
                  ('eg%03d' % (i + 1), name, 'examiner', gid, pwd))

    cand_names = [
        '林一鸣', '黄思远', '徐若曦', '高文轩', '唐婉清',
        '许子墨', '韩雪宁', '邓嘉树', '曹睿哲', '彭静好',
        '萧远航', '田梦琪', '董博文', '袁佩珊', '潘正阳',
    ]
    for i, name in enumerate(cand_names):
        gid = i // 5 + 1
        seq = i % 5 + 1
        cid = 'ks%03d' % (i + 1)
        c.execute('INSERT INTO candidates(id,name,group_id,seq) VALUES(?,?,?,?)',
                  (cid, name, gid, seq))
        c.execute('INSERT INTO users(id,name,role,group_id,pwd_hash) VALUES(?,?,?,?,?)',
                  (cid, name, 'candidate', gid, pwd))

    def sc(examiner, cand, vals):
        c.execute(
            'INSERT INTO scores(candidate_id,examiner_id,structured,demeanor,policy,adaptability,total,updated_at)'
            ' VALUES(?,?,?,?,?,?,?,?)',
            (cand, examiner, *vals, sum(vals), now()))

    # 第一组
    sc('eg001', 'ks001', (33, 17, 17, 16))  # 83
    sc('eg002', 'ks001', (35, 18, 18, 17))  # 88 最高
    sc('eg003', 'ks001', (30, 15, 16, 15))  # 76 最低
    sc('eg004', 'ks001', (34, 17, 17, 18))  # 86
    sc('eg005', 'ks001', (32, 16, 17, 16))  # 81 -> 平均 83.33
    c.execute("UPDATE candidates SET final_score=83.33,published=1 WHERE id='ks001'")

    sc('eg001', 'ks002', (30, 16, 16, 15))  # 77
    sc('eg002', 'ks002', (32, 17, 17, 16))  # 82 高
    sc('eg003', 'ks002', (28, 14, 15, 14))  # 71 低 -> 77.0（未发布）

    # ks003 缺考
    c.execute("UPDATE candidates SET status='absent' WHERE id='ks003'")

    # ks004 存在回避（eg001），4名有效考官
    c.execute("INSERT INTO recusals(examiner_id,candidate_id,reason,created_at) VALUES('eg001','ks004','配偶亲属关系',?)", (now(),))
    sc('eg002', 'ks004', (31, 16, 17, 16))  # 80
    sc('eg003', 'ks004', (29, 15, 15, 14))  # 73 低
    sc('eg004', 'ks004', (33, 17, 18, 17))  # 85 高
    sc('eg005', 'ks004', (30, 16, 16, 15))  # 77 -> 78.5（未发布）

    # 第二组
    sc('eg006', 'ks006', (34, 17, 18, 17))  # 86
    sc('eg007', 'ks006', (36, 18, 19, 18))  # 91 高
    sc('eg008', 'ks006', (31, 16, 16, 15))  # 78 低
    sc('eg009', 'ks006', (33, 17, 17, 16))  # 83
    sc('eg010', 'ks006', (35, 18, 18, 17))  # 88 -> 85.67
    c.execute("UPDATE candidates SET final_score=85.67,published=1 WHERE id='ks006'")

    sc('eg006', 'ks007', (33, 17, 17, 16))  # 83
    sc('eg007', 'ks007', (30, 15, 16, 15))  # 76（评分未完成）

    c.execute("INSERT INTO recusals(examiner_id,candidate_id,reason,created_at) VALUES('eg006','ks009','考生为本人指导学生',?)", (now(),))

    # 第三组
    sc('eg011', 'ks011', (32, 16, 17, 16))  # 81
    sc('eg012', 'ks011', (35, 18, 18, 17))  # 88 高
    sc('eg013', 'ks011', (29, 15, 15, 14))  # 73 低
    sc('eg014', 'ks011', (33, 17, 17, 18))  # 85
    sc('eg015', 'ks011', (34, 17, 18, 17))  # 86 -> 84.0
    c.execute("UPDATE candidates SET final_score=84.0,published=1 WHERE id='ks011'")

    c.execute("UPDATE candidates SET status='absent' WHERE id='ks013'")

    sc('eg011', 'ks014', (31, 16, 16, 15))  # 78
    sc('eg012', 'ks014', (34, 17, 18, 17))  # 86 高
    sc('eg013', 'ks014', (30, 15, 16, 15))  # 76 低
    sc('eg014', 'ks014', (33, 17, 17, 16))  # 83 -> 80.5（未发布）

    # 申诉数据
    c.execute("INSERT INTO appeals(candidate_id,content,status,reply,created_at,replied_at)"
              " VALUES('ks006','本人对面试最终成绩存在疑问，感觉临场发挥较好，申请复核评分记录。',"
              "'replied','经复核：5名考官打分均有效，已按规则去掉最高分91、最低分78，计分流程规范，成绩无误。',?,?)",
              (now(), now()))
    c.execute("INSERT INTO appeals(candidate_id,content,status,created_at) VALUES('ks001','申请核对各维度评分记录，确认分数无误。','pending',?)", (now(),))

    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 业务逻辑
def compute_result(cand):
    """
    计算考生成绩：
    - 有效分 = 考生所在面试组的考官所打分数，且不存在回避关系
    - 去掉一个最高分、一个最低分后取算术平均（保留2位小数）
    """
    cid = cand['id']
    gid = cand['group_id']
    rows = db().execute(
        '''SELECT s.*, u.name AS examiner_name, u.group_id AS examiner_group
             FROM scores s JOIN users u ON u.id = s.examiner_id
            WHERE s.candidate_id = ?''', (cid,)).fetchall()
    rec_rows = db().execute(
        '''SELECT r.*, u.name AS examiner_name FROM recusals r
             JOIN users u ON u.id = r.examiner_id WHERE r.candidate_id = ?''', (cid,)).fetchall()
    rec_map = {r['examiner_id']: r for r in rec_rows}

    entries = []
    for r in rows:
        status = 'valid'
        if r['examiner_group'] != gid:
            status = 'out_of_panel'
        elif r['examiner_id'] in rec_map:
            status = 'recused'
        entries.append({
            'examiner_id': r['examiner_id'],
            'examiner_name': r['examiner_name'],
            'structured': r['structured'], 'demeanor': r['demeanor'],
            'policy': r['policy'], 'adaptability': r['adaptability'],
            'total': r['total'], 'updated_at': r['updated_at'],
            'status': status, 'dropped': False, 'drop_tag': None,
        })

    valid_idx = [i for i, e in enumerate(entries) if e['status'] == 'valid']
    totals = [entries[i]['total'] for i in valid_idx]
    drop_idx = set()
    final = None
    if len(totals) >= 3:
        i_hi = max(range(len(totals)), key=lambda i: totals[i])
        i_lo = min(range(len(totals)), key=lambda i: totals[i])
        if i_hi == i_lo:  # 全部同分，任选两个位置剔除
            i_lo = (i_hi + 1) % len(totals)
        entries[valid_idx[i_hi]]['dropped'] = True
        entries[valid_idx[i_hi]]['drop_tag'] = '最高分'
        entries[valid_idx[i_lo]]['dropped'] = True
        entries[valid_idx[i_lo]]['drop_tag'] = '最低分'
        drop_idx = {valid_idx[i_hi], valid_idx[i_lo]}
        used = [entries[i]['total'] for i in valid_idx if i not in drop_idx]
        final = round(sum(used) / len(used), 2)

    panel_size = db().execute(
        "SELECT COUNT(*) AS n FROM users WHERE role='examiner' AND group_id=?", (gid,)).fetchone()['n']
    recused_in_panel = sum(1 for r in rec_rows if r['examiner_id']
                           and db().execute("SELECT group_id FROM users WHERE id=?",
                                            (r['examiner_id'],)).fetchone()['group_id'] == gid)
    expected = panel_size - recused_in_panel

    return {
        'final': final,
        'counts': {
            'panel': panel_size,
            'recused': recused_in_panel,
            'expected': expected,
            'submitted': len(valid_idx),
            'valid': len(totals),
        },
        'entries': entries,
        'recusals': [{'examiner_id': r['examiner_id'], 'examiner_name': r['examiner_name'],
                      'reason': r['reason']} for r in rec_rows],
    }


def staff_overview():
    groups = [dict(g) for g in db().execute('SELECT * FROM groups ORDER BY id').fetchall()]
    examiners = [dict(u) for u in db().execute(
        "SELECT id,name,group_id FROM users WHERE role='examiner' ORDER BY id").fetchall()]
    cands = db().execute('SELECT * FROM candidates ORDER BY group_id,seq').fetchall()
    appeals = db().execute(
        '''SELECT a.*, c.name AS candidate_name FROM appeals a
             JOIN candidates c ON c.id=a.candidate_id ORDER BY a.id DESC''').fetchall()
    recs = db().execute('SELECT * FROM recusals ORDER BY id').fetchall()

    cand_out = []
    for c in cands:
        res = compute_result(c)
        pend = db().execute(
            "SELECT COUNT(*) n FROM appeals WHERE candidate_id=? AND status='pending'",
            (c['id'],)).fetchone()['n']
        d = dict(c)
        d['counts'] = res['counts']
        d['provisional'] = res['final']
        d['pending_appeals'] = pend
        cand_out.append(d)

    return {
        'groups': groups,
        'examiners': examiners,
        'candidates': cand_out,
        'recusals': [dict(r) for r in recs],
        'appeals': [dict(a) for a in appeals],
        'dims': DIMS,
    }


# ---------------------------------------------------------------- HTTP 处理
class Handler(BaseHTTPRequestHandler):
    server_version = 'GWMark/1.0'

    def log_message(self, fmt, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length', '0') or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            raise ApiError(400, '请求数据格式错误')

    def current_user(self):
        token = self.headers.get('X-Auth-Token', '')
        if not token:
            return None
        row = db().execute(
            '''SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                WHERE s.token=?''', (token,)).fetchone()
        return row

    def require(self, role=None):
        u = self.current_user()
        if not u:
            raise ApiError(401, '未登录或会话已过期')
        if role and u['role'] != role:
            raise ApiError(403, '无权限执行该操作')
        return u

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def _dispatch(self, method):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            if method == 'GET' and not path.startswith('/api/'):
                return self._static(path)
            route = (method, path)
            fn = ROUTES.get(route)
            if not fn:
                raise ApiError(404, '接口不存在')
            fn(self, qs)
        except ApiError as e:
            self._send({'ok': False, 'error': e.msg}, e.code)
        except Exception as e:
            self._send({'ok': False, 'error': '服务器错误: %s' % e}, 500)

    def _static(self, path):
        if path in ('/', '/index.html'):
            fpath = os.path.join(STATIC_DIR, 'index.html')
        elif path in ('/app.js', '/styles.css'):
            fpath = os.path.join(STATIC_DIR, path.lstrip('/'))
        else:
            self.send_error(404)
            return
        if not os.path.exists(fpath):
            self.send_error(404)
            return
        ctype = {'index.html': 'text/html; charset=utf-8',
                 'app.js': 'application/javascript; charset=utf-8',
                 'styles.css': 'text/css; charset=utf-8'}[os.path.basename(fpath)]
        with open(fpath, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


    # ------------------------------------------------------------ 公共接口
    def api_login(self, qs):
        b = self._body()
        uid = str(b.get('id', '')).strip()
        pwd = str(b.get('password', ''))
        if not uid or not pwd:
            raise ApiError(400, '请输入账号和密码')
        u = db().execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        if not u or u['pwd_hash'] != sha256(pwd):
            raise ApiError(401, '账号或密码错误')
        token = secrets.token_hex(16)
        db().execute('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)',
                     (token, u['id'], now()))
        db().commit()
        self._send({'ok': True, 'token': token,
                    'user': {'id': u['id'], 'name': u['name'],
                             'role': u['role'], 'group_id': u['group_id']}})

    def api_logout(self, qs):
        token = self.headers.get('X-Auth-Token', '')
        db().execute('DELETE FROM sessions WHERE token=?', (token,))
        db().commit()
        self._send({'ok': True})

    def api_me(self, qs):
        u = self.require()
        self._send({'ok': True, 'user': {'id': u['id'], 'name': u['name'],
                                         'role': u['role'], 'group_id': u['group_id']}})

    # ------------------------------------------------------------ 考官接口
    def api_examiner_candidates(self, qs):
        u = self.require('examiner')
        g = db().execute('SELECT * FROM groups WHERE id=?', (u['group_id'],)).fetchone()
        cands = db().execute(
            'SELECT * FROM candidates WHERE group_id=? ORDER BY seq', (u['group_id'],)).fetchall()
        out = []
        for c in cands:
            s = db().execute('SELECT * FROM scores WHERE candidate_id=? AND examiner_id=?',
                             (c['id'], u['id'])).fetchone()
            r = db().execute('SELECT * FROM recusals WHERE candidate_id=? AND examiner_id=?',
                             (c['id'], u['id'])).fetchone()
            out.append({
                'id': c['id'], 'seq': c['seq'], 'name': c['name'],
                'status': c['status'], 'published': bool(c['published']),
                'recused': bool(r), 'recusal_reason': r['reason'] if r else None,
                'score': dict(s) if s else None,
            })
        self._send({'ok': True, 'group': dict(g), 'dims': DIMS, 'candidates': out,
                    'examiner_name': u['name']})

    def api_examiner_score(self, qs):
        u = self.require('examiner')
        b = self._body()
        cid = b.get('candidate_id')
        c = db().execute('SELECT * FROM candidates WHERE id=?', (cid,)).fetchone()
        if not c:
            raise ApiError(404, '考生不存在')
        if c['group_id'] != u['group_id']:
            raise ApiError(403, '只能对本组考生评分')
        if c['status'] == 'absent':
            raise ApiError(400, '该考生已标记缺考，不能评分')
        if c['published']:
            raise ApiError(400, '成绩已发布，评分已锁定')
        if db().execute('SELECT 1 FROM recusals WHERE candidate_id=? AND examiner_id=?',
                        (cid, u['id'])).fetchone():
            raise ApiError(403, '存在回避关系，该考生须回避，不能评分')

        vals = {}
        for d in DIMS:
            try:
                v = int(b.get(d['key']))
            except (TypeError, ValueError):
                raise ApiError(400, '%s 评分必须为整数' % d['name'])
            if v < 0 or v > d['max']:
                raise ApiError(400, '%s 评分范围为 0~%d' % (d['name'], d['max']))
            vals[d['key']] = v
        total = sum(vals.values())
        with _lock:
            db().execute(
                '''INSERT INTO scores(candidate_id,examiner_id,structured,demeanor,policy,adaptability,total,updated_at)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(candidate_id,examiner_id) DO UPDATE SET
                     structured=excluded.structured, demeanor=excluded.demeanor,
                     policy=excluded.policy, adaptability=excluded.adaptability,
                     total=excluded.total, updated_at=excluded.updated_at''',
                (cid, u['id'], vals['structured'], vals['demeanor'],
                 vals['policy'], vals['adaptability'], total, now()))
            db().commit()
        self._send({'ok': True, 'total': total})

    # ------------------------------------------------------------ 考务接口
    def api_staff_overview(self, qs):
        self.require('staff')
        self._send({'ok': True, 'data': staff_overview()})

    def api_staff_result(self, qs):
        self.require('staff')
        cid = qs.get('cid', [''])[0]
        c = db().execute('SELECT * FROM candidates WHERE id=?', (cid,)).fetchone()
        if not c:
            raise ApiError(404, '考生不存在')
        g = db().execute('SELECT * FROM groups WHERE id=?', (c['group_id'],)).fetchone()
        res = compute_result(c)
        res['candidate'] = dict(c)
        res['group'] = dict(g)
        self._send({'ok': True, 'result': res})

    def api_staff_publish(self, qs):
        self.require('staff')
        b = self._body()
        c = db().execute('SELECT * FROM candidates WHERE id=?', (b.get('candidate_id'),)).fetchone()
        if not c:
            raise ApiError(404, '考生不存在')
        if c['status'] == 'absent':
            raise ApiError(400, '缺考考生无成绩，不能发布')
        res = compute_result(c)
        n = res['counts']
        if n['submitted'] < n['expected']:
            raise ApiError(400, '尚有考官未提交评分（已交 %d/%d），不能发布'
                           % (n['submitted'], n['expected']))
        if n['valid'] < 3:
            raise ApiError(400, '有效评分不足 3 份，无法执行去最高最低分规则')
        if res['final'] is None:
            raise ApiError(400, '成绩计算异常')
        with _lock:
            db().execute('UPDATE candidates SET final_score=?, published=1 WHERE id=?',
                         (res['final'], c['id']))
            db().commit()
        self._send({'ok': True, 'final_score': res['final']})

    def api_staff_unpublish(self, qs):
        self.require('staff')
        b = self._body()
        c = db().execute('SELECT * FROM candidates WHERE id=?', (b.get('candidate_id'),)).fetchone()
        if not c:
            raise ApiError(404, '考生不存在')
        with _lock:
            db().execute('UPDATE candidates SET published=0 WHERE id=?', (c['id'],))
            db().commit()
        self._send({'ok': True})

    def api_staff_absent(self, qs):
        self.require('staff')
        b = self._body()
        status = b.get('status')
        if status not in ('present', 'absent'):
            raise ApiError(400, '状态非法')
        c = db().execute('SELECT * FROM candidates WHERE id=?', (b.get('candidate_id'),)).fetchone()
        if not c:
            raise ApiError(404, '考生不存在')
        with _lock:
            if status == 'absent':
                db().execute('DELETE FROM scores WHERE candidate_id=?', (c['id'],))
                db().execute('UPDATE candidates SET status=?, final_score=NULL, published=0 WHERE id=?',
                             (status, c['id']))
            else:
                db().execute('UPDATE candidates SET status=? WHERE id=?', (status, c['id']))
            db().commit()
        self._send({'ok': True})

    def api_staff_move_candidate(self, qs):
        self.require('staff')
        b = self._body()
        c = db().execute('SELECT * FROM candidates WHERE id=?', (b.get('candidate_id'),)).fetchone()
        if not c:
            raise ApiError(404, '考生不存在')
        try:
            ng = int(b.get('group_id'))
        except (TypeError, ValueError):
            raise ApiError(400, '目标面试组非法')
        if not db().execute('SELECT 1 FROM groups WHERE id=?', (ng,)).fetchone():
            raise ApiError(400, '目标面试组不存在')
        seq = b.get('seq')
        with _lock:
            if seq is None or int(seq) <= 0:
                row = db().execute(
                    'SELECT COALESCE(MAX(seq),0)+1 AS n FROM candidates WHERE group_id=?', (ng,)).fetchone()
                seq = row['n']
            db().execute('DELETE FROM scores WHERE candidate_id=?', (c['id'],))
            db().execute('UPDATE candidates SET group_id=?, seq=?, final_score=NULL, published=0, status=? WHERE id=?',
                         (ng, int(seq), 'present', c['id']))
            db().execute("UPDATE users SET group_id=? WHERE id=?", (ng, c['id']))
            db().commit()
        self._send({'ok': True})

    def api_staff_move_examiner(self, qs):
        self.require('staff')
        b = self._body()
        e = db().execute("SELECT * FROM users WHERE id=? AND role='examiner'",
                         (b.get('examiner_id'),)).fetchone()
        if not e:
            raise ApiError(404, '考官不存在')
        try:
            ng = int(b.get('group_id'))
        except (TypeError, ValueError):
            raise ApiError(400, '目标面试组非法')
        if not db().execute('SELECT 1 FROM groups WHERE id=?', (ng,)).fetchone():
            raise ApiError(400, '目标面试组不存在')
        with _lock:
            # 换组后原组评分失效（已不属于原评分组），予以清除；回避记录保留备查
            db().execute(
                '''DELETE FROM scores WHERE examiner_id=? AND candidate_id IN
                   (SELECT id FROM candidates WHERE group_id!=?)''', (e['id'], ng))
            db().execute('UPDATE users SET group_id=? WHERE id=?', (ng, e['id']))
            db().commit()
        self._send({'ok': True})

    def api_staff_add_recusal(self, qs):
        self.require('staff')
        b = self._body()
        e = db().execute("SELECT * FROM users WHERE id=? AND role='examiner'",
                         (b.get('examiner_id'),)).fetchone()
        c = db().execute('SELECT * FROM candidates WHERE id=?', (b.get('candidate_id'),)).fetchone()
        reason = str(b.get('reason', '')).strip()
        if not e:
            raise ApiError(404, '考官不存在')
        if not c:
            raise ApiError(404, '考生不存在')
        if not reason:
            raise ApiError(400, '请填写回避事由')
        if db().execute('SELECT 1 FROM recusals WHERE examiner_id=? AND candidate_id=?',
                        (e['id'], c['id'])).fetchone():
            raise ApiError(400, '该回避关系已登记')
        with _lock:
            db().execute('INSERT INTO recusals(examiner_id,candidate_id,reason,created_at) VALUES(?,?,?,?)',
                         (e['id'], c['id'], reason, now()))
            # 已提交的评分按回避处理，予以作废
            db().execute('DELETE FROM scores WHERE examiner_id=? AND candidate_id=?',
                         (e['id'], c['id']))
            db().commit()
        self._send({'ok': True})

    def api_staff_del_recusal(self, qs):
        self.require('staff')
        b = self._body()
        with _lock:
            db().execute('DELETE FROM recusals WHERE id=?', (b.get('id'),))
            db().commit()
        self._send({'ok': True})

    def api_staff_add_candidate(self, qs):
        self.require('staff')
        b = self._body()
        name = str(b.get('name', '')).strip()
        try:
            gid = int(b.get('group_id'))
        except (TypeError, ValueError):
            raise ApiError(400, '请选择面试组')
        if not name:
            raise ApiError(400, '请填写考生姓名')
        if not db().execute('SELECT 1 FROM groups WHERE id=?', (gid,)).fetchone():
            raise ApiError(400, '面试组不存在')
        row = db().execute("SELECT COUNT(*) n FROM users WHERE role='candidate'").fetchone()
        num = row['n'] + 1
        cid = 'ks%03d' % num
        while db().execute('SELECT 1 FROM users WHERE id=?', (cid,)).fetchone():
            num += 1
            cid = 'ks%03d' % num
        seq = db().execute('SELECT COALESCE(MAX(seq),0)+1 n FROM candidates WHERE group_id=?',
                           (gid,)).fetchone()['n']
        with _lock:
            db().execute('INSERT INTO candidates(id,name,group_id,seq) VALUES(?,?,?,?)',
                         (cid, name, gid, seq))
            db().execute('INSERT INTO users(id,name,role,group_id,pwd_hash) VALUES(?,?,?,?,?)',
                         (cid, name, 'candidate', gid, sha256(DEFAULT_PWD)))
            db().commit()
        self._send({'ok': True, 'id': cid})

    def api_staff_reply_appeal(self, qs):
        self.require('staff')
        b = self._body()
        reply = str(b.get('reply', '')).strip()
        if not reply:
            raise ApiError(400, '请填写答复内容')
        a = db().execute('SELECT * FROM appeals WHERE id=?', (b.get('id'),)).fetchone()
        if not a:
            raise ApiError(404, '申诉不存在')
        with _lock:
            db().execute("UPDATE appeals SET status='replied', reply=?, replied_at=? WHERE id=?",
                         (reply, now(), a['id']))
            db().commit()
        self._send({'ok': True})

    # ------------------------------------------------------------ 考生接口
    def api_candidate_score(self, qs):
        u = self.require('candidate')
        c = db().execute('SELECT * FROM candidates WHERE id=?', (u['id'],)).fetchone()
        g = db().execute('SELECT * FROM groups WHERE id=?', (c['group_id'],)).fetchone()
        self._send({'ok': True, 'info': {
            'name': c['name'], 'group_name': g['name'], 'seq': c['seq'],
            'status': c['status'], 'published': bool(c['published']),
            'final_score': c['final_score'],
        }})

    def api_candidate_appeals(self, qs):
        u = self.require('candidate')
        rows = db().execute('SELECT * FROM appeals WHERE candidate_id=? ORDER BY id DESC',
                            (u['id'],)).fetchall()
        self._send({'ok': True, 'appeals': [dict(r) for r in rows]})

    def api_candidate_appeal(self, qs):
        u = self.require('candidate')
        b = self._body()
        content = str(b.get('content', '')).strip()
        if len(content) < 5:
            raise ApiError(400, '申诉内容不少于5个字')
        c = db().execute('SELECT * FROM candidates WHERE id=?', (u['id'],)).fetchone()
        if c['status'] == 'absent':
            raise ApiError(400, '缺考考生无成绩，不能提交申诉')
        if not c['published']:
            raise ApiError(400, '成绩尚未公布，暂不能申诉')
        pend = db().execute("SELECT COUNT(*) n FROM appeals WHERE candidate_id=? AND status='pending'",
                            (u['id'],)).fetchone()['n']
        if pend:
            raise ApiError(400, '您已有一条待处理申诉，请等待答复')
        with _lock:
            db().execute('INSERT INTO appeals(candidate_id,content,created_at) VALUES(?,?,?)',
                         (u['id'], content, now()))
            db().commit()
        self._send({'ok': True})


ROUTES = {
    ('POST', '/api/login'): Handler.api_login,
    ('POST', '/api/logout'): Handler.api_logout,
    ('GET', '/api/me'): Handler.api_me,

    ('GET', '/api/examiner/candidates'): Handler.api_examiner_candidates,
    ('POST', '/api/examiner/score'): Handler.api_examiner_score,

    ('GET', '/api/staff/overview'): Handler.api_staff_overview,
    ('GET', '/api/staff/result'): Handler.api_staff_result,
    ('POST', '/api/staff/publish'): Handler.api_staff_publish,
    ('POST', '/api/staff/unpublish'): Handler.api_staff_unpublish,
    ('POST', '/api/staff/absent'): Handler.api_staff_absent,
    ('POST', '/api/staff/move-candidate'): Handler.api_staff_move_candidate,
    ('POST', '/api/staff/move-examiner'): Handler.api_staff_move_examiner,
    ('POST', '/api/staff/recusal'): Handler.api_staff_add_recusal,
    ('POST', '/api/staff/recusal/remove'): Handler.api_staff_del_recusal,
    ('POST', '/api/staff/candidate'): Handler.api_staff_add_candidate,
    ('POST', '/api/staff/reply-appeal'): Handler.api_staff_reply_appeal,

    ('GET', '/api/candidate/score'): Handler.api_candidate_score,
    ('GET', '/api/candidate/appeals'): Handler.api_candidate_appeals,
    ('POST', '/api/candidate/appeal'): Handler.api_candidate_appeal,
}


def main():
    init_db()
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print('公务员面试打分系统已启动: http://localhost:%d' % PORT)
    srv.serve_forever()


if __name__ == '__main__':
    main()
