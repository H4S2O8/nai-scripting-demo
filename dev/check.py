#!/usr/bin/env python3
"""Scripting 项目静态检查。

esbuild / tsc 只查语法，抓不到这个平台最常见的四类错误 —— 它们全都在运行时
才暴露，而且症状极不直观（白屏、界面卡住、什么都没发生）：

  1. JSX 引用了不存在的组件           -> 运行到该处白屏
  2. 用了 Navigation./Dialog./Widget. 却忘了从 "scripting" 导入
                                      -> ReferenceError；若在 present 之前，前台一片空白
  3. Hooks 出现在提前 return 之后      -> 界面卡在上一次成功渲染的状态
  4. 已知会静默失效的写法（黑名单）    -> 不报错，就是不生效

用法：
    python3 check_scripting.py [项目目录]      # 默认当前目录

黑名单是项目资产：踩到新坑就往 RISKY 里加一条，让它以后自动拦。
若某条在新版文档里已经有了用例，删掉它并在 commit message 里说明。
"""
import re
import sys
import pathlib

# Scripting 提供的全局对象（不需要 import）。缺了会误报，按需补。
GLOBALS = {
    "SQLite", "FileManager", "DateComponents", "CalendarNotificationTrigger",
    "TimeIntervalNotificationTrigger", "LocationNotificationTrigger", "Animation",
    "Data", "console", "JSON", "Math", "Date", "Number", "String", "Object", "Array",
    "Promise", "Set", "Map", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "LanguageModelSession", "Crypto", "UUID", "fetch", "Response", "Headers",
    "AbortController", "AbortSignal", "TextDecoder", "TextEncoder", "URL", "Symbol",
    "AVPlayer", "SharedAudioSession", "MediaPlayer", "UIImage", "Device", "Keychain",
    "Storage", "Clipboard", "Location", "Calendar", "Reminder", "Contact", "Photos",
    "QuickLook", "ShareSheet", "SafariView", "WebView", "HttpServer", "Bluetooth",
}

# 必须从 "scripting" 显式导入的模块对象。漏掉不是语法错，只在运行到那一行才炸。
MUST_IMPORT = ["Path", "Script", "Navigation", "Notification", "Widget", "Dialog",
               "Intent", "AppIntent", "CustomKeyboard", "LiveActivity", "Assistant"]

# 文档零用例 / 实测静默失效的写法。见 references/pitfalls.md §2。
RISKY = [
    (r'<RoundedRectangle[^>]*padding=',
     "RoundedRectangle 直接带 padding（实测不生效，套一层 HStack）"),
    (r'<ProgressView[^>]*padding=',
     "ProgressView 直接带 padding（实测不生效，套一层 HStack）"),
    (r'<(VStack|HStack|ZStack)[^>]*shadow=',
     "容器上用 shadow（文档唯一用例在 Text 上）"),
    (r'overlay=\{[^}]*undefined',
     "overlay 传 undefined（实测不生效，请常驻渲染 + opacity 控制）"),
    (r'DragGesture\s*\(',
     "DragGesture() 链式构造（实测完全不动，请用 onDragGesture 属性形式）"),
    (r'(simultaneous|highPriority)Gesture=',
     "simultaneous/highPriorityGesture 配 DragGesture（实测失效）"),
    (r'setInterval\s*\(',
     "setInterval 回调里的 setState 不触发重渲染（脚本环境只保证 setTimeout，请自递归）"),
]


def check_file(path: pathlib.Path) -> int:
    src = path.read_text(encoding="utf-8")
    fail = 0

    imported = set()
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from', src):
        for part in m.group(1).split(","):
            name = part.strip().replace("type ", "").split(" as ")[-1].strip()
            if name:
                imported.add(name)

    defined = set(re.findall(r'^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)', src, re.M))
    defined |= set(re.findall(r'^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)', src, re.M))
    defined |= set(re.findall(r'^\s*(?:export\s+)?type\s+([A-Za-z_]\w*)', src, re.M))
    known = imported | defined | GLOBALS

    # 1) JSX 用到的大写开头组件。要求 < 前是空白/括号/逗号，
    #    这样 useState<Card[]> 之类的泛型不会被误判成标签。
    used = set(re.findall(r'(?<=[\s(){}>,])<([A-Z]\w*)[\s/>]', src))
    missing = sorted(used - known)
    if missing:
        fail += 1
        print(f"✗ {path.name}: JSX 引用了未定义的组件 -> {', '.join(missing)}")
    else:
        print(f"✓ {path.name}: {len(used)} 个组件全部有来源")

    # 扫描前剥掉注释，避免注释里提到某 API 被误报
    code = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    code = re.sub(r'//[^\n]*', '', code)

    # 2) 漏导入
    for name in MUST_IMPORT:
        if re.search(r'\b' + name + r'\.', code) and name not in imported:
            fail += 1
            print(f'✗ {path.name}: 用了 {name}.* 但没有从 "scripting" 导入 {name}')

    # 3) 高危写法
    for pat, why in RISKY:
        if re.search(pat, code, re.S):
            fail += 1
            print(f"✗ {path.name}: {why}")

    # 4) Hooks 在提前 return 之后
    for fn in re.split(r'\n(?=(?:export\s+)?function\s)', code):
        m = re.match(r'(?:export\s+)?function\s+(\w+)', fn)
        if not m:
            continue
        # 提前 return 可能独占一行，也可能写成 `if (x) return ...` 的内联形式
        # 独占一行的 return 认 2-4 空格缩进；内联的 `if (x) return` 只认函数顶层的
        # 2 空格 —— 回调体内也常出现 4 空格的 `if (...) return`，放宽会误报。
        ret = re.search(r'\n(?: {2,4}return[\s(;<]| {2}if\s*\([^)]*\)\s*return[\s(;<])', fn)
        if not ret:
            continue
        tail = fn[ret.end():]
        # 左边可能是 x、[a, b] 或 {a}，三种都要认（只认缩进 2 空格的顶层声明，
        # 回调里定义的 hook 不算）
        late = re.findall(r'\n  (?:const|let)\s+[\w\[\]{},:\s]+=\s*(use[A-Z]\w*)\s*\(', tail)
        late += re.findall(r'\n  (use[A-Z]\w*)\s*\(', tail)
        if late:
            fail += 1
            print(f"✗ {path.name}: {m.group(1)}() 在提前 return 之后调用了 "
                  f"{', '.join(sorted(set(late)))} —— 违反 Hooks 规则")
    return fail


def main() -> int:
    target = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    if not target.is_dir():
        print(f"不是目录：{target}")
        return 2
    files = sorted(target.glob("*.tsx")) + sorted(target.glob("*.ts"))
    if not files:
        print(f"{target} 下没有 .ts / .tsx —— 是不是该指向同步目录（放 script.json 的那个）？")
        return 2
    fail = sum(check_file(f) for f in files)
    print(f"\n{'✗ 有 %d 处问题' % fail if fail else '✓ 全部通过'}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
