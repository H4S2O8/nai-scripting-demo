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
| Chunks | 提示词卡片上的一行常用 chunk，点一下追加到提示词；右上角进完整的 Chunks 页 |
| 底栏 | 常驻的 Anlas 估算 + 余额 + 生成按钮 |

右上角头像进「账号」：粘贴 token、验证订阅、看 Anlas 与 Opus 用量、看版本号与输出目录。
右上角格子图标进「Prompt Chunks」，见下一节。

页面是全屏呈现的，左上角两个键：**最小化**（收起界面但脚本继续活着，可以从运行中脚本
列表回来，状态都还在）和**关闭**（真正退出）。标题栏上写着版本号，用来确认远程资源
有没有更新到位。

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
script.json  index.tsx  nai.ts  store.ts  theme.ts  ui.tsx
settings.tsx  chunks.ts  chunkspage.tsx  nacl.ts  blake2b.ts
```

## 用法

1. NovelAI 网页 → 齿轮 → Account → **Get Persistent API Token**，复制 `pst-` 开头的整串。
2. App 右上角头像 → 粘贴 → **验证并刷新**，确认能读到 tier 和 Anlas。
3. 写提示词，选模型和尺寸，点底部「生成图片」。默认 832×1216 / 28 步，单张 30–120 秒。
4. 出图后可存相册、分享，或锁定 seed 再微调 tag。

图片存在脚本的 `Documents/NAI-Studio/`，保留 NovelAI 写入的 PNG 元数据。
存相册时会把生成时间写进 EXIF/TIFF 再交给「照片」——NovelAI 的 PNG 不带日期字段，
不补的话每张都会落在 1970-01-01。补日期只作用于送进相册的临时副本，归档的原图
不动，免得重编码丢掉 NovelAI 的参数。
Token 存在系统 Keychain，不写进脚本文件，也只发往 `image.novelai.net`。

国内网络需要系统级代理 / VPN，和访问官网一样。

## Prompt Chunks 同步

NovelAI 的 Prompt Chunks（服务端叫 image prompt macro）在这里可以拉取、浏览、
一键插进提示词，也能在账户之间同步、和油猴脚本互导。

协议来自
[novelai-prompt-chunks-sync.user.js](https://github.com/H4S2O8/nai-scripting-demo)
的逆向结论：每个 chunk / 分类各是 `/user/objects/promptmacros` 下的一个对象，
`data = base64(magic[16] + nonce[24] + XSalsa20-Poly1305 密文)`，密钥来自
`/user/keystore`，而 keystore 本身用 `BLAKE2b-256(encryption_key)` 加密。

### 需要网页会话，不能用 pst- Token

生图用的 `pst-` 持久令牌在这些接口上**会被直接拒绝**：

```
usage of persistent access tokens is not allowed for this endpoint
```

所以 Chunks 用的是网页登录会话里的 `auth_token`；`encryption_key` 更是只在登录时
派生，任何 token 里都没有。两者都在同一个对象里，所以直接整个粘：

在 novelai.net 的浏览器控制台执行 `localStorage.session`，复制整段 JSON，
回 App 点 Chunks 页的「粘贴网页会话」——`auth_token` 和 `encryption_key` 会一起填好。
也可以分别手填。

两者都只留在本机 Keychain。`encryption_key` 不出设备，只用于本地解开 keystore；
发到 NovelAI 的始终只有加密后的密文。

### 三种推送模式

| 模式 | 行为 |
| --- | --- |
| 合并 | 只新增账户里没有的 chunk（按 chunk id 判断），不动已有的 |
| 更新 | 新增 + 用本地内容覆盖同 id 的 |
| 镜像 | 更新 + **删除**账户里本地没有的，不可撤销，会先弹确认 |

根分类的排序表始终是**合并**而不是覆盖，否则会把目标账户里本地没有的 chunk 从
排序里挤掉。推送前会先把新密钥写进 keystore 并保存，避免中途失败留下解不开的对象。

### 文件互导

「导出 JSON」写到 `Documents/NAI-Studio/` 并拉起分享面板；「导入文件 / 粘贴导入」
接受油猴脚本导出的 `novelai-prompt-chunks` 文件，也接受裸的 chunk 数组。两边是同一种格式。

### 密码学实现

Scripting 的 `Crypto` 只有 SHA / HMAC / AES-GCM，没有 BLAKE2b 和 XSalsa20-Poly1305，
平台也没有包管理器，所以：

- `nacl.ts`：tweetnacl-js 1.0.3 的 secretbox 子集（public domain），逐字节比对过
- `blake2b.ts`：RFC 7693 参考实现，对过官方测试向量
- `inflate.ts`：raw DEFLATE 解码器（tinf 算法，zlib 许可）。**不能用平台的
  `Data.decompressed("zlib")`**——Apple 文档说 COMPRESSION_ZLIB 就是 raw DEFLATE，
  但真机实测不是，而账户里已有的 chunk 全是压缩的，这一步交给平台等于一个都读不了。
  写入方向仍然可选：格式允许不压缩，所以平台编码器能不能用，是**拿我们自己的解码器
  去验它的输出**决定的——自压自解的探针即使格式不对也会通过。

`dev/test_inflate.mjs` 拿 node 的 zlib 对拷：各压缩等级、存储块、重叠回溯、
壁纸级大输入，外加 2000 组随机负载。

`dev/test_chunks.mjs` 会用 tweetnacl + node zlib 复现油猴脚本的编解码，双向对拷，
确认线格式一致。

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

Chunks 目前只做同步与插入，不能在 App 内新建 / 改名 / 重排 chunk——那些回网页做。

## 开发

```bash
./dev/test.sh            # 静态检查 + 密码学 + 协议互导，全部离线可跑
python3 dev/check.py .   # 只跑静态检查：组件来源 / 漏 import / hooks 位置
node dev/test_crypto.mjs # BLAKE2b 与 secretbox 对比参考实现
node dev/test_chunks.mjs # chunk / keystore 编解码与油猴脚本互导
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
| Chunks 报 keystore 解密失败 | `encryption_key` 不对，重新从网页会话复制 |
| Chunks 提示 persistent access tokens not allowed | 填的是 `pst-` token，换成网页会话的 `auth_token` |
| Chunks 全部对象无法解密 | 看日志里跟在后面的那几行——会指出是 keystore 空、密钥对不上 meta（两个凭据来自不同账户）、密钥形状异常，还是 `encryption_key` 不对。v2.3.0 之前是解压不了，升级即可 |
| Chunks 拉取 401 | `auth_token` 过期了，重新复制一次 `localStorage.session` |
