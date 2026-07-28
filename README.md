# SmartEdu 下载器

跨平台桌面应用，下载 [国家中小学智慧教育平台](https://basic.smartedu.cn) 上的教材、课件、作业、课程活动、实验课、视频等资源。

基于 Electron 构建，支持 Windows / macOS / Linux。

---

## 功能

- **支持多种资源类型** — 教材、同步课程、基础作业、课件、一堂课、实验课、精品课、专题课程、视频
- **树形文件选择** — 自动解析资源结构，勾选需要下载的文件
- **批量下载** — 保持原目录结构，一次性下载所有选中文件
- **Access Token** — 设置令牌后可下载受限资源
- **自动格式适配**
  - 视频（mp4）→ 识别 HLS 流（m3u8），解密合并为 mp4
  - 课件/教案（pptx/docx）→ 识别 PDF 回退，自动标注 `[PDF转换]`
  - 普通 pdf/doc 等直接下载

## 截图

![主界面](screenshot.png)

## 下载

从 [Releases](https://github.com/joimjnbg/smartedu-downloader/releases) 页面下载最新版本。

| 平台 | 文件 | 说明 |
|------|------|------|
| Windows x64 | `SmartEdu下载器-win-x64.exe` | 64 位系统 |
| Windows x86 | `SmartEdu下载器-win-ia32.exe` | 32 位系统 |
| macOS x64 | 需从源码构建 | `npm run build:mac-x64` |
| macOS ARM | 需从源码构建 | `npm run build:mac-arm64` |
| Linux x64 | 需从源码构建 | `npm run build:linux-x64` |

> 目前仅提供 Windows 预编译版本（x64 和 x86 均可用）。其他平台用户请参考「从源码构建」章节自行编译。

## 快速开始

1. 打开 [basic.smartedu.cn](https://basic.smartedu.cn) 并登录
2. 复制任意资源页面的 URL
3. 粘贴到 SmartEdu 下载器 → 点击「解析」
4. 勾选需要下载的文件 → 点击「下载选中」
5. 选择保存目录，等待下载完成

### 下载受限资源

部分资源（如课程视频、加密文档）需要 Access Token：

1. 在浏览器中登录 basic.smartedu.cn
2. 按 `F12` 打开开发者工具 → 「控制台」Console
3. 粘贴以下代码，按回车：

```js
(function(){
  const a=Object.keys(localStorage).find(k=>k.startsWith("ND_UC_AUTH"));
  if(!a) return console.error("请先登录");
  const t=JSON.parse(localStorage.getItem(a));
  console.log(JSON.parse(t.value).access_token)
})()
```

4. 复制输出的 Token 值
5. 在 SmartEdu 下载器中点击右上角 `🔑 未设置` → 粘贴 Token → 保存

## 从源码构建

### 前置要求

- Node.js ≥ 18
- npm ≥ 9

### 步骤

```bash
# 克隆仓库
git clone https://github.com/joimjnbg/smartedu-downloader.git
cd smartedu-downloader

# 安装依赖
npm install

# 启动开发模式
npm start

# 构建分发版
npm run build:win-x64      # Windows x64 便携版（输出到 dist/）
npm run build:mac-x64      # macOS Intel
npm run build:mac-arm64    # macOS Apple Silicon
npm run build:linux-x64    # Linux x64
```

### 构建脚本

| 命令 | 产物 | 输出路径 |
|------|------|---------|
| `npx electron-builder --win portable --x64 --ia32` | Windows x64 + x86 便携版 | `dist/SmartEdu下载器-win-x64.exe` + `dist/SmartEdu下载器-win-ia32.exe` |
| `npx electron-builder --win portable --x64 --ia32` | Windows x64 + x86 便携版 | `out/SmartEdu下载器-win-x64.exe` + `out/SmartEdu下载器-win-ia32.exe` |
| `npm run build:win-x64` | Windows x64 便携版 | `out/SmartEdu下载器-win-x64.exe` |
| `npm run build:mac-arm64` | macOS ARM (M系列) zip | `out/SmartEdu下载器-mac-arm64.zip` |
| `npm run build:linux-x64` | Linux AppImage | `out/SmartEdu下载器-linux-x64.AppImage` |

## 项目结构

```
smartedu-downloader/
├── main.js          # Electron 主进程（URL解析、下载、Token管理）
├── renderer.js      # 渲染进程（UI、树形选择、下载进度）
├── preload.js       # 预加载桥接（IPC通信）
├── index.html       # 界面布局
├── package.json     # 项目配置
└── icon.png         # 应用图标
```

## 工作原理

1. 粘贴 URL → `detectType()` 识别资源类型
2. 调用对应 API 端点获取 JSON 数据
3. 解析 `ti_items` 中的资源项，提取下载 URL
4. 构建资源树 → 用户勾选 → 批量下载
5. 下载时重试机制：先尝试无认证请求，若 401/403 则使用 Token 重试

### 支持的 URL 类型

| URL 匹配规则 | 类型 | API 端点 |
|-------------|------|---------|
| `/tchMaterial/detail` | 教材 | `s-file-1/special_edu/resources/details` |
| `/syncClassroom/classActivity` | 课程活动 | `s-file-2/national_lesson/resources/details` |
| `/syncClassroom/prepare/detail?resourceId` | 课件 | `s-file-2/prepare_sub_type/resources/details` |
| `/syncClassroom/prepare/detail?lessonId` | 一堂课 | `s-file-1/prepare_lesson/resources/details` |
| `/syncClassroom/experimentLesson` | 实验课 | `s-file-1/experiment/resources/details` |
| `/syncClassroom/basicWork/detail` | 基础作业 | `s-file-1/special_edu/resources/details` |
| `/qualityCourse` | 精品课 | `s-file-1/elite_lesson/resources` |
| `/schoolService/detail?thematic_course` | 专题课程 | `s-file-1/special_edu/thematic_course` |
| `/sedu/detail` 或 `/wisdom/detail` | 视频 | `s-file-1/special_edu/resources/details` |

## 注意事项

- **视频下载**：平台视频为 HLS 加密流（m3u8 + AES-128）。若密钥可获取则自动解密合并为 mp4；否则保存为 .m3u8 文件，可在登录后的浏览器中播放
- **课件/教案**：部分资源不再提供源文件（pptx/docx），平台只返回 PDF 转换版，下载后自动标注 `[PDF转换]`
- **Access Token**：会保存在本地 `userData/token.json`，重启后仍有效

## 技术栈

- [Electron](https://www.electronjs.org/)
- [electron-builder](https://www.electron.build/)
- Node.js HTTPS 原生模块

## 许可

MIT
