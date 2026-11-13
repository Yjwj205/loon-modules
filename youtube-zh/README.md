# YouTube 插件（汉化版）· 自动跟随上游

> 上游作者：[devchristian1337/loon-plugins](https://github.com/devchristian1337/loon-plugins) · 汉化与镜像：Yjwj205

## 安装

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/youtube-zh/YouTube-zh.lpx
```

Loon → 配置 → 插件 → 右上角 `+` → 粘贴上面的地址 → 保存。

需要 **MITM 已开启**并信任 Loon 的证书；插件会请求 `*.googlevideo.com` 等域名的解密。
最低 Loon 版本 `3.5.1 (983)`。

## 这个仓库里的东西

| 文件 | 说明 |
| --- | --- |
| `YouTube-zh.lpx` | **生成文件**，汉化后的插件，别手改（下次同步会被覆盖） |
| `scripts/request.min.js` | 上游脚本镜像（仅替换了少量提示文案） |
| `scripts/response.min.js` | 同上 |
| `sync.py` | 同步脚本：抓上游 → 套翻译 → 写文件 → 自检 |
| `i18n.json` | 翻译表，英文原文 → 中文 |
| `upstream.json` | 上次同步的上游日期 / SHA-256 记录 |
| `report.md` | 每次同步的体检报告：镜像了哪些脚本、有哪些没翻译 |

插件里的脚本地址已经改成本仓库的 raw 地址，所以**不依赖上游仓库是否存活**，
上游就算改名、删文件，你手上的插件也照常跑（脚本停在上次同步的版本）。

## 自动更新怎么做的

`.github/workflows/sync-youtube-zh.yml`：GitHub Actions 每 2 小时（UTC 奇数点 :17）跑一次

```
上游 Plugins/YouTube.lpx  ──►  比对 #!date / SHA-256  ──►  有变化？
                                    │                        │
                                    │ 否                     │ 是
                                    ▼                        ▼
                              直接退出，不提交        重新镜像脚本 + 套汉化 + 自检
                                                       ──► 提交并推送（自带 commit 说明）
```

- 只在上游真有变化时才提交，不会刷无意义的空 commit。
- 你的 Loon 安装的是本仓库地址，所以推送后 Loon 检查插件更新就能拿到新版。
- GitHub 会在「仓库 60 天没有任何提交」后自动停掉定时任务，脚本里做了心跳：
  即使上游两个月没动静，也会每 25 天写一次 `last-check.txt`，把定时任务续上。
- 想立刻同步：Actions 页面 → 左边选「同步 YouTube 插件（汉化）」→ Run workflow。

## 本地裁剪

`i18n.json` 里的 `strip.arguments` 列出的参数，以及 `[Script]` 中**引用这些参数**的行，
在生成时会被删掉。当前删的是：

| 裁掉的东西 | 原因 |
| --- | --- |
| 参数 `translation_enabled` / `translation_target` | 用户另有字幕插件，不需要 YouTube 自带的字幕翻译 |
| `[Script]` 里 `youtube.com/api/timedtext` 那条 | 引用上面两个参数，字幕请求完全不再拦截 |

**上游改了参数名怎么办**：改名后匹配不到，`report.md` 的「本地裁剪」段会标出
「裁剪参数在上游没找到」，自检也会记一条问题——不会悄悄把字幕功能放回来。
要恢复字幕功能，把 `strip.arguments` 清空即可。

## 汉化范围

- 插件名称、简介、标签
- 全部 16 个参数的标题（tag）和说明（desc）
- 规则 / 改写 / 脚本段落的注释
- 12 条脚本条目的名称
- 脚本内的 2 条通知文案、日志页标题与导出页文案

**没汉化的部分**：脚本内部那个调试日志页的主体界面（表格表头、按钮等）仍是英文。
那是个开发者工具，默认关闭，开了「日志工具」才会出现；要汉化得改压缩后的 JS 里的
一整页 HTML 模板，风险大于收益，所以先留着。

`desc` 里一律用全角逗号（，），避免 Loon 解析参数时被英文逗号截断。

## 上游改了措辞怎么办

翻译表按**英文原文精确匹配**。上游一旦改写某条文案，匹配不上就会：

1. 该条目**原样显示英文**（不会显示错误或乱码）；
2. 在 `report.md` 的「未翻译的英文」里列出，还带行号和参数名。

看到报告里有条目，把英文原文和中文译文加进 `i18n.json` 的 `text` 里即可，下次同步自动生效。
新增参数也是同样的逻辑——不会因为多了参数就把插件搞坏。

## 本地手动跑一次

```bash
python3 youtube-zh/sync.py
```

只依赖 Python 标准库，不需要联网装任何东西。跑完会打印上游日期、是否有变化、
未翻译条目数和自检问题数。

自检内容包括：占位符 `{xxx}` 是否都在 `[Argument]` 里定义、
参数 tag/desc 是否混入英文逗号、`[Argument]` 段是否只有一个。
