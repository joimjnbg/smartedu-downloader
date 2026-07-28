## SmartEdu 下载器 v1.0.0

跨平台桌面应用，下载 [国家中小学智慧教育平台](https://basic.smartedu.cn) 的资源。

## 使用说明

1. 下载 **SmartEdu下载器-win-x64.exe**（无需安装，双击运行）
2. 打开应用，粘贴资源链接（如 https://basic.smartedu.cn/syncClassroom/classActivity?...）
3. 点击「解析」→ 勾选需要下载的文件 → 「下载选中」

## 下载受限资源

部分资源需要 Access Token：
- 在浏览器中登录 basic.smartedu.cn
- F12 → 控制台 Console → 粘贴以下代码获取 Token：

```js
(function(){const a=Object.keys(localStorage).find(k=>k.startsWith("ND_UC_AUTH"));if(!a)return console.error("请先登录");const t=JSON.parse(localStorage.getItem(a));console.log(JSON.parse(t.value).access_token)})()
```

- 在 SmartEdu 下载器中点击右上角「未设置」→ 粘贴 Token → 保存

## 支持链接类型

| 类型 | 示例 URL 特征 |
|------|--------------|
| 教材 | /tchMaterial/detail |
| 课程活动 | /syncClassroom/classActivity |
| 课件 | /syncClassroom/prepare/detail?resourceId |
| 一堂课 | /syncClassroom/prepare/detail?lessonId |
| 实验课 | /syncClassroom/experimentLesson |
| 基础作业 | /syncClassroom/basicWork/detail |
| 精品课 | /qualityCourse |
| 专题课程 | /schoolService/detail?thematic_course |
| 视频 | /sedu/detail 或 /wisdom/detail |

## 注意

- 本 Release 提供 **Windows x64** 和 **Windows x86 (32位)** 便携版
- **x64**：64 位系统使用
- **ia32**：32 位系统使用
- macOS / Linux 用户请从源码构建：

```bash
git clone https://github.com/joimjnbg/smartedu-downloader.git
cd smartedu-downloader
npm install
npm run build:mac-x64    # macOS Intel
npm run build:mac-arm64  # macOS Apple Silicon
npm run build:linux-x64  # Linux
```
