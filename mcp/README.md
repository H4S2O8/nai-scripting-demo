# NovelAI 生图 MCP Server

把这个仓库里那套已经验证过的请求构造（`../nai.ts`）包成 MCP server。发出去的 payload
和手机 App 完全一致——质量词、UC 预设、V5 强制 Karras、Variety+ 的 sigma、人物 caption
都走同一份代码。

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
NOVELAI_TOKEN=pst-你的令牌
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
也不用为 80/443 备案。Zero Trust 后台 → Networks → Tunnels → 你的隧道 → Public Hostname
加一条，DNS 记录 Cloudflare 会自动建：

| 字段 | 隧道直连 8787 | 复用已有的 nginx |
| --- | --- | --- |
| Subdomain | `nai` | `nai` |
| Service | `HTTP` → `localhost:8787` | `HTTP` → `localhost:80` |
| 还需要 | 无 | 装 `nginx-vhost.conf` |

如果隧道已经指向 80、上面还挂着别的站点，走右边那列更省事——后台里和现有条目填一样的
service，路由交给 nginx 按 Host 分。`nginx-vhost.conf` 就是为此准备的：

```bash
sudo cp mcp/nginx-vhost.conf /etc/nginx/sites-available/novelai-mcp
sudo sed -i 's/nai\.asylum\.icu/你的域名/' /etc/nginx/sites-available/novelai-mcp
sudo ln -sf /etc/nginx/sites-available/novelai-mcp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**这个 vhost 必须写精确的 `server_name`。**很多机器上已有的站点是 `server_name _;`，
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

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `NOVELAI_TOKEN` | 必填。网页 设置 → Account → Get Persistent API Token |
| `MCP_AUTH_TOKEN` | HTTP 模式必填。客户端要带的 Bearer 密钥 |
| `NOVELAI_OUTPUT_DIR` | 图片存放目录，默认 `~/Pictures/NovelAI` |
| `NOVELAI_PUBLIC_URL` | 填了之后结果里会附带图片直链（走同一个服务的 `/images/`） |
| `NOVELAI_INLINE_IMAGES` | 设为 `0` 让 `returnImage` 默认关闭 |
| `PORT` / `HOST` | 默认 `8787` / `0.0.0.0` |

## 工具

**`novelai_generate_image`** —— 出图，存 PNG，返回路径、seed、Anlas 估算，以及**实际发送
的提示词**（质量词合并后的结果，方便核对）。

参数：`prompt`（必填）、`negative`、`model`、`width` / `height`、`steps`、`guidance`、
`sampler`、`seed`、`ucPreset`、`qualityPreset`、`count`（1–8）、`characters`、`returnImage`。

- 尺寸自动按 64 取整并限制在 3 MP 以内
- `seed` 留空或 0 表示每张随机
- `characters` 是 V4+/V5 的角色 caption；给了 `x` / `y` 就是钉位置，不给就交给模型安排
- `returnImage` 默认**开**（HTTP 部署的意义就是把图渲染进对话）。一张全尺寸 PNG 转 base64
  是 1–2 MB，走蜂窝网络要几秒。嫌慢就设 `NOVELAI_INLINE_IMAGES=0`，改用 `NOVELAI_PUBLIC_URL`
  给出的直链

**`novelai_list_options`** —— 模型、采样器、画幅预设、UC 预设、质量词预设和默认值。
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
字段、质量词和 UC 预设文本按模型分支、角色 caption 的 `centers` 数组即使不指定位置也不能为空
（否则接口直接 500）。这些都是对着官方客户端的真实请求逐字段核对出来的，仓库里有 200 多项
测试守着。
