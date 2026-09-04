# 开发手记

## 平台约束（决定了这份代码为什么长这样）

Scripting 的失败模式是**静默**：写错的写法不报错，只是界面不动或一片空白。
所以这里的每个 API 都先在
`https://scriptingapp.github.io/llms-full.txt` 里查过示例再写。

### 已经绕开的坑

| 坑 | 这里的做法 |
| --- | --- |
| `RoundedRectangle` / `ProgressView` 上直接挂 `padding` 不生效 | 卡片一律是「`VStack`/`HStack` 带 `padding` + `background={<RoundedRectangle/>}`」，形状本身不带修饰符 |
| `VStack` / `HStack` 上 `shadow` 不生效 | 不用阴影，卡片边界靠 `RoundedRectangle` 的 `stroke` 描边 |
| `overlay={cond ? <X/> : undefined}` 不生效 | `overlay` 只用于常驻内容（空画布的占位文案）；条件内容放进 stack 的 children |
| `setInterval` 回调里的 `setState` 不触发重渲染 | 全程没有定时器；进度靠 await 之间的 `setState` 推进 |
| 主界面 present 之后 `Dialog.prompt` 静默失败 | 所有输入都是页面内的 `TextField`，反馈走 `toast` 修饰符 |
| Hooks 出现在提前 `return` 之后会卡住渲染 | `MainView` 没有提前 return，所有 hooks 在函数顶部 |
| `useState(fn)` 的惰性初始化未经验证 | 初始参数在模块顶层读一次（`INITIAL_PARAMS`），不依赖惰性初始化 |
| `contextMenu.menuItems` 需要 `Group` 包裹 | 历史缩略图的删除菜单包在 `<Group>` 里；alert 的多个按钮同理 |
| JSX fragment `<>...</>` 未经验证 | 需要多个子节点的地方一律用 `<Group>` |

### 全局对象 vs 需要 import

`FileManager` / `Data` / `Keychain` / `Storage` / `fetch` / `console` 是全局，不用导入。
`Navigation` / `Script` 必须从 `"scripting"` 导入，漏掉会在跑到那一行时抛
`ReferenceError`；如果发生在 `Navigation.present` 之前，症状就是前台一片空白。

`Photos` 和 `ShareSheet` **按官方文档示例当全局用**（文档的 ShareSheet 示例里
确实没有 import 它们）。这一条没在真机上验证过——如果「存相册 / 分享」点了没反应，
先确认这两个是不是需要显式 import。相关调用都包了 `try/catch` 并 toast 报错，
所以最坏情况是弹一条错误提示，不会白屏。

## Chunks：没有包管理器时怎么保证密码学是对的

平台没有 npm，`Crypto` 也只有 SHA / HMAC / AES-GCM，所以 secretbox 和 BLAKE2b
只能自己带。自己带的密码学如果错了，症状是「解密失败」或者更糟——往用户的
NovelAI 账户里写进解不开的对象。所以这一层不靠读代码判断对错，靠对拷：

- `dev/test_crypto.mjs`：把 `nacl.ts` 和真的 tweetnacl@1.0.3 放一起跑同样的输入，
  比对密文字节；BLAKE2b 对 RFC 7693 的向量。
- `dev/test_chunks.mjs`：在 node 里给 Scripting 的全局对象（`Data` / `Crypto` /
  `UUID` / `Storage` / `Keychain`）搭壳，然后用 tweetnacl + node zlib 复现油猴脚本
  的编解码，双向对拷 chunk 与 keystore。油猴脚本是对着真服务跑通过的，所以和它
  逐字节一致，就是我们在没有账户的情况下能拿到的最强证据。

改这两个文件之后必须跑 `./dev/test.sh`。

## Data.decompressed("zlib") 不是 raw DEFLATE（真机实测）

Apple 的文档说 COMPRESSION_ZLIB 编解的就是 raw DEFLATE，很多人也是这么用的。
**真机上不成立**：探针没通过，账户里 153 个 chunk 全部解不开。

所以 `inflate.ts` 自带解码器（tinf 算法），读取完全不走平台。写入方向反过来——
用我们自己的解码器去验平台编码器的输出，能对上才写压缩，对不上就写未压缩
（格式允许）。自压自解的探针在这里毫无价值：格式错了它照样通过。

这条是「探针要能证伪」的最好例子——第一版探针解的是一段真 raw-DEFLATE 编码器
产出的固定样本，所以它**没有**放过这个问题，直接把断点指了出来，而不是让我们
往用户账户里写一堆读不回来的对象。

## 旧：压缩格式那一条为什么要在运行时验

NovelAI 用 raw DEFLATE（fflate）。Apple 的 compression 框架把 raw DEFLATE 叫
`zlib`，所以 `Data.compressed("zlib")` 理论上就是我们要的东西——但「理论上」在这个
平台上就是踩坑的开始，而且这个坑是静默的：自己压自己解永远能通过，写出去的对象
NovelAI 却读不了。

所以探针不是自压自解，而是**解一段由真 raw-DEFLATE 编码器产出的固定样本**
（`PROBE_RAW_DEFLATE_B64`）。解得出来才认为可用；解不出来就退回写未压缩——格式本身
允许不带 magic 头。Chunks 页的「自检」按钮会显示当前走的是哪条路。

这是「诊断代码本身要先被验证」那条纪律的直接应用。

## encryption_key 为什么必须让用户粘

它不在 API Token 里，是网页登录时由密码派生出来的。App 拿不到，也不该去拿。
它存 Keychain，只在本地被 BLAKE2b 哈希后用于解 keystore，不出设备。

## 尺寸校准的时机

宽高输入**只在失焦或提交时**才 snap 到 64 的倍数。逐键校准会把用户正在输入的
「10」直接变成「0」，没法继续打字。这是官方桌面端也踩过的点。

## 计费口径

`estimateAnlas` 是官方前端公式的移植，不是官方接口返回的报价。Opus 免费判定
（≤ 1 MP 且 ≤ 28 步）依赖 `/user/data` 读到的 tier，读不到时按付费显示——
宁可高估也不要让用户以为免费。

## 存相册的日期

NovelAI 的 PNG 没有日期字段，`Photos.savePhoto` 拿到这样的容器会把资产日期落到
1970-01-01。修法是先用 `ImageIO.writeImage({ source, to, metadata })` 把
`exif.DateTimeOriginal` / `tiff.DateTime` / `OffsetTime*` 写进一个**临时副本**，
把副本交给「照片」，然后删掉。

不直接改归档原图：`ImageIO` 重新编码是否原样搬运 PNG 的 tEXt 块没验证过，而
NovelAI 的生成参数就存在 tEXt 里。写失败时回落到原图直传——日期错了总比存不进去好。

## 多账户：词库必须跟着账户走

三个凭据混用是**不可诊断**的故障：A 的 auth_token 配 B 的 encryption_key，keystore
解不开任何 chunk，看起来和客户端坏了一模一样。所以它们绑成一个 slot 一起存、一起编辑。

更要命的是词库。如果本机词库全局共用，切到 B 账户后用「镜像」推送，会拿着 A 的词库
去覆盖 B——**直接删掉 B 的 chunk**。所以缓存键带账户 id（`chunks.ts` 的 `cacheKey()`）。
`dev/test_accounts.mjs` 里专门有一组断言盯着这个。

迁移旧的单账户安装时，legacy Keychain 条目**保留不删**：万一用户回滚到旧版本，
旧代码还能找到自己的 token。

## 编辑器的 draft 存 token 数组，不存字符串

一开始每次按键都 `serializePrompt(setText(...))` 再 parse 回来。serialize 会 trim
并去掉末尾逗号，于是你打「1girl, 」时逗号被实时吞掉，根本没法接着输入下一个 tag。

现在 draft 就是 `PromptToken[]`，只在提交时序列化一次。相应地 toggle / state 判定
都要有 token 版本（`toggleChunkIn` / `chunkStateIn`），字符串版本只是包装。

## 提示词不要整个建模成 tag 列表

第一版把文本也按逗号切成一个个 tag token。后果：展开一个 chunk 会炸成一排碎片，
碎片之间插不进文字，也表达不了「不是 tag 形状」的提示词。

正确的模型是**自由文本段 + chunk 引用交替**：文本段是一整段随便编辑的文字，chunk
是不可分的一枚。展开 = 换成文本并和左右文本段合并（`mergeAdjacentText`），删除同理，
这样接缝会自动闭合。

## 逐文件编译发现不了「导出被删掉」

改 `chunks.ts` 时，一次范围替换把 `parseSession` 连带删了，而 `settings.tsx` 还在
import 它——**运行时点按钮才会炸**。逐个文件跑 esbuild 不会报，因为不 bundle 就不解析
import。

`dev/test.sh` 现在多一步：`esbuild index.tsx --bundle --external:scripting`，
把整棵依赖树解析一遍。

## 同一份状态不要存两份

`ChunksPage` 原本自己存了一份 `cache`，root 也存了一份 `chunks`，提示词编辑器用的是
root 那份。在词库还是 sheet 的时候，关闭时 root 会重新读，掩盖了问题；改成标签页之后
没有关闭事件，于是「在词库页拉取完，人物栏的 tag 库还是空的」。

这和下面那条陈旧状态其实是同一个病：**一份数据有两个来源**。修法不是加刷新回调，
是把重复的那份删掉——页面接 props，root 是唯一持有者。

## sheet / fullScreenCover 的内容不会在两次呈现之间重建

实测踩到：`useState(value)` 只在首次挂载取初值，而模态内容的组件在关闭后并没有被
拆掉。于是打开「艺术风格」编辑、关闭、再打开「人物」，编辑器里还是上一次的草稿——
点完成就把艺术风格的内容写进了人物块。**这是会改坏用户数据的一类 bug，不只是显示错。**

不要指望「换了 target 就会重新挂载」。凡是从 prop 取初值的 state，都要显式重置：

- `PromptEditor`：`editorKey`（target id + 每次打开自增的计数）驱动 `useEffect` 重置，
  计数保证「取消编辑后再打开同一个字段」也是干净的
- `AccountSheet`：draft 跟随 token
- `ParamsTab`：宽高输入框跟随 params（这个 tab 常驻，复用参数改了尺寸它不会自己更新）

排查同类问题的方法：grep `useState(<某个 prop>)`。

## 提示词里的 chunk 引用为什么内联在字符串里

chunk 放进提示词要保持成一枚标签，那提示词就得携带这个引用。两条路：

1. 提示词改成结构化的 token 数组
2. 引用编码进字符串本身

选了 2。存储、payload 构造、`mergePrompt` 的去重，全都已经把提示词当普通字符串处理，
再并行维护一份结构就会不同步——而不同步的症状是「界面显示的和发出去的不一样」，
在这个平台上还没有报错。

定界用 U+0001 / U+0002：键盘打不出来，不可能和真实 tag 撞。标记里同时存名字和原文，
所以 chunk 被改名或删掉之后，老提示词照样能正确展开。

一个必须守住的顺序：**展开要在 `mergePrompt` 之前**。`mergePrompt` 按逗号切分去重，
而 chunk 的原文里就有逗号——先合并会把标记撕碎。

## 为什么是五个标签页

第一版把 7 张卡片堆在一根滚动条上，那是桌面布局。竖屏手机上它有两个硬伤：

1. 改 steps 要滑过提示词 / 负面 / 模型 / 尺寸，看结果又要滑回顶部——而这正是
   迭代循环里最高频的两个动作。
2. 「看图」和「写提示词」占掉 90% 的时间，但它们对布局的要求正好相反：一个要
   满屏留白，一个要满屏键盘空间。挤在同一屏里，两个都残废。

所以拆分标准不是功能分类，是**触碰频率**：每次都碰的留在生成页（结果图 + 一行
控件），几次碰一次的进参数页，浏览类的进素材页。提示词单独全屏，因为键盘一弹
就没有别的东西该和它抢空间了。

同一条标准也解释了提示词为什么拆成艺术风格 / 人物 / 特定三块：画风和人物通常
几十张不动，特定 prompt 每张都改。分开之后各自的 chunk 折叠记忆也要分开存，
否则在画风块里展开的分类，到人物块里全是错的。

模态修饰符（sheet / fullScreenCover / toast）挂在包住 TabView 的 VStack 上，不
挂在 TabView 自己身上——stack 带这些修饰符是文档里有用例的组合，而这个平台上
没接线的修饰符是静默失效，不会报错。

## 全屏呈现与最小化

`Navigation.present` 默认是抽屉（sheet）。改成 `modalPresentationStyle: "fullScreen"`
之后没有下滑关闭手势了，所以**必须**自己提供关闭入口，否则用户被困在里面：
左上角是「最小化」（`Script.minimize()`，实例继续活着，`Script.onResume` 里刷新
历史和 chunk 缓存）和「关闭」（`Navigation.useDismiss()`，present 的 promise 兑现后
走到 `Script.exit()`）。

`Script.supportsMinimization()` 在模块顶层探一次，不支持时只渲染关闭键。

## 检查器自身也要被测

`check.py` 的 Hooks 规则原本按缩进认「提前 return」，结果把 `useEffect` 的 cleanup
return 判成违规。改成按花括号深度算之后，第一版**静默失效了**——`_body_start` 取了
第一个 `{`，而 `function View({ items }: Props)` 的解构参数里就有一个，深度在参数
列表结束时就归零，整条规则再也不会触发。

放松过的检查如果不再抓得住原来的 bug，比没有检查更糟：它会给你一个"通过"的假象。
所以有了 `dev/test_check.sh`，两个方向都断言：真的提前 return 必须报，cleanup
return / 回调里的 return / 字符串里的花括号（UC 预设里就有 `{bad}`）必须不报。

## 发版

1. `python3 dev/check.py .`
2. `script.json` 的 `version` 加一
3. `./dev/pack.sh`
4. 推送；手机等一个 `autoUpdateInterval`（600 秒）
