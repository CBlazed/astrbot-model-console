#!/usr/bin/env node
/**
 * 发布说明生成器（零依赖）。
 *
 * 从仓库根目录的 CHANGELOG.md 里提取「版本区间」的条目，供 release 工作流生成 GitHub Release 正文。
 * 区间语义：(since, version] —— since 通常取上一个 git tag 的版本号；不传 --since 表示取到当前版本为止的全部条目。
 *
 * 用法：
 *   node scripts/release-notes.mjs --version 0.2.1 --since 0.1.3 --out RELEASE_NOTES.md
 *   node scripts/release-notes.mjs --version 0.2.1            # 打印到 stdout
 *   node scripts/release-notes.mjs --help
 *
 * 说明：
 * - 只解析形如 `## 0.2.1 — 2026-10-30` 或 `## v0.2.1` 的二级标题；其它标题一律忽略。
 * - 找不到任何匹配条目时**不静默通过**：返回非 0 退出码并在 stderr 说明原因（避免发出空 Release）。
 * - 输出为纯 Markdown，不做任何网络访问，不读取密钥。
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const CHANGELOG = join(REPO_ROOT, 'CHANGELOG.md');

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function printHelp() {
  process.stdout.write([
    '提取 CHANGELOG.md 的版本区间，生成 Release 正文。',
    '',
    '用法：node scripts/release-notes.mjs --version <x.y.z> [--since <x.y.z>] [--out <file>]',
    '',
    '  --version  必填，本次发布的版本号（与 package.json 的 version 一致）',
    '  --since    可选，只输出版本号大于它的条目（通常是上一个 tag）',
    '  --out      可选，写入文件；缺省打印到 stdout',
    '  --help     显示本帮助',
    '',
    '退出码：0 成功；1 参数错误或 CHANGELOG 里找不到对应条目。',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {version: null, since: null, out: null};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return {help: true};
    if (arg === '--version' || arg === '--since' || arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw Error(`${arg} 需要一个参数。`);
      index += 1;
      if (arg === '--version') options.version = value;
      else if (arg === '--since') options.since = value;
      else options.out = value;
      continue;
    }
    if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length);
    else if (arg.startsWith('--since=')) options.since = arg.slice('--since='.length);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else throw Error(`未知参数：${arg}（支持 --version、--since、--out、--help）`);
  }
  return options;
}

function parseVersion(text, label) {
  const match = SEMVER.exec(String(text ?? '').trim());
  if (!match) throw Error(`${label} 不是合法版本号：${text}（示例：0.2.1）`);
  return {raw: `${match[1]}.${match[2]}.${match[3]}`, parts: [Number(match[1]), Number(match[2]), Number(match[3])]};
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  return 0;
}

/** 把 CHANGELOG 拆成 {version, heading, body} 列表，保持文件里出现的顺序。 */
function parseChangelog(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const versionMatch = /^v?(\d+\.\d+\.\d+)/.exec(heading[1]);
      if (versionMatch) {
        if (current) sections.push(current);
        current = {version: parseVersion(versionMatch[1], 'CHANGELOG 标题').raw, title: heading[1], body: []};
        continue;
      }
      if (current) sections.push(current);
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections.map(section => ({...section, body: section.body.join('\n').trim()}));
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(`参数错误：${error.message}\n用 --help 查看用法。`);
  }
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.version) fail('缺少 --version（本次发布版本号）。用 --help 查看用法。');

  const version = parseVersion(options.version, '--version');
  const since = options.since ? parseVersion(options.since, '--since') : null;

  let changelogText;
  try {
    changelogText = readFileSync(CHANGELOG, 'utf8');
  } catch {
    fail(`读不到 CHANGELOG.md：${CHANGELOG}`);
  }

  const sections = parseChangelog(changelogText);
  const selected = sections
    .filter(section => compareVersions(parseVersion(section.version, 'CHANGELOG 版本'), version) <= 0)
    .filter(section => !since || compareVersions(parseVersion(section.version, 'CHANGELOG 版本'), since) > 0)
    .sort((left, right) => compareVersions(parseVersion(right.version, 'CHANGELOG 版本'), parseVersion(left.version, 'CHANGELOG 版本')));

  if (selected.length === 0) {
    const range = since ? `${since.raw} 之后到 ${version.raw}` : version.raw;
    fail(`CHANGELOG.md 里没有 ${range} 的条目：拒绝生成空发布说明。请先补 CHANGELOG。`);
  }

  const headerRange = since ? `v${since.raw} → v${version.raw}` : `v${version.raw}`;
  const body = [
    `## 变更范围 ${headerRange}`,
    '',
    ...selected.map(section => [`## ${section.version}`, '', section.body, ''].join('\n')),
    '## 安装',
    '',
    '解压 zip 后双击 `start.cmd`（便携版，随包 node.exe，无需预装 Node.js）；升级=替换整个程序目录，用户数据留在 `state/`。',
    '逐文件 SHA-256 见包内 `SHA256SUMS.txt`，zip 的 SHA-256 见本页附带的 `.sha256.txt`。',
    '',
  ].join('\n');

  if (options.out) {
    writeFileSync(resolve(REPO_ROOT, options.out), body, 'utf8');
    process.stdout.write(`已写入 ${options.out}（${selected.length} 个版本条目）\n`);
    return;
  }
  process.stdout.write(body);
}

try {
  main();
} catch (error) {
  fail(`生成发布说明失败：${error.message}`);
}
