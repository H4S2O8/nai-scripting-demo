# NAI 生图工作台（Scripting）

在 iPhone 上跑的 NovelAI 文生图客户端，用 [Scripting](https://scripting.fun) 的
TSX + SwiftUI 组件写成。目标是把 NovelAI 网页版的**基础生图页面**搬到手机上：
提示词、负面词、模型、尺寸、采样参数、Anlas 估算、结果画布和本地历史。

参数与请求体的构造参考了
[2786886095/novelai-image-desktop](https://github.com/2786886095/novelai-image-desktop)（MIT）
——那个桌面端把 payload 和官网自己的请求逐字段对过，这里直接沿用它验证过的结论。

仓库：<https://github.com/H4S2O8/nai-scripting-demo>

## 页面

单页工作台，从上到下：

| 区块 | 内容 |
| --- | --- |
| 画布 | 结果图 / 空状态；seed、尺寸、模型读数；存相册 / 分享 / 锁定 seed |
| 提示词 | 多行输入，下面显示**实际发送**的提示词（质量词合并后的结果） |
| 负面提示词 | 多行输入 + Undesired Content 四个官方预设，同样显示实际发送内容 |
| 模型 | V5 Full / Curated、V4.5、V4、V3、Furry V3；质量词 标准 / 轻量 / 关闭 |
| 尺寸 | 11 个官方画幅预设 + 自定义宽高（失焦后按 64 倍数校准，总像素 ≤ 3 MP） |
| 参数 | Steps、Prompt Guidance、采样器、Seed（可锁定 / 掷一次 / 随机）、批量 1–8 张 |
| 参数 · 高级 | Guidance Rescale、噪声调度、Variety+、透明背景、SMEA / SMEA DYN |
| 历史 | 最近 40 张缩略图，点选回看，长按删除 |
| 底栏 | 常驻的 Anlas 估算 + 余额 + 生成按钮 |

右上角头像进「账号」：粘贴 token、验证订阅、看 Anlas 与 Opus 用量、看输出目录。

参数的可用性跟着模型走：Variety+ 和噪声调度在 V5 上锁掉（官方 V5 固定 Karras），
SMEA 只在 V3 系列开放，透明背景只在 V5 开放，「轻量」质量词也只有 V5 有。

## 导入到手机

Scripting 只认**根目录就是 `script.json` 的脚本包**。不要用 GitHub 的
`Source code (zip)`——它外面还套了一层仓库名文件夹，App 会报「不支持的脚本文件」。

**方式一：点 `.scripting` 文件（推荐）**

下载仓库里的 `NAI-Studio.scripting`，用「拷贝到 Scripting」或直接点开。

**方式二：远程资源**

Scripting 里新建脚本 → 远程资源填：

```
https://github.com/H4S2O8/nai-scripting-demo/tree/main
```

必须带 `/tree/main`。改代码后要把 `script.json` 的 `version` 加一，否则手机上还是旧版。

**方式三：手动拷贝**

把这七个文件放在**同一层**，不要再套目录：

```
script.json  index.tsx  nai.ts  store.ts  theme.ts  ui.tsx  settings.tsx
```

## 用法

1. NovelAI 网页 → 齿轮 → Account → **Get Persistent API Token**，复制 `pst-` 开头的整串。
2. App 右上角头像 → 粘贴 → **验证并刷新**，确认能读到 tier 和 Anlas。
3. 写提示词，选模型和尺寸，点底部「生成图片」。默认 832×1216 / 28 步，单张 30–120 秒。
4. 出图后可存相册、分享，或锁定 seed 再微调 tag。

图片存在脚本的 `Documents/NAI-Studio/`，保留 NovelAI 写入的 PNG 元数据。
Token 存在系统 Keychain，不写进脚本文件，也只发往 `image.novelai.net`。

国内网络需要系统级代理 / VPN，和访问官网一样。

## 计费

底栏按官方前端的公式估算：

```
ceil(2.951823174884865e-6 · 像素 + 5.753298233447344e-7 · 像素 · 步数)
```

单张封顶 140 Anlas；Opus 账户在 **≤ 1 MP 且 ≤ 28 步**的文生图上免费，此时显示
「Opus 免费额度内」。生成完成后会自动刷新一次余额。

## 接口

- `GET https://image.novelai.net/user/data`（失败时回落 `/user/subscription`）
- `POST https://image.novelai.net/ai/generate-image`

请求体要点（都来自上面那个桌面端验证过的实现）：

- `params_version: 4`，V4+ 走 `v4_prompt` / `v4_negative_prompt` 结构化字段
- V5 强制 `noise_schedule: "karras"`——按采样器推导会让 DPM++ 静默变成 Exponential
- Variety+ 不是布尔字段，是 `skip_cfg_above_sigma: 58`
- 质量词与 UC 预设文本按模型分支，V5 复用 V4.5 Full / Curated 的那两套
- 批量在客户端串行发起，每次 `n_samples: 1`

响应是 ZIP，解压取第一张 PNG；网关直接回 PNG 或 JSON base64 时也能处理。

## 没做的

图生图、局部重绘、超分、Director Tools、Vibe Transfer、角色提示词与坐标、
tag 自动补全、提示词法典。这些是 NovelAI 页面的进阶功能，不属于「基础生图」。

## 开发

```bash
python3 dev/check.py .   # 静态检查：组件来源 / 漏 import / hooks 位置
./dev/pack.sh            # 重新打包 NAI-Studio.scripting
```

改完代码记得 `script.json` 的 `version` 加一。踩到的平台坑记在 `dev/NOTES.md`。

## 常见失败

| 现象 | 原因 |
| --- | --- |
| 不支持的脚本文件 | 导入了仓库 Source zip，或远程资源填了仓库首页 URL |
| 401 | token 错或过期，重新签发 `pst-` |
| 402 | Anlas 或订阅额度不足 |
| 429 | 请求太频繁，等一会儿 |
| timeout | 打开系统代理后再试 |
| 改了代码手机没变 | `script.json` 的 `version` 没加一 |
