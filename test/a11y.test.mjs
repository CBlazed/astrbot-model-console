import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const PAGE_BG = '#f6f7fb';
const CARD_BG = '#ffffff';
const MIN_CONTRAST = 4.5;

function parseHex(hex) {
  const value = String(hex).trim().replace(/^#/, '');
  assert.match(value, /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, `无法解析颜色 ${hex}`);
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function linear(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function rule(name) {
  const match = css.match(new RegExp(`\\${name}\\{([^}]*)\\}`));
  assert.ok(match, `CSS 中找不到规则 ${name}`);
  return match[1];
}

function colorOf(declarations, where) {
  const match = declarations.match(/color\s*:\s*(#[0-9a-f]{3,6})\b/i);
  assert.ok(match, `${where} 缺少 hex 颜色值`);
  return match[1];
}

function sizeOf(declarations, where) {
  const match = declarations.match(/font-size\s*:\s*([0-9.]+)px/i);
  assert.ok(match, `${where} 缺少像素字号`);
  return Number(match[1]);
}

const mutedColor = css.match(/--muted\s*:\s*(#[0-9a-f]{3,6})\b/i)?.[1];
const eyebrowColor = colorOf(rule('.eyebrow'), '.eyebrow');
const railLabelColor = colorOf(rule('.rail-label'), '.rail-label');

test('styles.css 中不再存在 8px/9px/10px 字号', () => {
  const offenders = [...css.matchAll(/font-size\s*:\s*(0?[89]|10)px\b/gi)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `发现过小字号：${offenders.join(', ')}`);
});

test('承载信息的路径文字不小于 11px', () => {
  assert.ok(sizeOf(rule('.path'), '.path') >= 11, '.path 字号必须 >= 11px');
});

test('--muted 在页面底色上对比度 >= 4.5:1', () => {
  assert.ok(mutedColor, 'CSS 中缺少 --muted');
  const ratio = contrastRatio(mutedColor, PAGE_BG);
  assert.ok(ratio >= MIN_CONTRAST, `--muted ${mutedColor} 在 ${PAGE_BG} 上仅 ${ratio.toFixed(2)}:1`);
});

test('.eyebrow 文字对比度 >= 4.5:1', () => {
  const ratio = contrastRatio(eyebrowColor, PAGE_BG);
  assert.ok(ratio >= MIN_CONTRAST, `.eyebrow ${eyebrowColor} 在 ${PAGE_BG} 上仅 ${ratio.toFixed(2)}:1`);
});

test('.rail-label 在白色侧栏上对比度 >= 4.5:1', () => {
  const ratio = contrastRatio(railLabelColor, CARD_BG);
  assert.ok(ratio >= MIN_CONTRAST, `.rail-label ${railLabelColor} 在 ${CARD_BG} 上仅 ${ratio.toFixed(2)}:1`);
});

test('搜索框 placeholder 在白底上对比度 >= 4.5:1', () => {
  const declarations = rule('.search input::placeholder');
  const raw = declarations.match(/color\s*:\s*(var\(--muted\)|#[0-9a-f]{3,6})/i)?.[1];
  assert.ok(raw, '.search input::placeholder 缺少颜色声明');
  const color = raw.startsWith('var(') ? mutedColor : raw;
  assert.ok(color, '无法解析 placeholder 颜色');
  const ratio = contrastRatio(color, CARD_BG);
  assert.ok(ratio >= MIN_CONTRAST, `placeholder ${color} 在白底上仅 ${ratio.toFixed(2)}:1`);
});

test('窄屏下侧栏每个导航链接都有非空 aria-label', () => {
  const nav = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  assert.ok(nav, 'index.html 缺少 nav');
  const links = [...nav[1].matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((m) => m[0]);
  assert.ok(links.length >= 4, `导航链接数量异常：${links.length}`);
  for (const link of links) {
    const openTag = link.match(/<a\b[^>]*>/i)[0];
    const label = openTag.match(/\baria-label\s*=\s*"([^"]*)"/i)?.[1]?.trim();
    assert.ok(label, `导航链接缺少非空 aria-label：${openTag}`);
    assert.match(link, /<span>[^<]+<\/span>/i, `导航链接应保留非空文字 span：${link}`);
  }
});

test('存在可聚焦的 skip link 且 main 可被定位', () => {
  assert.match(html, /<a\b[^>]*\bclass="[^"]*\bskip-link\b[^"]*"[^>]*\bhref="#main"/i, '缺少 skip link');
  assert.match(html, /<main\b[^>]*\bid="main"[^>]*\btabindex="-1"/i, 'main 需要 id="main" 且 tabindex="-1"');
});

test('提供 prefers-reduced-motion 降级', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/i, '缺少 prefers-reduced-motion 媒体查询');
});

test('页面不包含内联脚本或内联事件处理器（CSP）', () => {
  assert.equal(/<script\b(?![^>]*\bsrc\s*=)/i.test(html), false, '发现内联 <script>');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  assert.ok(scripts.length > 0, '页面应通过外部 script 加载脚本');
  for (const [, attrs] of scripts) assert.match(attrs, /\bsrc\s*=/i, 'script 必须使用 src 外链');
  assert.equal(/\bon[a-z]+\s*=/i.test(html), false, '发现内联事件属性（如 onclick）');
});

test('向导、冲突、备份与恢复控件都有可访问名或说明', () => {
  assert.match(html, /<section\b[^>]*id="wizard"[^>]*aria-label="首启向导"/, '向导区域缺少 aria-label');
  assert.match(html, /<section\b[^>]*id="conflict"[^>]*aria-label="配置冲突"/, '冲突区域缺少 aria-label');
  assert.match(html, /id="backup-keep"[^>]*aria-label="保留份数"/, '保留份数输入缺少 aria-label');
  assert.match(html, /id="restore-kind"[^>]*aria-label=/, '恢复资源类型缺少 aria-label');
  assert.match(html, /id="restore-resource"[^>]*aria-label=/, '恢复资源缺少 aria-label');
  assert.match(html, /id="routing-notice"[^>]*role="status"/, '路由提示缺少 role="status"');
  assert.match(html, /<caption class="sr-only">/, '数据表缺少说明 caption');
});

test('设备选择器与远程设备管理控件都有可访问名', () => {
  assert.match(html, /<select\b[^>]*id="device-select"[^>]*aria-label="选择设备"/, '设备选择器缺少 aria-label');
  assert.match(html, /<select\b[^>]*id="device-select"[^>]*>/, '设备选择器应为原生 select');
  assert.match(html, /id="device-name"[^>]*aria-label="设备名称"/, '设备名称输入缺少 aria-label');
  assert.match(html, /id="device-url"[^>]*aria-label="设备地址 baseUrl"/, '设备地址输入缺少 aria-label');
  assert.match(html, /id="device-key"[^>]*type="password"[^>]*aria-label="设备 OpenAPI Key"/, 'OpenAPI Key 必须是 password 且有 aria-label');
  assert.match(html, /id="device-key"[^>]*autocomplete="new-password"/, '凭据输入应阻止浏览器回显');
  assert.match(html, /id="remote-notice"[^>]*role="status"/, '远程只读提示缺少 role="status"');
  assert.match(html, /id="device-body"[^>]*>/, '设备表应有 tbody');
});

test('SSH/Agent 表单扩展、诊断导出与 RISK 展示都可访问', () => {
  assert.match(html, /<select\b[^>]*id="device-kind"[^>]*aria-label="设备类型"/, '设备类型选择器缺少 aria-label');
  assert.match(html, /id="device-ssh-host"[^>]*aria-label="SSH 主机"/, 'SSH 主机缺少 aria-label');
  assert.match(html, /id="device-ssh-port"[^>]*aria-label="SSH 端口"/, 'SSH 端口缺少 aria-label');
  assert.match(html, /id="device-ssh-user"[^>]*aria-label="SSH 用户"/, 'SSH 用户缺少 aria-label');
  assert.match(html, /id="device-ssh-key"[^>]*aria-label="SSH 私钥路径"/, 'SSH 私钥路径缺少 aria-label');
  assert.match(html, /id="device-ssh-data"[^>]*aria-label="远端 AstrBot data 目录"/, '远端数据目录缺少 aria-label');
  assert.match(html, /id="device-pairing"[^>]*type="password"[^>]*aria-label="Agent 配对码"/, '配对码必须是 password 且有 aria-label');
  assert.match(html, /id="device-pairing"[^>]*autocomplete="new-password"/, '配对码输入应阻止浏览器回显');
  assert.match(html, /id="diagnostics-export"[^>]*class="button"/, '缺少导出诊断按钮');
  assert.match(html, /id="backup-warnings"[^>]*aria-label="备份警告"/, '备份警告列表缺少 aria-label');
  assert.match(html, /id="config-version"[^>]*>配置版本/, '缺少“配置版本”展示');
});

test('“允许远程写入”勾选有可访问名且属于 agent 表单', () => {
  assert.match(html, /id="device-allow-write"[^>]*type="checkbox"[^>]*aria-label="允许远程写入"/, '允许远程写入必须是带 aria-label 的 checkbox');
  assert.match(html, /id="device-allow-write-field"[^>]*hidden/, '允许远程写入默认隐藏（仅 agent 显示）');
  assert.match(html, /id="backup-actions"[^>]*>/, '备份保留/清理操作容器缺少 id');
});
