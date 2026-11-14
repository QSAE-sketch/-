#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
内网穿透停止器（AI 调用，或用户说"停"时调用）

读取 ~/.workbuddy/intranet-tunnel/tunnel.pid，结束隧道进程（含其子进程），
清理状态文件。隧道停止后公网链接立即失效。
"""
import os
import sys
import signal
import subprocess

STATE_DIR = os.path.join(os.path.expanduser("~"), ".workbuddy", "intranet-tunnel")
PID_FILE = os.path.join(STATE_DIR, "tunnel.pid")
URL_FILE = os.path.join(STATE_DIR, "tunnel.url")


def main():
    if not os.path.isfile(PID_FILE):
        print("[INFO] 当前没有正在运行的隧道")
        return
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
    except Exception:
        print("[WARN] PID 文件损坏，直接清理")
        pid = None

    if pid is not None:
        if os.name == "nt":
            # /T 杀进程树（含 cloudflared 子进程）
            r = subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"],
                               capture_output=True, text=True)
            print(r.stdout.strip())
        else:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            # 兜底：杀子进程
            try:
                subprocess.run(["pkill", "-P", str(pid)], capture_output=True)
            except Exception:
                pass

    for p in (PID_FILE, URL_FILE):
        if os.path.isfile(p):
            try:
                os.remove(p)
            except Exception:
                pass

    print("[STOPPED] 隧道已停止，公网链接已失效")


if __name__ == "__main__":
    main()
