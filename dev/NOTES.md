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
| `contextMenu.menuItems` 需要 `Group` 包裹 | 历史缩略图的删除菜单包在 `<Group>` 里 |

### 全局对象 vs 需要 import

`FileManager` / `Data` / `Keychain` / `Storage` / `fetch` / `console` 是全局，不用导入。
`Navigation` / `Script` 必须从 `"scripting"` 导入，漏掉会在跑到那一行时抛
`ReferenceError`；如果发生在 `Navigation.present` 之前，症状就是前台一片空白。

`Photos` 和 `ShareSheet` **按官方文档示例当全局用**（文档的 ShareSheet 示例里
确实没有 import 它们）。这一条没在真机上验证过——如果「存相册 / 分享」点了没反应，
先确认这两个是不是需要显式 import。相关调用都包了 `try/catch` 并 toast 报错，
所以最坏情况是弹一条错误提示，不会白屏。

## 尺寸校准的时机

宽高输入**只在失焦或提交时**才 snap 到 64 的倍数。逐键校准会把用户正在输入的
「10」直接变成「0」，没法继续打字。这是官方桌面端也踩过的点。

## 计费口径

`estimateAnlas` 是官方前端公式的移植，不是官方接口返回的报价。Opus 免费判定
（≤ 1 MP 且 ≤ 28 步）依赖 `/user/data` 读到的 tier，读不到时按付费显示——
宁可高估也不要让用户以为免费。

## 发版

1. `python3 dev/check.py .`
2. `script.json` 的 `version` 加一
3. `./dev/pack.sh`
4. 推送；手机等一个 `autoUpdateInterval`（600 秒）
