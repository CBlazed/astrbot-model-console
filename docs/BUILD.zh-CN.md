# 构建与分发（便携包 + 安装器）

本文档说明如何把 Model Console 打成可直接双击运行的 Windows 便携包、如何校验、以及如何用 Inno Setup
生成 per-user 安装器。构建脚本零第三方依赖，不需要 `npm install`。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 操作系统 | Windows x64（打包脚本会复制 `node.exe` 并生成 `.cmd`，因此仅支持 Windows） |
| Node.js | 与本机 `node.exe` 同版本即可（当前开发机 v24.22.1；`package.json` 要求 >=24.22） |
| 安装器（可选） | Inno Setup 6（默认安装到 `C:\Program Files (x86)\Inno Setup 6`） |

构建脚本使用**当前运行它的 Node**（`process.execPath`）作为随包 `node.exe`，所以请用准备分发的那个
Node 版本执行构建，例如：

```powershell
cd 'model-console'
node --version
node scripts/build-package.mjs
```

## 2. 构建便携包

```powershell
# 默认输出到 dist\AstrBotModelConsole\
node scripts/build-package.mjs

# 同时生成 zip（调用 PowerShell Compress-Archive，可见窗口，不隐藏）
node scripts/build-package.mjs --zip

# 输出到其他目录（zip 也落在该目录）
node scripts/build-package.mjs --out D:\build\model-console --zip

# 查看帮助
node scripts/build-package.mjs --help
```

构建可重复执行：脚本先清理 `<out>\AstrBotModelConsole\` 再重新复制，不会把旧文件留在包里。

### 产物结构

```
dist\AstrBotModelConsole\
├─ node.exe                 随包 Node（来自构建机的 process.execPath）
├─ LICENSE.node.txt         Node 许可证（随 Node 分发要求；找不到时会告警）
├─ start.cmd                推荐入口：用相对路径的 node.exe 启动，只读模式
├─ start-edit.cmd           编辑模式入口（--enable-writes，仍需在浏览器里预览并 Apply）
├─ start-console.cmd        开发脚本（依赖 PATH 里的 node，包内同样保留）
├─ start-console-edit.cmd
├─ package.json
├─ README.md
├─ SHA256SUMS.txt           逐文件 sha256 校验清单
├─ src\                     后端源码（*.mjs）
├─ public\                  UI 静态资源
└─ docs\
   ├─ HANDOVER.zh-CN.md     接手指南
   ├─ BUILD.zh-CN.md        本文档
   └─ DESIGN-multi-device-2026-10-29.zh-CN.md（存在时）
```

`--zip` 会额外生成：

```
dist\AstrBotModelConsole-<version>-win-<arch>.zip     # 例如 0.1.0-win-x64
```

zip 内顶层就是 `AstrBotModelConsole\` 目录，解压后双击 `start.cmd` 即可运行；首次启动会尝试自动发现
AstrBot data 目录，失败时按提示设置 `ASTRBOT_DATA`（也可用 `MODEL_CONSOLE_STATE` 指定状态目录）。

安装器脚本 `installer\model-console.iss` 由构建脚本自动重新生成（内容不变时不会重写），要调整安装器
行为请改 `scripts/build-package.mjs` 里的模板，而不是直接改生成的 `.iss`。

## 3. 校验产物

`SHA256SUMS.txt` 每行格式为 `<sha256>  <相对路径>`（路径用 `/` 分隔，与 GNU `sha256sum` 兼容）。

PowerShell（Windows 自带）：

```powershell
cd dist\AstrBotModelConsole
$fail = 0
Get-Content SHA256SUMS.txt | ForEach-Object {
  $hash, $path = $_ -split '  ', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower()
  if ($actual -ne $hash) { Write-Host "MISMATCH $path"; $fail++ }
}
if ($fail) { Write-Host "$fail 个文件校验失败"; exit 1 } else { Write-Host '全部文件 SHA256 一致' }
```

Git Bash / WSL：

```bash
cd dist/AstrBotModelConsole
sha256sum -c SHA256SUMS.txt
```

`SHA256SUMS.txt` 不包含它自身；`node.exe` 也在清单内。zip 的 sha256 会在 `--zip` 构建输出的最后一行打印。

## 4. 生成安装器（Inno Setup）

先构建便携包（安装器直接打包 `dist\AstrBotModelConsole`）：

```powershell
node scripts/build-package.mjs
```

再用 Inno Setup 6 的编译器编译脚本：

```powershell
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' installer\model-console.iss
```

或在 Inno Setup IDE 里打开 `installer\model-console.iss` 后按 F9。产物：

```
installer\Output\AstrBotModelConsole-<version>-win-x64-setup.exe
```

安装器的行为：

- `PrivilegesRequired=lowest`：按当前用户安装，不需要管理员权限。
- 默认安装到 `%LOCALAPPDATA%\AstrBotModelConsole\app`（程序只读运行）。
- 开始菜单快捷方式 + 可选桌面快捷方式（默认不勾选），快捷方式指向 `start.cmd`。
- **卸载保留用户数据**：`%LOCALAPPDATA%\AstrBotModelConsole\state`（备份、审计、锁文件）不在安装
  范围内，也不写 `[UninstallDelete]`，卸载后保留；不会被卸载器删除。
- 安装器对 x64 生效；`installer\Output\` 已加入 `.gitignore`。

> 若本机没有 Inno Setup，仍可直接分发便携 zip；安装器不是构建便携包的前置条件。

## 5. 不打包的内容（白名单以外一律排除）

构建脚本采用**白名单**复制，只包含：

```
src/  public/  package.json  README.md
start-console.cmd  start-console-edit.cmd
docs/HANDOVER.zh-CN.md  docs/BUILD.zh-CN.md  docs/DESIGN-multi-device-2026-10-29.zh-CN.md
```

明确排除（即使出现在源码树里也不会进包）：

- `state/`：备份、`audit.jsonl`、`instance.lock` 等含业务/本地信息的数据；
- `.git/`、`node_modules/`、`test/`、`scripts/`、`installer/`、`dist/`；
- `.tmp*`、`*.log`；
- 其他文档（`REVIEW`、`BACKLOG`、`P0-AUDIT`、`SPRINT-CONTRACT`）与任何密钥、token、用户配置。

分发前自查：解压后确认包内**没有** `state/`、`*.log`、`*.json` 里带 `jwt_secret`/token 等内容。
`src/` 与 `public/` 本身不含凭据；AstrBot 的密钥只在运行时从用户自己的 data 目录读取。

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `node.exe is missing next to start.cmd` | 只拷了部分文件；重新解压完整包，或重新运行构建脚本 |
| 双击 `start.cmd` 后窗口闪退 | 该窗口会保留错误输出并 `pause`；也可能是 AstrBot data 目录未发现，按提示设置 `ASTRBOT_DATA` |
| `start-console.cmd` 报找不到 node | 它是开发脚本，用 PATH 里的 `node`；分发场景请用 `start.cmd`（包内 node.exe） |
| `--zip` 失败 | 检查 PowerShell 是否可用、磁盘空间；zip 会把 `node.exe` 一并压缩（约 40–60 MB） |
| 构建后 git 里多了 `installer/model-console.iss` | 该文件由脚本生成，属于预期产物；`dist/` 与 `installer/Output/` 已被 `.gitignore` 忽略 |
| 杀毒软件误报 | 构建只用 `node` 与可见窗口的 PowerShell；不要再加隐藏窗口/停止进程类脚本 |

版本升级：修改 `package.json` 的 `version` → 重新执行 `node scripts/build-package.mjs --zip`，zip 与安装器
文件名会自动带上新版本号。
