# YouTube 插件同步报告

- 上游：`https://raw.githubusercontent.com/devchristian1337/loon-plugins/refs/heads/main/Plugins/YouTube.lpx`
- 上游日期：`2026-11-07`
- 上游 SHA-256：`855b8806249adc3ea6edbb1a572264f3b405ae2fe4a24622f16a4ddfe6c8f951`
- 本次同步：2026-11-13 13:39:55 UTC
- 已镜像脚本：`request.min.js`、`response.min.js`

## 脚本内文案替换

| 原文开头 | 命中次数 |
| --- | --- |
| `"YouTube Log","Logging tool enabled","Tap to ope` | 1 |
| `"YouTube Log","Tap to open the log page","Start,` | 1 |
| `<title>YouTube Log</title>` | 1 |
| `<title>YouTube Export</title>` | 1 |
| `<p id="status">Reading local records, keep Loon ` | 1 |
| `hidden>Save log file</a>` | 2 |
| `<p>Tap Save once the file is generated; in Safar` | 1 |
| `"YouTube Log","Logging tool enabled","Tap to ope` | 1 |
| `"YouTube Log","Tap to open the log page","Start,` | 1 |
| `<title>YouTube Log</title>` | 1 |
| `<title>YouTube Export</title>` | 1 |
| `<p id="status">Reading local records, keep Loon ` | 1 |
| `hidden>Save log file</a>` | 2 |
| `<p>Tap Save once the file is generated; in Safar` | 1 |

## 本地裁剪

按 `i18n.json` 的 `strip.arguments` 删除的参数：`translation_enabled`、`translation_target`

| 删掉的 [Script] 行 | 引用的裁剪参数 | 条目名 |
| --- | --- | --- |
| 50 | translation_enabled、translation_target | YouTube 字幕目标语言 |

## 未翻译的英文（上游新增或改写了文案）

无，全部条目都已汉化。
