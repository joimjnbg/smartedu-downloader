## SmartEdu下载器 v1.3.0

### 重要变更

#### ⚠️ 视频下载功能已取消

平台视频使用 **AES-128 加密** + **华为 WAF (Web Application Firewall) JS Challenge** 双重保护。密钥服务器 `ndvideo-key.ykt.eduyun.cn` 需要真实浏览器环境执行 JavaScript 才能通过 WAF 验证。

先后尝试了以下方案，均无法可靠工作：

| 方案 | 结果 |
|------|------|
| `net.fetch` 直接请求 | WAF 返回 403 |
| 隐藏 BrowserWindow 加载根页面触发 WAF JS | Cookie 无法跨进程安全共享 |
| 主窗口 iframe + `executeJavaScript` | WAF 检测到非标准浏览器指纹 |
| 独立隐藏窗口 + `session.webRequest` 注入认证头 | 仍被 WAF 识别拦截 |

**结论**：在不运行完整 Chromium 浏览器的情况下，无法可靠绕过华为 WAF 获取解密密钥。v1.3.0 起**取消视频下载功能**，解析视频链接时返回明确的错误提示。

如需下载视频，请在浏览器中打开后手动保存，或使用浏览器扩展程序。

### 新特性

- **自动发现所有资源分类**: `parseRelationResources` 不再依赖硬编码白名单 —— 当未指定 relationKeys 时，自动使用 API 返回的全部字段作为资源分类，新增的资源类型不再被静默丢弃。
- **URL 检测重写**: 改用 `URL API` 精确解析路径和参数，`?lessonId=xxx&resourceId=yyy` 等参数顺序不再影响识别；路径片段不会误匹配无关 URL。
- **图片/音频格式支持**: `TYPE_LABELS` 新增 jpg/png/gif/svg/webp（图片）和 mp3/wav/aac/flac/ogg（音频）、7z（压缩包）等格式。
- **降级兜底**: basicWork、courseware、thematicCourse、video 等单资源处理器在 `ti_items` 无结果时自动尝试 `relations` 中的全部分类。
- **专题课程增强**: 不再仅筛选 `assets_document`，支持专题课程中包含的所有资源类型。
- **代码分层**: 纯逻辑函数提取到 `lib.js`，可脱离 Electron 独立测试。

### 测试

- 新增 `tdd-logic.js` 单元测试套件，覆盖 URL 检测、资源提取、关系解析、工具函数等 **67 项**测试，全部通过。
- 原有 HLS AES-128 解密测试（`tdd-suite.js`）保留仅作参考（视频功能已禁用）。

### 文件变更

| 文件 | 变更 |
|------|------|
| `lib.js` | **新增**：纯逻辑层（URL检测、资源提取、关系解析） |
| `tdd-logic.js` | **新增**：逻辑层单元测试（67项） |
| `main.js` | 重构：移除 `fetchDrmKey` / `downloadHls` / WAF 绕过代码；所有 handler 使用自动发现；`handleVideo` 返回视频禁用提示 |
| `lib.js` | 视频格式（m3u8/mp4/ts）在 extractUrl 中被过滤 |
| `README.md` | 更新功能列表、项目结构、URL 类型表 |
| `package.json` | 版本升至 1.3.0；构建清单添加 `lib.js` |

## SmartEdu下载器 v1.2.1

### 修复

- **HLS 视频解密**: v1.2.0 尝试用 `net.fetch()` 获取解密密钥，但密钥服务器（ndvideo-key.ykt.eduyun.cn）在华为 WAF 后面，`net.fetch()` 不执行 JavaScript，无法通过 WAF 的 JS Challenge。改用隐藏 `BrowserWindow` 加载页面，让 WAF JS 自动执行并设置 Cookie，再通过渲染进程的 `fetch()` API 获取密钥，成功解密并输出可播放的 `.ts` 文件。
