# 构建与分发（便携 node 包）

这是**一个简单工具**：推荐直接解压运行——双击 `start.cmd` 即可，不需要安装器、不需要管理员权限，也没有
自动更新。本文档说明如何构建便携包、校验产物、启动与升级。

构建脚本零第三方依赖，不需要 `npm install`。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 操作系统 | Windows x64（打包脚本要复制 `node.exe` 并生成 `.cmd`，因此仅支持 Windows） |
| Node.js | 与本机 `node.exe` 同版本即可（当前开发机 v24.22.1；`package.json` 要求 >=24.22） |
| 网络/依赖 | 无。构建只用 Node 内置模块和 Windows 自带的 PowerShell |

构建脚本使用**当前运行它的 Node**（`process.execPath`）作为随包 `node.exe`，所以请用准备分发的那个
Node 版本执行构建：

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

构建可重复执行：脚本先清理 `<out>\AstrBotModelConsole\` 再按白名单重新复制，不会把旧文件留在包里。

构建成功时会在最后打印版本、输出目录、文件数、SHA 清单行数，以及：

```
运行方式：解压后双击 start.cmd（只读模式，无需安装）；需要编辑请用 start-edit.cmd
说明：便携包，无安装器、无自动更新；升级=替换整个目录，用户数据留在 state/
```

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

zip 内顶层就是 `AstrBotModelConsole\` 目录，解压后双击 `start.cmd` 即可运行。

## 3. 启动

### 双击启动（推荐）

1. 解压 `AstrBotModelConsole-<version>-win-<arch>.zip` 到任意目录（不要放在 C:\Program Files 等需要
   管理员权限的位置；普通用户目录即可）。
2. 双击 `start.cmd`（只读模式）或 `start-edit.cmd`（编辑模式）。
3. 浏览器会打开控制台；关闭命令行窗口即停止服务。

`start.cmd` 只使用包内的 `node.exe`，所以目标机器**不需要预装 Node.js**。

首次启动会尝试自动发现 AstrBot 的 data 目录；失败时按窗口提示设置 `ASTRBOT_DATA`。状态目录默认跟随
AstrBot 数据目录管理，也可以用 `MODEL_CONSOLE_STATE` 指定到独立目录。

### 命令行启动

```powershell
cd dist\AstrBotModelConsole
.\start.cmd
.\start-edit.cmd
```

开发场景仍可使用 `start-console.cmd` / `start-console-edit.cmd`（依赖 PATH 里的 `node`，不是分发入口）。

## 4. 校验产物

`SHA256SUMS.txt` 每行格式为 `<sha256>  <相对路径>`（路径用 `/` 分隔，与 GNU `sha256sum` 兼容），不包含
它自身；`node.exe` 也在清单内。

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

zip 的 sha256 会在 `--zip` 构建输出的最后一行打印，可随 zip 一起发布给接收方。

## 5. 不打包的内容（白名单以外一律排除）

构建脚本采用**白名单**复制，只包含：

```
src/  public/  package.json  README.md
start-console.cmd  start-console-edit.cmd
docs/HANDOVER.zh-CN.md  docs/BUILD.zh-CN.md  docs/DESIGN-multi-device-2026-10-29.zh-CN.md
```

明确排除（即使出现在源码树里也不会进包）：

- `state/`：备份、`audit.jsonl`、`instance.lock` 等含业务/本地信息的数据；
- `.git/`、`node_modules/`、`test/`、`scripts/`、`dist/`；
- `.tmp*`、`*.log`；
- 其他文档与任何密钥、token、用户配置。

分发前自查：解压后确认包内**没有** `state/`、`*.log`、带 `jwt_secret`/token 的配置文件。
`src/` 与 `public/` 本身不含凭据；AstrBot 的密钥只在运行时从用户自己的 data 目录读取。

## 6. 升级 = 替换目录

没有安装器，也没有自动更新，升级就是**替换整个程序目录**：

1. 退出正在运行的 `start.cmd` 窗口；
2. 解压新版本 zip 到新目录（或直接覆盖旧程序目录中的 `src/`、`public/`、`node.exe`、`*.cmd`、`docs/`）；
3. 双击新版 `start.cmd`。

用户数据（备份、审计、锁）在 `state/` 或 AstrBot data 目录中，不在包内，升级不会覆盖。稳妥做法是保留旧
目录做回滚备份，确认新版可用后再删除。

版本号取自 `package.json` 的 `version`；修改后重新执行 `node scripts/build-package.mjs --zip`，zip 文件名
会自动带上新版本号。

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `node.exe is missing next to start.cmd` | 只拷了部分文件；重新解压完整包，或重新运行构建脚本 |
| 双击 `start.cmd` 后窗口闪退 | 该窗口会保留错误输出并 `pause`；也可能是 AstrBot data 目录未发现，按提示设置 `ASTRBOT_DATA` |
| `start-console.cmd` 报找不到 node | 它是开发脚本，用 PATH 里的 `node`；分发场景请用 `start.cmd`（包内 node.exe） |
| 目标机器没有 Node.js | 不需要安装；`start.cmd` 使用包内自带的 `node.exe` |
| `--zip` 失败 | 检查 PowerShell 是否可用、磁盘空间；zip 会把 `node.exe` 一并压缩（约 40–60 MB） |
| 杀毒软件误报 | 构建只用 `node` 与可见窗口的 PowerShell（`Compress-Archive`）；不要再加隐藏窗口/停止进程类脚本 |
| 升级后旧配置还在吗 | 在。配置与备份不在包内；升级只替换程序目录，不碰用户数据 |

> 分发建议：直接发 zip，附上 `SHA256SUMS.txt` 或构建输出里的 zip sha256。这是简单工具，解压即用即可，
> 不要为它引入安装器或自动更新流程。
