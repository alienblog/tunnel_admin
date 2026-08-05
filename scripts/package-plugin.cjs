#!/usr/bin/env node
/**
 * 打包插件为 .taplugin 安装包（VSCode vsix 模型的简化版）。
 *
 * 用法：node scripts/package-plugin.cjs <插件目录> [输出目录]
 *   - 插件目录必须含根 plugin.json
 *   - 输出默认 <插件目录> 的父目录，文件名 <id>-<version>.taplugin
 *   - 跳过 node_modules / .git / 临时文件
 */
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const [, , srcArg, outArg] = process.argv;
if (!srcArg) {
  console.error('用法: node scripts/package-plugin.cjs <插件目录> [输出目录]');
  process.exit(1);
}
const src = path.resolve(srcArg);
const manifestPath = path.join(src, 'plugin.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`错误: ${manifestPath} 不存在（插件根目录必须含 plugin.json）`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.id || !manifest.version) {
  console.error('错误: plugin.json 缺少 id 或 version');
  process.exit(1);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode', 'dist', '__MACOSX']);
const SKIP_EXT = new Set(['.log', '.tmp']);
const SKIP_FILES = new Set(['.DS_Store']);

const zip = new AdmZip();
function addDir(dir, prefix) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      addDir(abs, rel);
    } else if (!SKIP_FILES.has(name) && !SKIP_EXT.has(path.extname(name))) {
      zip.addFile(rel, fs.readFileSync(abs));
    }
  }
}
addDir(src, '');
if (zip.getEntry('plugin.json')) {
  const outDir = path.resolve(outArg ?? path.dirname(src));
  const out = path.join(outDir, `${manifest.id}-${manifest.version}.taplugin`);
  zip.writeZip(out);
  console.log(`已打包: ${out}（${manifest.id}@${manifest.version}）`);
} else {
  console.error('错误: 插件根目录缺少 plugin.json');
  process.exit(1);
}
