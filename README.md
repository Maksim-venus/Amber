<p align="center">
  <img src="src/desktop/icons/128x128@2x.png" alt="Amber" width="160">
</p>

<h1 align="center">Amber（琥珀）</h1>

<p align="center"><em>Knowledge finds its way</em></p>

Amber 是一款开源的 AI 音视频处理工具，用户可以导入本地或平台（Bilibili/YouTube）上的音视频，取得带时间戳的字幕文稿，再用 AI 校对、总结、翻译等。

发布形式：Windows 客户端。数据只保存在用户电脑上，免费，无遥测，自带模型密钥（BYOK）。许可证为 AGPL-3.0-only。

## 功能特性

- **多来源导入**：本地音视频文件、B 站与 YouTube 链接（合集、播放列表可整批导入）；可为音视频附带导入 SRT / VTT 字幕。
- **文稿获取**：平台字幕、导入的字幕文件，或语音转录。转录服务当前支持 ElevenLabs 与阿里云百炼，可在其下添加模型，后续会增加更多服务商。
- **灵活接入 AI 模型**：添加多个模型服务，包括自定义 Base URL 与模型 ID；当前支持 OpenAI 兼容与 Anthropic Messages 两种协议。
- **AI 整理**：校对、分章、总结（单条内容与合集归纳）、AI 高光、翻译。AI 处理只在用户点「开始处理」或手动发起时进行，原文改动后不会自动重算。
- **学习**：全文搜索、基于文稿的 AI 对话（回答附可跳转的原文出处）、笔记（下划线、高亮、评论）、术语表。
- **字幕与导出**：导出 Markdown，以及 SRT、VTT、TXT、ASS 字幕（SRT 与 ASS 可双语，ASS 带样式）；也可导出带字幕的视频（硬字幕或软字幕轨）。
- **界面**：四套主题（浅色、深色、经典豆沙绿、羊皮纸）。

## 下载与安装

- 系统要求：Windows 11（64 位）。
- 在 [Releases](https://github.com/lifefindsitsway/Amber/releases) 下载 `Amber_<版本>_x64-setup.exe` 并运行。
- 安装包尚未使用 Windows 代码签名（Authenticode），部分设备上 SmartScreen 可能提示。请先核对下载来源是本仓库的 Releases 页面，再自行决定是否继续安装。
- 更新：客户端启动时检查一次更新，发现新版本只提示，由用户决定是否下载安装；可在「关于 Amber」中关闭自动检查或手动检查。

## macOS 版（社区移植，Apple Silicon）

> 本节由 fork [Maksim-venus/Amber](https://github.com/Maksim-venus/Amber) 的 `macos-build` 分支添加。Amber 原作者为 [lifefindsitsway](https://github.com/lifefindsitsway/Amber)，上游只发布 Windows 客户端；这里的 macOS 版是非官方移植，问题请先在本 fork 反馈，不要提交到上游。

### 下载

- [Releases › v0.1.0-macos-arm64](https://github.com/Maksim-venus/Amber/releases/tag/v0.1.0-macos-arm64)：`Amber_0.1.0_macos_arm64.zip`（附 `.sha256` 校验文件）。
- 系统要求：Apple Silicon（M 系列芯片）Mac，macOS 11 及以上。
- CI 构建：`macos-build` 分支每次推送、手动触发（workflow_dispatch）或推送 `v*-macos*` 标签时，[macos-build 工作流](https://github.com/Maksim-venus/Amber/actions/workflows/macos.yml) 会在 GitHub Actions（macos-15）上构建 arm64 版，产物 `amber-macos-arm64`（zip + `.sha256`）可在运行页面下载；标签构建还会自动附加到同名 Release（不覆盖已有文件）。

### 安装

1. 解压 `Amber_0.1.0_macos_arm64.zip`，把 `Amber.app` 拖到「应用程序」。
2. 安装包只做了 ad-hoc 签名、未经 Apple 公证，首次打开前在终端执行：
   ```sh
   xattr -dr com.apple.quarantine /Applications/Amber.app
   ```
3. 打开 Amber 即可使用，不会再弹出钥匙串提示。

### 主密钥（macOS 版存放在文件里，不用钥匙串）

- 上游在 Windows 上把加密 API Key 用的主密钥放在凭据管理器。macOS 版改为文件 `~/Library/Application Support/Amber/secrets/master.key`（目录权限 0700、文件 0600，首次启动自动生成），完全不读写钥匙串。原因是 ad-hoc 签名每次重新构建签名都会变，钥匙串会拒绝读取或反复弹窗。
- **备份：** 迁移或备份时请把 `master.key` 与整个数据目录一起保存；丢失或换掉它，已保存的 API Key 将无法解密（报 `internal.secret_unavailable`），只能在「功能配置」里重置凭据后重新填写。内置的 `.amberbackup` 备份本来就不含 API Key。
- **安全取舍：** 钥匙串会用登录密码保护密钥，并限制只有本应用可读；文件方式下，任何以你的用户身份运行的程序都能读取 `master.key`，进而解密数据库里的 API Key。请保持 macOS 账户与磁盘加密（FileVault）安全，不要把数据目录放到共享或同步盘。

### 从源码构建（macOS）

前置条件：Apple Silicon Mac、Xcode 或 Command Line Tools、Rust（stable，≥ 1.85）、Node.js（满足 `package.json` 的 `engines`）、pnpm（版本见 `packageManager`，可用 Corepack 或 `npm i -g pnpm@<版本>`）。

```sh
git clone -b macos-build https://github.com/Maksim-venus/Amber.git
cd Amber
pnpm install --frozen-lockfile
pnpm build
bash src/tooling/pack-sidecar-macos.sh arm64   # 下载并校验 macOS 版 Node、yt-dlp、Deno、FFmpeg 与字体
pnpm tauri build --bundles app
# 产物：src/desktop/target/release/bundle/macos/Amber.app
```

### 与上游的差异

- macOS 上主密钥改存 `secrets/master.key`（`src/desktop/src/key_file.rs`），不访问钥匙串；Windows 行为不变。
- 新增 `src/desktop/tauri.macos.conf.json`、`icons/icon.icns`、`Entitlements.plist`（V8 需要的 JIT 权限；ad-hoc 构建关闭 hardened runtime）。
- 新增 `src/tooling/pack-sidecar-macos.sh`：macOS 版 sidecar（Node 24.21.0、yt-dlp 2026.08.19、Deno 2.9.7、FFmpeg 9.0.2 静态 GPL 构建 by Martin Riedl），全部按 SHA256 校验。
- 后端 CORS 按平台选择 WebView 来源：Windows 为 `http://tauri.localhost`，macOS/Linux 为 `tauri://localhost`（修复 macOS 白屏）。
- sidecar 在 macOS 上透传 `HOME`、`TMPDIR` 等环境变量（yt-dlp 读取浏览器 Cookie 需要）。

### 已知限制

- 只有 arm64（Apple Silicon），没有 Intel / Universal 版本。
- 未签名、未公证，需要手动去掉隔离属性。
- YouTube 内嵌播放器在 `tauri://localhost` 来源下未经测试，可能无法播放。
- B 站登录窗口的 Cookie 处理在 macOS 上走通用实现，未充分测试。
- macOS 版未配置应用内更新，新版本需要到本 fork 的 Releases 手动下载。

## 快速开始

1. 在「新总结」里选择本地音视频文件，或粘贴 B 站 / YouTube 链接，点「开始处理」。
2. 文稿优先取平台字幕；没有字幕时，在「功能配置」里添加一个转录服务后生成。部分平台字幕需要登录才能取得，可在「功能配置 › 平台账号」登录。
3. 需要 AI 处理时，在「功能配置 › 模型」里添加模型服务，然后对文稿做校对、总结、翻译或对话。

## 数据与隐私

- 资料库只保存在本机，客户端无需注册或登录，项目不收集任何遥测数据。
- 会访问网络的操作包括：获取平台内容、调用用户配置的 AI 服务、检查更新等。发送给 AI 服务的音频与文稿受该服务商的隐私政策约束，费用也由它收取。
- API Key 加密保存在本机。
- 备份：可把整个资料库导出为一个 `.amberbackup` 文件。备份不含 API Key 与平台登录状态；文件未加密，请妥善保管；只能恢复到全新安装的 Amber，不支持合并。

## 开发指南

### 环境要求

- Node.js：满足 `package.json` 的 `engines`。
- pnpm：版本见 `package.json` 的 `packageManager`，可经 Corepack 启用。
- 构建 Windows 安装包另需 Rust 与 Tauri 构建环境；日常开发不需要。

开发环境与宿主无关，Linux、WSL 或其它能运行上述工具的机器均可。

### 本地开发

```sh
git clone https://github.com/lifefindsitsway/Amber.git
cd Amber
pnpm install --frozen-lockfile
gh release download runtime-assets-2026.10.21 --repo lifefindsitsway/amber-runtime-assets --dir runtime-assets
pnpm setup:tools --assets runtime-assets
pnpm dev
```

yt-dlp、FFmpeg、Deno 与字幕字体来自固定版本的 Amber Runtime Assets，发布在资源仓库 [lifefindsitsway/amber-runtime-assets](https://github.com/lifefindsitsway/amber-runtime-assets) 的 Release `runtime-assets-2026.10.21`。每个文件的版本与 SHA256 以 Release 附带的 `manifest.json` 与 `SHA256SUMS` 为准；`pnpm setup:tools` 会先核对 `SHA256SUMS` 的摘要，再按它校验每个文件后安装到 `.amber-tools/`。只需要本机平台的文件时，可以用 `--pattern` 只下载部分文件，做法见 `.github/workflows/ci.yml`。

`node_modules/`、`dist/`、`.amber-tools/`、`src/desktop/gen/` 都可以删除后重新生成。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 本地模式后端 + Vite 开发服务器（`http://localhost:5173`），数据在 `.amber-dev/` |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | 单元与组件测试 |
| `pnpm test:file -- <路径>` | 运行指定测试文件 |
| `pnpm test:guards` | 结构化守卫（依赖边界、凭据扫描等） |
| `pnpm test:e2e` | 浏览器冒烟测试（需先 `pnpm exec playwright install chromium`） |
| `pnpm build` | 构建前端与服务器产物到 `dist/` |

### 项目结构

| 目录 | 内容 |
|---|---|
| `src/shared/` | 前后端共用的类型、枚举、默认值与界面文案 |
| `src/server/` | 后端：API、应用服务、领域模型、任务管线与各类 adapter |
| `src/web/` | React 前端 |
| `src/desktop/` | Tauri 外壳（Rust），只负责窗口、文件选择、sidecar 生命周期等 |
| `src/tooling/` | 构建、打包、版本检查等工具脚本 |
| `test/` | 测试，目录镜像 `src/` |

后端按 Ports & Adapters 组织：应用服务、领域模型与管线只依赖 port 接口，具体实现在 `src/server/adapters/`。`pnpm test:guards` 会检查这些依赖边界。

### 服务器模式

同一套代码还有一个多用户的服务器模式，只用于开发与自动化测试，缺省只监听 `127.0.0.1`：

```sh
pnpm build
AMBER_MODE=server AMBER_DATA_DIR=<数据目录> AMBER_BIN_DIR=.amber-tools/bin \
AMBER_PUBLIC_ORIGIN=http://127.0.0.1:3000 node dist/server/server.js
```

首次启动会在控制台输出一次性 setup token，打开 `http://127.0.0.1:3000/setup` 创建管理员。

## 许可证

Amber 以 [AGPL-3.0-only](LICENSE) 发布。安装包附带 `LICENSE`、`THIRD_PARTY_NOTICES.md`（第三方组件及许可证）与 `SOURCE.md`（源码获取方式）。安装包中的 FFmpeg 为 GPL 构建，其完整对应源码与第三方许可证包发布在上述 Runtime Assets Release 中，地址见 `SOURCE.md`。

## 反馈与贡献

问题与建议请提交到 [Issues](https://github.com/lifefindsitsway/Amber/issues)。较大的改动请先开 Issue 讨论，再提交 Pull Request。
