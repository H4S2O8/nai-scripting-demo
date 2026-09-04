# NAI 生图 Demo（Scripting）

最小 NovelAI 客户端：Keychain 存 `pst-` token，调用官方 `image.novelai.net` 文生图，解 ZIP 后显示 PNG。

只覆盖接入和出图，没有反推、法典、图生图、批量。

仓库：https://github.com/H4S2O8/nai-scripting-demo

## 导入到手机（重要）

Scripting 只认 **根目录有 `script.json` + `index.tsx` 的脚本包**。  
不要用 GitHub 的 `Source code (zip)` 直接打开——那个 zip 外面还套了一层文件夹，App 会报 **「不支持的脚本文件」**。

任选一种：

### 1. 点 `.scripting` 文件（推荐）

下载 Release / 仓库里的 `NAI-Generate-Demo.scripting`，用「拷贝到 Scripting」或直接点开。  
这是标准脚本包（zip 根上就是 `script.json`）。

### 2. GitHub 远程资源

在 Scripting 里新建脚本 → 远程资源填：

```
https://github.com/H4S2O8/nai-scripting-demo/tree/main
```

必须带 `/tree/main`，不要填仓库首页 URL。

### 3. 手动拷文件

把 `script.json`、`index.tsx`、`nai.ts` **三个文件放在同一层**，不要再套 `app/` 文件夹。

改代码后把 `script.json` 的 `version` 加一，否则手机可能还跑旧版。

## 用法

1. NovelAI 网页 → 齿轮 → Account → **Get Persistent API Token**，复制 `pst-` 开头的整串。
2. 贴进 Token → 保存 Token（进本机 Keychain，不写进脚本）。
3. 可选：检查订阅，确认 200 而不是 401。
4. 选 V5 Full / V5 Curated / V4.5 Full，点生成。默认 832×1216、23 step，大约 30–120 秒。
5. 成功后页面显示 PNG，文件在脚本 Documents 下的 `NAI-Demo/`。

国内需要系统 VPN，和官网一样。

## 接口

- `GET https://image.novelai.net/user/subscription`
- `POST https://image.novelai.net/ai/generate-image`  
  V5 请求体带 `v4_prompt`、`params_version: 4`，和网页同一条官方 API。

## 常见失败

| 现象 | 原因 |
|---|---|
| 不支持的脚本文件 | 导入了仓库 Source zip / 填了仓库首页 URL，见上面「导入」 |
| 401 | token 错或过期，重新签发 `pst-` |
| 402 | Anlas / 订阅不够 |
| timeout | 打开系统代理后再点一次 |
