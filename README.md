# NAI 生图 Demo（Scripting）

最小 NovelAI 客户端：Keychain 存 `pst-` token，调用官方 `image.novelai.net` 文生图，解 ZIP 后显示 PNG。

只覆盖接入和出图，没有反推、法典、图生图、批量。

## 文件

```
app/
  script.json   # Scripting 元数据
  index.tsx     # 界面
  nai.ts        # fetch / ZIP / Keychain
```

## 装到手机

1. 打开 Scripting App，新建脚本（或把 `app/` 整目录导入）。
2. 把这三个文件放进该脚本目录。`script.json` 的 `version` 以后改代码必须加一。
3. 运行。

没有模拟器，只能真机。国内网络需要系统 VPN，和官网一样。

## 用法

1. NovelAI 网页 → 齿轮 → Account → **Get Persistent API Token**，复制 `pst-` 开头的整串。
2. 贴进 Token → 保存 Token（进本机 Keychain，不写进脚本）。
3. 可选：检查订阅，确认 200 而不是 401。
4. 选 V5 Full / V5 Curated / V4.5 Full，点生成。默认 832×1216、23 step，大约 30–120 秒。
5. 成功后页面显示 PNG，文件在脚本 Documents 下的 `NAI-Demo/`。

## 接口

- `GET https://image.novelai.net/user/subscription`
- `POST https://image.novelai.net/ai/generate-image`  
  V5 请求体带 `v4_prompt`、`params_version: 4`，和网页/Langbai 同一条官方 API。

## 常见失败

| 现象 | 原因 |
|---|---|
| 401 | token 错或过期，重新签发 `pst-` |
| 402 | Anlas / 订阅不够 |
| timeout | 把系统代理打开，或再点一次 |
| ZIP 里没有 PNG | 服务端返回了错误 JSON，看状态栏原文 |

改完代码后：

```bash
python3 ~/.claude/skills/scripting/scripts/check_scripting.py app
```
