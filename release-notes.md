## SmartEdu 下载器 v1.2.1

### 修复

- **HLS 视频解密**: v1.2.0 尝试用 `net.fetch()` 获取解密密钥，但密钥服务器（ndvideo-key.ykt.eduyun.cn）在华为 WAF 后面，`net.fetch()` 不执行 JavaScript，无法通过 WAF 的 JS Challenge。改用隐藏 `BrowserWindow` 加载页面，让 WAF JS 自动执行并设置 Cookie，再通过渲染进程的 `fetch()` API 获取密钥，成功解密并输出可播放的 `.ts` 文件。

### 新特性

- **HLS 视频自动解密**: 加密视频（AES-128）现在会自动解密，无需手动处理密钥。密钥服务器通过 Electron 原生网络栈访问，自动处理 WAF 验证。输出为可直接播放的 `.ts` 文件。
- **下载结果去重**: 修复了批量下载时同一文件重复记录的 bug。
- **视频下载**: 之前只能保存 .m3u8 播放列表（无法播放）。现在能自动下载并解密 HLS 加密视频，输出为可直接播放的 `.ts` 文件。
- **课件/教案格式**: 当平台只返回 PDF 转换版时，文件扩展名自动改为 `.pdf` 并标注 `[PDF转换]`，不再保存为不可打开的 `.pptx`/`.docx`。
- **文件树显示**: 实际格式与声明格式不一致时，树形列表使用正确格式图标和扩展名。
- **构建输出目录**: 改为 `out/`，避免文件锁定导致构建失败。

### 使用说明

1. 下载对应平台的版本
2. 打开应用，粘贴资源链接
3. 点击「解析」→ 勾选文件 → 「下载选中」

### 下载受限资源

部分资源需要 Access Token：
- 登录 basic.smartedu.cn
- F12 → 控制台 → 粘贴以下代码获取 Token：

```js
(function(){const a=Object.keys(localStorage).find(k=>k.startsWith("ND_UC_AUTH"));if(!a)return console.error("请先登录");const t=JSON.parse(localStorage.getItem(a));console.log(JSON.parse(t.value).access_token)})()
```

- 在应用中点击右上角「未设置」→ 粘贴 Token → 保存

### 支持链接类型

| 类型 | URL 特征 |
|------|----------|
| 教材 | /tchMaterial/detail |
| 课程活动 | /syncClassroom/classActivity |
| 课件 | /syncClassroom/prepare/detail?resourceId |
| 一堂课 | /syncClassroom/prepare/detail?lessonId |
| 实验课 | /syncClassroom/experimentLesson |
| 基础作业 | /syncClassroom/basicWork/detail |
| 精品课 | /qualityCourse |
| 专题课程 | /schoolService/detail?thematic_course |
| 视频 | /sedu/detail 或 /wisdom/detail |

### 注意

- 本 Release 提供 **Windows x64** 和 **Windows x86 (32位)** 便携版
- 视频下载后为 `.ts` 格式（MPEG-TS 容器），可用 VLC、PotPlayer、ffplay 等播放器打开。如需 `.mp4` 格式，可用 ffmpeg 转换：`ffmpeg -i input.ts -c copy output.mp4`
- macOS / Linux 用户请从源码构建：

```bash
git clone https://github.com/joimjnbg/smartedu-downloader.git
cd smartedu-downloader
npm install
npm run build:mac-x64
```
