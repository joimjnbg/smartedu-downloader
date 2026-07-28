## SmartEdu 下载器 v1.1.0

### 修复

- **视频下载**: 之前只能保存 .m3u8 播放列表（无法播放）。现在能自动下载所有 .ts 分段并合并为单个 `.ts` 文件，数据完整保留。如需解密播放，可用 ffmpeg 配合密钥处理。
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
- 视频为加密 HLS 流（AES-128），密钥服务器 IP 受限，当前无法解密。下载的 `.ts` 文件包含完整视频数据，需用 ffmpeg 等工具配合密钥解密。
- macOS / Linux 用户请从源码构建：

```bash
git clone https://github.com/joimjnbg/smartedu-downloader.git
cd smartedu-downloader
npm install
npm run build:mac-x64
```
