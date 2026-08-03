#!/usr/bin/env node
// TunnelAdmin 开发会话 token 用量统计 + README 更新
// 用法: node scripts/update-usage.cjs   （每次 git 提交前运行）
// 扫描 ~/.omp/agent/sessions/-sources-tunneladmin/*.jsonl（每个文件 = 一个会话），
// 更新 README.md 与 readme_en.md 中 <!-- usage --> 与 <!-- /usage --> 之间的表格。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionDir = path.join(os.homedir(), '.omp', 'agent', 'sessions', '-sources-tunneladmin');
const root = path.join(__dirname, '..');
const ZH = path.join(root, 'README.md');
const EN = path.join(root, 'readme_en.md');

if (!fs.existsSync(sessionDir)) {
  console.error(`未找到会话目录: ${sessionDir}`);
  process.exit(1);
}

// ---- 统计 ----
const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl')).sort();
const sessions = [];
for (const f of files) {
  let input = 0, output = 0, cache = 0, cost = 0, first = null, last = null;
  const lines = fs.readFileSync(path.join(sessionDir, f), 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const usage = ev.message && ev.message.usage;
    if (!usage) continue;
    const ts = ev.timestamp || '';
    if (ts) { if (!first) first = ts; last = ts; }
    input += usage.input || 0;
    output += usage.output || 0;
    cache += usage.cacheRead || 0;
    cost += (usage.cost && usage.cost.total) || 0;
  }
  if (input + output + cache === 0) continue; // 空会话
  const short = ts => ts.slice(5, 10);
  sessions.push({
    file: f,
    first: first ? short(first) : f.slice(0, 10).replace(/-/g, '').slice(2) + '-' + f.slice(4, 6) + '-' + f.slice(6, 8),
    last: last ? short(last) : '?',
    input, output, cache, cost,
  });
}
if (!sessions.length) { console.error('无可用会话数据'); process.exit(1); }

const fmt = n => n.toLocaleString('en-US');
const line = (no, s) => `| ${no} | ${fmt(s.input)} | ${fmt(s.output)} | ${fmt(s.cache)} |`;
const rows = sessions.map((s, i) => line(i + 1, s));
const tot = sessions.reduce((a, s) => ({
  input: a.input + s.input, output: a.output + s.output,
  cache: a.cache + s.cache, cost: a.cost + s.cost,
}), { input: 0, output: 0, cache: 0, cost: 0 });

const zhTable = [
  '| 会话 | 输入 | 输出 | 缓存读 |',
  '|---|---|---|---|',
  ...rows,
  `| **累计（${sessions.length} 个会话）** | **${fmt(tot.input)}** | **${fmt(tot.output)}** | **${fmt(tot.cache)}** |`,
].join('\n');

const enTable = [
  '| Session | Input | Output | Cache read |',
  '|---|---|---|---|',
  ...rows,
  `| **Total (${sessions.length} ${sessions.length > 1 ? 'sessions' : 'session'})** | **${fmt(tot.input)}** | **${fmt(tot.output)}** | **${fmt(tot.cache)}** |`,
].join('\n');

// ---- 更新文件 ----
function replaceTable(file, table) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /<!-- usage -->[\s\S]*?<!-- \/usage -->/;
  if (!re.test(src)) {
    console.error(`未找到 usage 标记块: ${file}`);
    process.exit(1);
  }
  fs.writeFileSync(file, src.replace(re, `<!-- usage -->\n${table}\n<!-- /usage -->`));
  console.log(`已更新: ${path.relative(root, file)}`);
}
replaceTable(ZH, zhTable);
replaceTable(EN, enTable);

console.log(`\n会话数: ${sessions.length}`);
console.log(`输入: ${fmt(tot.input)}  输出: ${fmt(tot.output)}  缓存读: ${fmt(tot.cache)}  成本: $${tot.cost.toFixed(2)}`);
