"""真 PTY 驱动：给 `tui-pty.test.ts` 用。

为什么要有它：假 TUI 的 `feed()` 直接把字符串交给 `handleInput`，绕过了终端编码这一层——
同一个键在 Kitty 键盘协议下是另一串字节，那一层不走真 PTY 就永远测不到。
Bun 1.3 没有 pty；python3 标准库有，所以这里是 python。

协议（stdin 收 JSON，stdout 出 JSON）：
  { "cmd": [...], "cwd": "...", "env": {...},
    "steps": [
      { "kind": "wait", "text": "…", "timeout": 5 },   // 等到输出里（去掉 ANSI 之后）出现这段文字
      { "kind": "send", "bytes": [27, 91, ...] },        // 往 PTY 写字节
      { "kind": "exit", "timeout": 5 }                   // 等进程退出，记下退出码
    ] }
  → { "steps": [ { "ok": true|false, ...同 step..., "code"?: int }, ... ], "tail": "最后 2000 字（去 ANSI）" }

**任何一步失败都不早退**：把每一步的结果都记下来，交给 bun 那边一起断言，红的时候看得见全貌。
"""
import json
import os
import pty
import re
import select
import signal
import sys
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b\[\?[0-9;]*[hl]")


def clean(s: str) -> str:
    return ANSI.sub("", s)


def main() -> int:
    spec = json.load(sys.stdin)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(spec["cwd"])
        os.execvpe(spec["cmd"][0], spec["cmd"], spec["env"])
        os._exit(127)

    buf = ""
    alive = True
    exit_code = None

    def pump(seconds: float) -> None:
        nonlocal buf, alive, exit_code
        end = time.time() + seconds
        while time.time() < end and alive:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    buf += chunk.decode("utf8", "replace")
                    continue
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                alive = False
                exit_code = os.waitstatus_to_exitcode(status)
                return

    results = []
    try:
        for step in spec["steps"]:
            kind = step["kind"]
            if kind == "wait":
                deadline = time.time() + step.get("timeout", 5)
                ok = False
                while time.time() < deadline:
                    if step["text"] in clean(buf):
                        ok = True
                        break
                    pump(0.1)
                    if not alive:
                        ok = step["text"] in clean(buf)
                        break
                results.append({**step, "ok": ok})
            elif kind == "send":
                os.write(fd, bytes(step["bytes"]))
                pump(0.3)
                results.append({**step, "ok": True})
            elif kind == "exit":
                deadline = time.time() + step.get("timeout", 5)
                while alive and time.time() < deadline:
                    pump(0.1)
                results.append({**step, "ok": not alive, "code": exit_code})
            else:
                results.append({**step, "ok": False, "error": f"未知 step: {kind}"})
    finally:
        if alive:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except OSError:
                pass
        os.close(fd)

    json.dump({"steps": results, "tail": clean(buf)[-2000:]}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
