# NovelAI 生图 MCP Server

把这个仓库里那套已经验证过的请求构造（`../nai.ts`）包成 MCP server。V5 强制 Karras、
Variety+ 的 sigma、人物 caption 的结构都和手机 App 走同一份代码。

区别只有一处：**MCP 原样发送提示词**（`verbatim`）。App 跟官方客户端一样会在末尾补质量词、
往负面里并 UC 预设；MCP 不补，最终 prompt 完全由调用它的 agent 决定。原因是 V5 会把 `Text:`
后面的东西全当成要画的字——以前 `Text: OPEN` 出来的招牌上写着「OPEN, very aesthetic,
masterpiece」。这些知识改放在 `novelai_guide` 手册里，agent 自己决定抄不抄。

两个入口：

| 入口 | 传输 | 用途 |
| --- | --- | --- |
| `dist/stdio.mjs` | stdio | 本机的 Claude Code / Claude Desktop |
| `dist/http.mjs` | Streamable HTTP | 部署到服务器，供手机等远程客户端连接 |

## 构建

```bash
cd mcp
npm install
npm run build
```

## 本机用（stdio）

```bash
claude mcp add novelai --env NOVELAI_TOKEN=pst-你的令牌 -- node /绝对路径/mcp/dist/stdio.mjs
```

## 部署到服务器（HTTP）

有 SSH 的话一条命令搞定：

```bash
./mcp/deploy.sh <ssh-host>
```

幂等，改完代码重跑即可。它会建服务用户、同步代码、构建、写 systemd unit、启动，并做健康
检查。**密钥不经过你本机**：`MCP_AUTH_TOKEN` 在服务器上生成且不打印，`NOVELAI_TOKEN`
留成占位符由你在服务器上填。服务启动时只绑 `127.0.0.1`，暴露是另一件要你明确决定的事。

下面是这个脚本做的事情，手动部署或排查时对照看。



### 1. 生成一个访问密钥

```bash
openssl rand -hex 32
```

**这个端点会花你的钱**——每次调用都消耗账户的 Anlas。所以 `MCP_AUTH_TOKEN` 是必填的，
不设置进程直接拒绝启动。没有认证的公网端点等于给所有人免费生图。

### 2. 传代码、装依赖

```bash
scp -r mcp/ nai.ts accounts.ts prompttokens.ts 你的服务器:/opt/novelai-mcp/
ssh 你的服务器
cd /opt/novelai-mcp/mcp && npm ci && npm run build
```

（`nai.ts` 会 import `accounts.ts` 和 `prompttokens.ts`，所以这三个都要带上，目录结构保持
`mcp/` 在它们旁边。）

### 3. systemd

先建一个专用的系统用户——这个服务不需要 root，而一个联网的 Node 进程更不该是 root：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin novelai-mcp
sudo mkdir -p /var/lib/novelai-mcp
sudo chown novelai-mcp:novelai-mcp /var/lib/novelai-mcp
```

`/etc/novelai-mcp.env`：

```sh
# 一个账户直接这样写；多个见下面的「多账户」
NOVELAI_TOKENS=pst-你的令牌
MCP_AUTH_TOKEN=上一步生成的随机串
NOVELAI_OUTPUT_DIR=/var/lib/novelai-mcp
NOVELAI_PUBLIC_URL=https://nai.你的域名
PORT=8787
HOST=127.0.0.1
```

```bash
sudo chown root:root /etc/novelai-mcp.env
sudo chmod 600 /etc/novelai-mcp.env
```

**归 root、0600，服务用户读不到，这是对的**：`EnvironmentFile` 是 systemd 自己（PID 1，
root）在 fork 之前读的，读完才降权启动进程。所以令牌只在 root 拥有的文件和进程环境里，
服务用户既不能打开那个文件，被入侵后也拿不到第二份。

`/etc/systemd/system/novelai-mcp.service`：

```ini
[Unit]
Description=NovelAI MCP server
After=network-online.target

[Service]
Type=simple
User=novelai-mcp
Group=novelai-mcp
WorkingDirectory=/opt/novelai-mcp/mcp
ExecStart=/usr/bin/node /opt/novelai-mcp/mcp/dist/http.mjs
Restart=on-failure
EnvironmentFile=/etc/novelai-mcp.env

# 这个服务只需要往图片目录写，别的什么都不需要
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
ReadWritePaths=/var/lib/novelai-mcp

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now novelai-mcp
curl localhost:8787/health
```

代码目录 `/opt/novelai-mcp` 保持 root 拥有、服务用户只读即可——它不需要写自己的代码：

```bash
sudo chown -R root:root /opt/novelai-mcp
```

### 4. 暴露出去（TLS）

服务本身说的是**明文 HTTP**，`HOST` 默认留在 `127.0.0.1`。公网上必须有 TLS，否则访问密钥
和你的每一条提示词都是明文过网。

**Cloudflare Tunnel（推荐，尤其是国内服务器）** —— 边缘终止 HTTPS，源站一个端口都不用开，
也不用为 80/443 备案。

**如果隧道已经指向 80，最省事的是在现有域名下开一个路径**，Cloudflare 后台一步都不用动：
把 `nginx-location.conf` 贴进那个已经在服务你域名的 server 块里（通常在 `server_name`
那行下面），端点就是 `https://你的域名/nai/mcp`。

```bash
# 插进现有 server 块，然后
sudo nginx -t && sudo systemctl reload nginx
```

两个细节不能省：

- **`location ^~ /nai/`** 的 `^~` 让它优先于同一个 server 块里的正则 location。少了它，
  站点自己的 `location ~ ^/api/...` 之类会先匹配走。
- **`proxy_pass` 末尾那个斜杠**负责把 `/nai` 前缀剥掉，`/nai/mcp` 才会变成后端的 `/mcp`。

顺带把 `NOVELAI_PUBLIC_URL` 设成 `https://你的域名/nai`，图片直链才对得上。

**或者新开子域名**（要在 Zero Trust 后台 → Networks → Tunnels → 你的隧道 → Public
Hostname 加一条，DNS 记录自动建）：

| 字段 | 隧道直连 8787 | 复用已有的 nginx |
| --- | --- | --- |
| Subdomain | `nai` | `nai` |
| Service | `HTTP` → `localhost:8787` | `HTTP` → `localhost:80` |
| 还需要 | 无 | 装 `nginx-vhost.conf` |

走右边那列时**必须写精确的 `server_name`**：很多机器上已有的站点是 `server_name _;`，
它排在前面就成了 80 端口的默认 server，会把没有精确匹配的 Host 全部吃掉——现象是你的请求
落到了别的服务上，返回一个看着莫名其妙的 404。

**关于超时**：Cloudflare 对源站有 100 秒响应超时（524）。实测确认 MCP 的 Streamable HTTP
以 `Content-Type: text/event-stream` 立刻返回响应头，所以几十秒的生成不会触发它；nginx 那边
也必须 `proxy_buffering off`，否则事件流会被缓冲到生成结束才吐出来，白白制造这个问题。

**Caddy（自己有公网端口时）**：

```
nai.你的域名 {
    reverse_proxy 127.0.0.1:8787
}
```

走反代就别让 8787 直接对公网，云厂商安全组只放 443。

### 5. 手机端连接

在 Scripting 的 MCP 设置里填：

- 端点：`https://nai.你的域名/mcp`
- 认证：`Authorization: Bearer <MCP_AUTH_TOKEN>`

密钥用这条取（不要让它出现在别处）：

```bash
ssh <host> 'grep MCP_AUTH_TOKEN /etc/novelai-mcp.env'
```

连上之后 Assistant 就能调 `novelai_generate_image`，图片默认**内联返回**，直接渲染进对话。

## 多账户

`NOVELAI_TOKENS` 里可以放多个账户，生图时**每张图单独选号**：

```
NOVELAI_TOKENS=main=pst-xxx,alt=pst-yyy,spare=pst-zzz
```

选号不是轮询。稀缺的是 **Opus 免费额度**（≤1 MP 且 ≤28 步才免费，按账户计量），
所以按这张图在**那个账户上**的实际价格来分：

| 情况 | 选谁 |
| --- | --- |
| 这张图能走免费额度 | Opus 账户里**剩余额度最多**的那个 |
| 这张图要花 Anlas | **付得起且 Anlas 最多**的那个 |
| 平手 | 在飞请求少的、已服务次数少的优先 |

一次要多张图时每张都重新选，所以 4 张会摊到池子里，而不是把一个号抽干——这才是
多账户的意义。

失败会自动换号重试，但**只针对账户本身的问题**（401、402、429）。提示词写错在哪个号上
都一样错，换号重试只会把整个池的额度烧掉，所以这类错误直接返回。

出问题的账户进冷却：令牌无效 10 分钟，额度不足 5 分钟，限流 1 分钟。

`novelai_account` 会列出池里每个账户的档位、Anlas、剩余免费额度、已服务张数和冷却状态。
**输出里没有令牌**，只有标签和一个 8 位指纹。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `NOVELAI_TOKENS` | 账户池。多个 `pst-` 令牌用逗号或换行分隔，可写成 `label=pst-xxx`。生图按剩余额度自动选号 |
| `NOVELAI_TOKEN` | 单个令牌，仍然可用，会并入同一个池。两个都不填生图必失败 |
| `MCP_AUTH_TOKEN` | HTTP 模式必填。客户端要带的 Bearer 密钥 |
| `NOVELAI_OUTPUT_DIR` | 图片存放目录，默认 `~/Pictures/NovelAI` |
| `NOVELAI_PUBLIC_URL` | 填了之后结果里会附带图片直链（走同一个服务的 `/images/`） |
| `NOVELAI_INLINE_IMAGES` | 设为 `0` 让 `returnImage` 默认关闭 |
| `PORT` / `HOST` | 默认 `8787` / `0.0.0.0` |

## 工具

**`novelai_generate_image`** —— 出图，存 PNG，返回链接、seed、扣费，以及每张图是否带 alpha
通道。`prompt`、`negative`、角色 caption 都**原样发送**：不补质量词、不并 UC 预设、不加透明
标签、不去重。

参数：`prompt`（必填）、`negative`、`model`、`width` / `height`、`steps`、`guidance`、
`sampler`、`seed`、`count`（1–8）、`characters`、`imageSize`、`previewWidth`、`returnImage`。

- 尺寸自动按 64 取整并限制在 3 MP 以内
- `seed` 留空或 0 表示每张随机
- `characters` 是 V4+/V5 的角色 caption；给了 `x` / `y` 就是钉位置，不给就交给模型安排
- `returnImage` 默认**开**（HTTP 部署的意义就是把图渲染进对话）。一张全尺寸 PNG 转 base64
  是 1–2 MB，走蜂窝网络要几秒。嫌慢就设 `NOVELAI_INLINE_IMAGES=0`，改用 `NOVELAI_PUBLIC_URL`
  给出的直链

**`novelai_guide`** —— 提示词手册（`mcp/guide.ts`）。不带 `topic` 返回目录；topic 有
`basics`、`quality`、`text`、`characters`、`transparent`、`visual-novel`、`manga`，每个都附
完整的调用示例。`quality` 里各模型的官方质量词和 UC 预设原文直接从 `nai.ts` 生成，不另存一份。
以前的五个模式工具（`novelai_illustration`、`novelai_visual_novel`、`novelai_manga_page`、
`novelai_asset_character`、`novelai_asset_item`）已删除，它们的写法都在这里。

### 工作室：项目、章节、镜头、抽卡（`mcp/studio.ts`）

项目存在服务器上，agent 和以后的网页审阅共用同一份数据。两种项目：

- **图集 gallery**：一组镜头（构思），每个镜头抽多张，好的都保留。
- **小说 novel**：按章节存原文，服务器切页（移植自 novel-illustration 的 `book.py`：引号里不拆、
  优先段落边界、每页贴近目标字数）；每页最多一个镜头，最终选中一张图。

项目里还有画风（说明和每次要带上的提示词片段，**不会自动拼进提示词**）、角色设定卡（外貌 tag、
各套服装）、排版设置，以及谁来选图：`human`（默认，agent 只能标推荐）或 `agent`。

每张抽出来的图先是「候选」，再被选中（每个镜头只有一张主图，选新的旧的退回候选）或淘汰。
图集是一条「主线」：有序的镜头，每个镜头一格，发布时按顺序每格出一张主图；主线外的镜头（定妆图、废案）保留但不发布。
镜头的状态：待写镜头 → 待抽卡 → 待选图 → 已完成。重切页时文字没变的页保留 id、镜头和图；
文字变了的页上的镜头「脱页」，镜头和图都保留，等重新挂到页上。

| 工具 | 作用 |
| --- | --- |
| `novelai_project` | list / get / create / update：设置、角色设定卡、进度 |
| `novelai_novel_text` | set（新增或替换一章原文并切页）/ resplit / pages / read |
| `novelai_shot` | 都可一次处理若干个镜头：set（`shots` 数组，写或改镜头；`shotId + pageId` 重挂脱页镜头；图集新镜头默认接主线末尾，`before`/`after`/`at` 整块插入，`offLine` 放主线外）/ get / list / order（整条主线按给的顺序重写）/ place（整块插入或挪动）/ unplace / merge（把重复镜头并进来）/ adopt |
| `novelai_draw` | 按镜头存的提示词抽 N 张（每张新 seed），返回带库 id 的缩略拼图 |
| `novelai_verdict` | favorite / unfavorite / pick / reject / reset；用户在对话里点名时带 `decidedBy: user` |
| `novelai_review` | 待办：人的意见、待选图、待抽卡、待写镜头、脱页镜头；也可留言、resolve |

数据库结构用 `PRAGMA user_version` 升级：v2 只加表加列，线上库原地升级，老图的数据不动。

### 审阅网页（`/app`，`mcp/web/` + `webapi.ts`）

给人用的审阅页，和 MCP 工具读写同一份数据：网页上选的图就是 agent 下次 `novelai_review` 看到的选择，
网页上的留言会出现在 agent 的待办里。

- 项目列表（进度、待选图、未处理意见）→ 小说按章排开页面缩略图 / 图集按镜头 → 单页：
  这页实际排出来的左图右文预览、候选网格（点哪张就用哪张预览）、选中 / 淘汰 / 恢复、给 agent 留言。
  不属于任何镜头的图单独列在项目页「其他图片」里。电脑上可用 ← → 切候选、P 选中、X 淘汰、[ ] 翻页。
- **登录**：三种任一即可，否则一律拒绝。
  - Cloudflare Access：设置 `CF_ACCESS_TEAM`（团队名）和 `CF_ACCESS_AUD`（应用的 AUD tag），服务端会
    校验 `Cf-Access-Jwt-Assertion` 的签名、受众、签发方和过期时间。
  - 在 `/app/login` 登录一次，换一个 90 天的签名 cookie（HttpOnly、Secure、SameSite=Strict）。
    设置了 `NOVELAI_WEB_PASSWORD_HASH` 时用网页密码登录，没设置时用 `MCP_AUTH_TOKEN`。
    同一地址 10 分钟内错 10 次会被锁。改密码（只存 scrypt 哈希，密码从 stdin 读，不进命令行）：
    `printf '%s' '新密码' | ssh HK 'cd /opt/novelai-mcp/mcp && node dist/webpass.mjs && systemctl restart novelai-mcp'`。
    改完所有已登录的网页会话都会失效；MCP 客户端不受影响。
  - `Authorization: Bearer <MCP_AUTH_TOKEN>`，给脚本用。
- 所有写接口要带 `x-nai-app: 1` 请求头（防 CSRF）。
- **缩略图在 R2 上**：一张图第一次被看到时生成 512px JPEG，上传到 `<前缀>-thumbs/`，把链接记进库，之后
  `/api/thumb/<id>` 直接 302 到 CDN。HK 不转发缩略图流量。没配 R2 的部署（本地预览）直接返回 JPEG；
  配了 R2 但上传失败就报错。
- 排版预览由服务端用 `novelai_compose_page` 同一套引擎渲染，缓存在 `$NOVELAI_OUTPUT_DIR/cache`（上限 150MB）。
- 前端是 Preact，`npm run build` 一起打包成 `dist/web/app.js`。`mcp/tsconfig.json` 固定了 JSX 设置，
  否则 esbuild 会往上找到别处的 tsconfig。

### 图库（`mcp/library.ts`）

每张生成的图都会入库，记录完整参数（prompt、负面、角色 caption 和坐标、模型、尺寸、步数、
guidance、采样器、seed）、透明像素占比、账户和花费。`novelai_generate_image` 可以带
`project` 和 `tags`，入库时直接归档；回执里有图片的库 id（`#123`）。

| 工具 | 作用 |
| --- | --- |
| `novelai_library_search` | 按项目 / 未归项目 / 标签（全部命中）/ prompt 文本 / 模型 / 存储位置 / 时间筛选，新的在前 |
| `novelai_library_get` | 完整记录，外加 `regenerate`：能原样复现这张图的生成参数 |
| `novelai_library_update` | 批量改项目、加删标签、写备注；全部成功或全部不改 |

没有删图的工具。

- 数据库是 SQLite（better-sqlite3），默认 `$NOVELAI_OUTPUT_DIR/library.db`，可用
  `NOVELAI_LIBRARY_DB` 改位置。
- 项目和标签只存在库里，不进 R2 的 key：key 不可变，发出去的链接改归档后也不会失效。
- `stored` 三种：`r2`（有公开链接）、`local`（R2 上传失败，只在服务器磁盘，会被清理）、
  `archive`（R2 上已删除，只在 Mac 备份 `~/Backups/r2/socialsight-previews/<key>`）。

**补录旧图**（`backfill.ts`）：NovelAI 把完整请求写在每张 PNG 的 `Comment` 文本块里。

```bash
node mcp/dist/backfill.mjs extract ~/Backups/r2/socialsight-previews > records.jsonl   # Mac
scp records.jsonl HK:/tmp/ && ssh HK 'set -a; . /etc/novelai-mcp.env; cd /opt/novelai-mcp/mcp && node dist/backfill.mjs import /tmp/records.jsonl'
```

import 会列一遍 bucket，还在线上的记为 `r2`、其余记为 `archive`；已入库的 key 跳过，可重复跑。

**每晚备份**（`backup.ts`）：在线备份数据库，gzip 后传到**私有** bucket，按星期几和月份命名
（保留最近 7 天 + 每月一份，不删任何东西）。图片 bucket 是公开的，库里又有全部 prompt，所以
备份必须用单独的 bucket 和只授权它的 token：`R2_BACKUP_BUCKET`、`R2_BACKUP_ACCESS_KEY_ID`、
`R2_BACKUP_SECRET_ACCESS_KEY`，缺一个就报错退出。

### 左图右文（`mcp/page.ts`）

**`novelai_compose_page`** —— 参数是左侧图片的链接和右侧文字的原文，合成一页「左图右文」的
PNG，默认黑底白字。可选 `background` / `textColor`（#rgb 或 #rrggbb）、`title`（页眉）、
`pageNumber`（页脚）、`continued`（首段接上一页，不缩进）、`indent`。

- 图片按原尺寸放在左边，右边是思源黑体 DemiLight（Noto Sans SC，比 Regular 细一档，深底浅字不显粗）的文字栏。每行原文是一段，首行缩进
  两字；粘贴来的全角空格缩进会先去掉，避免缩进两次。
- 排版规则来自 novel-illustration skill：句读不出现在行首（悬挂到上一行末），开引号、开括号
  不出现在行尾，末行只剩一个字时从上一行拉一个下来，略短的行两端对齐。
- 自适应，面向手机、平板阅读：整页在屏幕上会按宽度缩放，所以真正决定看起来大小的是
  「字号 ÷ 整页宽度」，排版就把这个比值做到最大。约束是文字栏不宽于图片、每行 14–30 字；
  每个字号取能放下全文的最窄文字栏，再在各字号里挑比值最高的（并列取大字号）。结果是字少时
  字大、栏窄，字多时字号降下来，但整页不会因为文字多而变宽。字号范围是页高的 26/1216 到
  60/1216；最小字号也放不下时才收紧行距（1.9 → 1.75 → 1.6）。仍放不下就报错，并估算这张图
  一页大约能放多少字，不会截断，也不会加宽页面。竖图 832×1216 一页约 390 字。
- 图片只从公网 http(s) 下载：解析到内网、回环、链路本地地址的链接和跳转一律拒绝，上限 30MB。
- 成品上传到 R2 的 `nai-pages/`，不进 `nai/`（图库补录只认 NovelAI 原图）。
- 字体 8.3MB 不进仓库，由 `mcp/fetch-font.sh` 按固定版本下载并校验 SHA-256，`deploy.sh` 会在
  服务器上自动运行。缺字体时直接报错，不会换成别的字体。

**`novelai_list_options`** —— 模型、采样器、画幅预设和默认值。
让模型先查一次，好过把所有合法值塞进参数描述里。

**`novelai_account`** —— 等级、Anlas 余额、Opus 剩余额度。

## 两个令牌，别搞混

| | 在哪 | 谁能看到 | 泄露了怎么办 |
| --- | --- | --- | --- |
| `NOVELAI_TOKEN`（`pst-`） | 只在服务器的 `/etc/novelai-mcp.env` | 只有 root 和服务进程 | 去 NovelAI 网页重新签发，旧的立即作废 |
| `MCP_AUTH_TOKEN` | 服务器 + 手机的 MCP 配置 | 你和手机 | 换一个随机串，两边同时改，不用动 NovelAI |

**手机永远拿不到你的 NovelAI 令牌**，它只有一把通往你自己服务器的钥匙。所以手机丢了、
或者密钥不小心贴到什么地方了，换 `MCP_AUTH_TOKEN` 就行，NovelAI 那边完全不受影响。

手机 App 里那份 `pst-` 令牌（存在 Keychain 里、直连 NovelAI 出图用的）和这套是两回事，
互不影响，可以是同一个也可以是两个不同的。

## 安全

- 服务以专用系统用户运行，不是 root
- `NOVELAI_TOKEN` 在 root 拥有的 0600 文件里，由 systemd 在降权前读取，服务用户读不到
- `MCP_AUTH_TOKEN` 用常数时间比较，避免逐字节猜测
- `/images/` 也要认证，路径用 `basename()` 兜底，穿越不出目录
- `/health` 不需要认证，只回 `{"ok":true}`，不泄露任何信息
- 每个 POST 用独立的 server + transport（stateless），并发请求不会串流

## 测试

```bash
npm test
```

30 项：ZIP 解包拿系统 `zip` 生成的真实归档验（deflate 和 stored 两种）；stdio 和 HTTP 两条
传输都用真的 MCP client 连上去跑；认证部分覆盖无密钥启动、缺 token、错 token、等长错 token、
路径穿越、并发。**不需要 NovelAI 令牌，也不会花 Anlas**——生成那一步验的是「没有凭据时必须
给出清楚的报错」。

## 为什么不直接调 API

`buildPayload` 里有一堆不查就会错的东西：V5 必须强制 `noise_schedule: "karras"`（按采样器
推导会让 DPM++ 静默变成 Exponential）、Variety+ 是 `skip_cfg_above_sigma: 58` 而不是布尔
字段、角色 caption 的 `centers` 数组即使不指定位置也不能为空
（否则接口直接 500）。这些都是对着官方客户端的真实请求逐字段核对出来的，仓库里有 200 多项
测试守着。
