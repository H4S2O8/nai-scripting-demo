#!/usr/bin/env python3
"""
Rewrite the NovelAI account list in the service's environment file.

Runs ON THE SERVER, driven by mcp/account.sh. Reads its inputs from the
environment rather than argv, because argv is visible in `ps` to every user on
the box and a pst- token must not be.

    OP       add | remove | list
    LABEL    which account
    NEWTOKEN the token, for add only
    ENVFILE  path, default /etc/novelai-mcp.env
"""
import io
import os
import re
import sys

PATH = os.environ.get("ENVFILE", "/etc/novelai-mcp.env")
OP = os.environ.get("OP", "list")
LABEL = os.environ.get("LABEL", "").strip()
TOKEN = os.environ.get("NEWTOKEN", "").strip()


def read_lines():
    return io.open(PATH, encoding="utf-8").read().splitlines()


def value(lines, name):
    for line in lines:
        if line.startswith(name + "="):
            return line[len(name) + 1 :].strip()
    return ""


def parse(lines):
    """Current pool, as [label, token] pairs.

    The legacy single-token variable is folded in here so that everything
    downstream deals with one list. Duplicate tokens are dropped: counting one
    account twice would make the balancer believe in twice the quota.
    """
    entries, seen = [], set()
    raw = value(lines, "NOVELAI_TOKENS") + "," + value(lines, "NOVELAI_TOKEN")
    for item in re.split(r"[,;\n]+", raw):
        item = item.strip()
        if not item or item == "REPLACE_ME":
            continue
        eq = item.find("=")
        name, token = (item[:eq].strip(), item[eq + 1 :].strip()) if eq > 0 else ("", item)
        if not token or token in seen:
            continue
        seen.add(token)
        entries.append([name or "main", token])
    return entries


def write(lines, entries):
    joined = ",".join(name + "=" + token for name, token in entries)
    out, handled = [], False
    for line in lines:
        # Dropped, not kept: leaving NOVELAI_TOKEN behind would silently
        # re-add an account that was just removed.
        if line.startswith("NOVELAI_TOKEN="):
            continue
        if line.startswith("NOVELAI_TOKENS="):
            out.append("NOVELAI_TOKENS=" + joined)
            handled = True
            continue
        out.append(line)
    if not handled:
        out.append("NOVELAI_TOKENS=" + joined)

    tmp = PATH + ".tmp"
    # Written 0600 before it is moved into place, so the token is never briefly
    # readable at the default umask.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(out).rstrip("\n") + "\n")
    os.replace(tmp, PATH)


def describe(entries):
    if not entries:
        return "池是空的。"
    return f"池里 {len(entries)} 个账户: " + ", ".join(name for name, _ in entries)


def main():
    lines = read_lines()
    entries = parse(lines)

    if OP == "list":
        print(describe(entries))
        return 0

    if not LABEL:
        print("没有给 label。", file=sys.stderr)
        return 2

    if OP == "add":
        if not TOKEN:
            print("没有收到令牌，未改动。", file=sys.stderr)
            return 1
        # Refused rather than silently deduped. Adding an existing token under
        # a second label used to report success and then vanish on the next
        # parse, which looks exactly like the write having failed.
        clash = next((n for n, t in entries if t == TOKEN and n != LABEL), None)
        if clash:
            print(f"这个令牌已经以 {clash} 的身份在池里了，未改动。", file=sys.stderr)
            return 1
        for entry in entries:
            if entry[0] == LABEL:
                entry[1] = TOKEN
                print(f"替换了 {LABEL} 的令牌。")
                break
        else:
            entries.append([LABEL, TOKEN])
            print(f"新增账户 {LABEL}。")
    elif OP == "remove":
        kept = [e for e in entries if e[0] != LABEL]
        if len(kept) == len(entries):
            print(f"池里没有叫 {LABEL} 的账户，未改动。", file=sys.stderr)
            return 1
        if not kept:
            print("这是最后一个账户，删掉之后生图会全部失败。", file=sys.stderr)
        entries = kept
        print(f"删除了 {LABEL}。")
    else:
        print(f"未知操作 {OP}", file=sys.stderr)
        return 2

    write(lines, entries)
    print(describe(entries))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
