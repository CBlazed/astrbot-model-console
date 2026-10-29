; AstrBot Model Console - Inno Setup 脚本（per-user 安装，免管理员）
; 本文件由 scripts/build-package.mjs 自动生成；要改安装器请改脚本里的模板，不要直接改本文件。
; 生成安装器前先构建便携包：node scripts/build-package.mjs
; 编译（需安装 Inno Setup 6）：ISCC.exe installer\model-console.iss
; 产物：installer\Output\AstrBotModelConsole-0.1.0-win-x64-setup.exe

#define AppName "AstrBot Model Console"
#define AppVersion "0.1.0"
#define NodeVersion "v24.22.1"
#define SourceDir "..\dist\AstrBotModelConsole"

[Setup]
AppId={{6D3C8B4E-2F5A-4E7B-9C1D-8A7E6F5D4C3B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=AstrBot Model Console
DefaultDirName={localappdata}\AstrBotModelConsole\app
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename=AstrBotModelConsole-{#AppVersion}-win-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\node.exe
CloseApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: unchecked

[Files]
; 只安装便携包内容；state\ 用户数据不在安装范围内。
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\start.cmd"; Description: "启动 {#AppName}"; Flags: nowait postinstall skipifsilent

; 卸载只删除安装目录 {app}（%LOCALAPPDATA%\AstrBotModelConsole\app）与快捷方式。
; 用户数据目录 %LOCALAPPDATA%\AstrBotModelConsole\state（备份、审计、锁）由程序自行管理，
; 这里刻意不写 [UninstallDelete]，卸载后保留 state。
