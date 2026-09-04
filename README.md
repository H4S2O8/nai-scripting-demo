# NAI 生图工作台（Scripting）

在 iPhone 上跑的 NovelAI 文生图客户端，用 [Scripting](https://scripting.fun) 的
TSX + SwiftUI 组件写成。目标是把 NovelAI 网页版的**基础生图页面**搬到手机上：
提示词、负面词、模型、尺寸、采样参数、Anlas 估算、结果画布和本地历史。

参数与请求体的构造参考了
[2786886095/novelai-image-desktop](https://github.com/2786886095/novelai-image-desktop)（MIT）
——那个桌面端把 payload 和官网自己的请求逐字段对过，这里直接沿用它验证过的结论。

仓库：<https://github.com/H4S2O8/nai-scripting-demo>

## 页面

竖屏手机上的四个标签页。分法不是按功能分类，是按**你多久碰一次**分的：

**生成** —— 迭代时你一直待在这一屏

结果图占掉除控件外的全部高度，点开看大图。下面是最近结果的缩略条、**三行提示词**
（艺术风格 / 人物 / 特定，各自点开进全屏编辑器）、以及一行「两次生成之间会变的
东西」：尺寸、张数、seed 锁定 / 换一个、负面词与角色入口。底部常驻 Anlas 估算和生成键。

提示词分三块，是因为它们的更换频率差一个数量级：画风和人物通常固定几十张不动，
特定 prompt 每张都在改。发送时按「艺术风格 → 人物 → 特定」拼接并去重。

**参数** —— 几次生成才碰一次

模型与质量词、11 个画幅预设与自定义宽高、Steps / Guidance / 采样器、负面词与
Undesired Content 预设，以及默认折叠的高级项（Rescale、噪声调度、Variety+、
透明背景、SMEA）。

**人物** —— V4+/V5 的独立角色描述

和「人物」提示词块不是一回事：这里是 API 的 `char_captions`，每个角色一段描述、
可选一段角色负面词，还可以钉在画面上的具体位置（关掉就是协议里的 0.5/0.5，
交给模型自己安排）。V5 最多 32 个，V4/V4.5 最多 6 个，V3 不支持。

**素材** —— 三列网格

整个会话的结果，点开回生成页查看，长按删除或复用参数（提示词、seed、尺寸、模型）。

**词库** —— Prompt Chunks，见下一节

### 提示词编辑器

竖屏手机上键盘会吃掉半屏。提示词如果是主页面里的一个输入框，等键盘弹出来，你其实
是在一条三行高的缝里打字，而且底下的 chunk 列表全被挡住。所以点提示词是**全屏打开**。

编辑器里提示词是**自由文本 + chunk 引用**交替，不是纯 tag 列表：

- 文本段就是普通输入框，逗号、整句、任意排版都行，随便改
- 从词库点进来的 chunk 保持成**一枚不可分的标签**（显示它的名字）
- **双击** chunk 展开成文本，并**和左右的文本合并成一段连续可编辑的文字**
- 长按 chunk → 展开 / 删除；长按文本段 → 存为 chunk
- 「原文」键切换成纯文本编辑（注意：切过去会把 chunk 展开，切回来不还原）

早期版本把提示词整个建模成 tag 列表，结果展开会炸成一排碎片，中间也插不进文字。

底部的 chunk 选择区**按分类折叠**，每类显示「已选/总数」，**折叠状态按块分开记住**
——艺术风格那一块你通常只展开画风分类，人物块只展开角色分类，共用一套设置两边都别扭。

chunk 是**开关**：再点一次就从提示词里取下来，和官方一致。取下来时连同「之前展开成
文本的那份」一起清掉。

**新建 / 编辑 chunk**：词库页右上角「新建」，或在提示词编辑器里长按一段文本「存为 chunk」。
可以填名称、内容、颜色、分类。改动先落本机，再用「推送到账户」同步回 NovelAI 云端
（合并只加新的，更新会覆盖同名的）。新建分类和重排顺序目前还要回网页做。

实现上，chunk 引用是内联在提示词字符串里的（用两个键盘打不出的控制字符定界，
里面同时存着名字和原文），所以提示词始终是一个普通字符串，存储和 payload 都不用改；
发送前统一展开。`dev/test_prompt.mjs` 里最要紧的一条断言就是**任何标记都不能漏进请求**。

左上角两个键：**最小化**（收起界面但脚本继续活着，从运行中脚本列表回来，状态都在）
和**关闭**。标题栏写着版本号，用来确认远程资源更新到位没有。

## 多账户

账号页可以添加任意多个账户，点一下切换。一个账户是三个必须配套的凭据：

| 凭据 | 用途 |
| --- | --- |
| `pst-` 生图 Token | 出图、查订阅 |
| 网页 `auth_token` | 词库同步（这些接口拒收 pst-） |
| `encryption_key` | 解开该账户的 keystore |

三个都存在 Keychain 里。**混用是查不出来的故障**——拿 A 的 auth_token 配 B 的
encryption_key，keystore 一个 chunk 都解不开，症状和客户端坏掉一模一样。所以它们
绑在同一个账户上一起编辑，「粘贴网页会话」一次填好后两个。

**切换账户会同时切换本机词库**。这不是锦上添花：词库如果共用，你用「镜像」推送就会
拿这个账户的词库把另一个账户的 chunk 删掉。图片历史和生成参数是共用的。

从旧版本升级时，原来那套凭据会自动迁移成第一个账户；旧的 Keychain 条目保留不删，
万一回滚旧版本还能找到。

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

手机上没有控制台，所以在**电脑浏览器**上取：登录 novelai.net → 打开开发者工具控制台
（F12 或 ⌘⌥J）→ 执行

```js
copy(sessionStorage.session || localStorage.session)
```

整段 JSON 进剪贴板，传到手机后在账号页点「粘贴网页会话」，两个一起填好。也可以分别手填。

用 `copy()` 而不是直接看输出，是因为控制台里求值会带一层外层引号；不过这种双重编码的
粘贴也能正确解开。

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

## MCP Server（电脑上用）

同一套请求构造也包成了 MCP server，Claude Code / Claude Desktop 可以直接出图：

```bash
cd mcp && npm install && npm run build
claude mcp add novelai --env NOVELAI_TOKEN=pst-你的令牌 -- node "$PWD/dist/server.mjs"
```

三个工具：`novelai_generate_image`（出图，返回路径 / seed / Anlas 估算 / 实际发送的提示词）、
`novelai_list_options`（模型、采样器、画幅预设）、`novelai_account`（订阅与额度）。
细节见 [mcp/README.md](mcp/README.md)。

手机 App 和 MCP 共用 `nai.ts` 里的 `buildPayload`——两边发出去的 payload 逐字段一致。

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
