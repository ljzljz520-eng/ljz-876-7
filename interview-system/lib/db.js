'use strict';
// JSON 文件持久化数据层（含演示种子数据）
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// 评分维度及权重
const DIMENSIONS = [
  { key: 'structured', label: '结构化题目', weight: 0.4 },
  { key: 'demeanor', label: '仪态表达', weight: 0.2 },
  { key: 'policy', label: '政策理解', weight: 0.2 },
  { key: 'adaptability', label: '应变能力', weight: 0.2 },
];

// 单个考官总分 = 各维度加权求和（满分100）
function calcTotal(s) {
  const t = s.structured * 0.4 + s.demeanor * 0.2 + s.policy * 0.2 + s.adaptability * 0.2;
  return Math.round(t * 100) / 100;
}

function seed() {
  const groups = [
    { id: 1, name: '第一面试组', position: '综合管理岗' },
    { id: 2, name: '第二面试组', position: '行政执法岗' },
    { id: 3, name: '第三面试组', position: '专业技术岗' },
  ];

  const examinerNames = [
    ['王建国', '李秀兰', '张明德', '陈国华', '刘志强'],
    ['赵文斌', '孙丽华', '周永康', '吴桂芳', '郑海涛'],
    ['冯立新', '蒋素芬', '沈国栋', '韩雪梅', '曹永刚'],
  ];
  const examiners = [];
  let eid = 1;
  examinerNames.forEach((names, gi) => {
    names.forEach((name, i) => {
      examiners.push({ id: eid++, code: `E${gi + 1}0${i + 1}`, name, group_id: gi + 1, password: '123456' });
    });
  });

  const candidateNames = [
    ['李文博', '王雅静', '张浩然', '刘思雨', '陈志强', '杨梦琪'],
    ['赵子豪', '孙晓燕', '周天宇', '吴丽娜', '郑凯文', '冯婷婷'],
    ['蒋浩然', '沈静怡', '韩志强', '曹雪晴', '彭万里', '董雅琴'],
  ];
  const candidates = [];
  let cid = 1;
  candidateNames.forEach((names, gi) => {
    names.forEach((name, i) => {
      candidates.push({
        id: cid,
        exam_number: `2026${String(cid).padStart(3, '0')}`,
        name,
        position: groups[gi].position,
        group_id: gi + 1,
        status: '待面试', // 待面试 / 已面试 / 缺考
        interview_order: i + 1,
      });
      cid++;
    });
  });

  // 预置演示评分：第一组 李文博 / 王雅静 / 张浩然（张浩然的 E103 考官因回避不评分）
  const presetScores = {
    1: { 1: [88, 85, 90, 86], 2: [85, 88, 86, 84], 3: [90, 86, 88, 88], 4: [82, 84, 85, 83], 5: [86, 87, 87, 85] },
    2: { 1: [90, 88, 89, 91], 2: [88, 90, 87, 89], 3: [91, 89, 90, 90], 4: [87, 88, 88, 88], 5: [89, 89, 88, 90] },
    3: { 1: [78, 80, 82, 79], 2: [80, 79, 81, 80], 4: [76, 78, 79, 77], 5: [79, 81, 80, 78] },
  };
  const scores = [];
  let sid = 1;
  Object.keys(presetScores).forEach((candId) => {
    Object.keys(presetScores[candId]).forEach((exId) => {
      const [structured, demeanor, policy, adaptability] = presetScores[candId][exId];
      const s = { structured, demeanor, policy, adaptability };
      scores.push({
        id: sid++,
        candidate_id: Number(candId),
        examiner_id: Number(exId),
        ...s,
        total: calcTotal(s),
        submitted_at: new Date().toISOString(),
      });
    });
  });
  candidates[0].status = '已面试';
  candidates[1].status = '已面试';
  candidates[2].status = '已面试';

  // 预置回避关系：考官张明德(E103) 与考生张浩然(2026003) 系亲属关系
  const recusals = [
    { id: 1, examiner_id: 3, candidate_id: 3, reason: '考官与考生系叔侄关系，主动申请回避' },
  ];

  return {
    groups,
    examiners,
    candidates,
    scores,
    recusals,
    appeals: [],
    staff: [{ id: 1, code: 'admin', name: '考务管理员', password: 'admin123' }],
    settings: { resultsPublished: false },
  };
}

let data;
if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    data = seed();
  }
} else {
  data = seed();
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 首次启动写入种子数据
if (!fs.existsSync(DATA_FILE)) save();

module.exports = { data, save, DIMENSIONS, calcTotal };
