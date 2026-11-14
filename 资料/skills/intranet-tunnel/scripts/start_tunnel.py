#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
内网穿透启动器（AI 自动调用，人类无需操作）

自动选择穿透方案并运行：
  1. cloudflared quick tunnel（默认，免登录、免费、稳定）
  2. ssh localhost.run（兜底，零下载，用系统自带 ssh）

脚本负责：检测/下载工具 → 启动隧道 → 轮询日志提取公网 URL →
写入 ~/.workbuddy/intranet-tunnel/tunnel.url → 常驻保持隧道。

用法：
  python start_tunnel.py --port 3000 --method auto
  python start_tunnel.py --port 8080 --method ssh
  python start_tunnel.py --port 5000 --url http://127.0.0.1:5000
"""
import argparse
import os
import sys
import time
import re
import shutil
import signal
import subprocess
import platform
import urllib.request

STATE_DIR = os.path.join(os.path.expanduser("~"), ".workbuddy", "intranet-tunnel")
PID_FILE = os.path.join(STATE_DIR, "tunnel.pid")
LOG_FILE = os.path.join(STATE_DIR, "tunnel.log")
URL_FILE = os.path.join(STATE_DIR, "tunnel.url")

_child = None  # 隧道子进程（全局，供信号处理器使用）


def log(msg):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def cloudflared_bin():
    return os.path.join(STATE_DIR, "cloudflared.exe" if os.name == "nt" else "cloudflared")


def download_url_for():
    system = platform.system().lower()
    if system == "windows":
        return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    if system == "linux":
        return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    if system == "darwin":
        return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64"
    return None


def download_file(url, dest):
    log(f"正在下载穿透工具：{url}")
    # 尊重 http_proxy / https_proxy 环境变量
    opener = urllib.request.build_opener(urllib.request.ProxyHandler())
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with opener.open(req, timeout=180) as resp, open(dest, "wb") as out:
        total = resp.headers.get("Content-Length")
        total = int(total) if total else 0
        got = 0
        chunk = 1024 * 256
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            out.write(buf)
            got += len(buf)
            if total:
                sys.stdout.write(f"\r下载进度：{got * 100 // total}%")
                sys.stdout.flush()
    sys.stdout.write("\n")
    if os.name != "nt":
        os.chmod(dest, 0o755)
    log(f"下载完成：{dest}")


def ensure_cloudflared():
    binp = cloudflared_bin()
    if os.path.isfile(binp) and os.path.getsize(binp) > 1_000_000:
        log("cloudflared 已存在，跳过下载")
        return binp
    url = download_url_for()
    if not url:
        raise RuntimeError("未知操作系统，无法下载 cloudflared")
    os.makedirs(STATE_DIR, exist_ok=True)
    download_file(url, binp)
    return binp


def find_ssh():
    s = shutil.which("ssh")
    if s:
        return s
    candidates = [
        r"C:\Windows\System32\OpenSSH\ssh.exe",
        r"C:\Program Files\Git\usr\bin\ssh.exe",
        r"C:\Program Files (x86)\Git\usr\bin\ssh.exe",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def extract_url(text):
    m = re.search(r"https://[a-zA-Z0-9._-]+\.trycloudflare\.com", text)
    if m:
        return m.group(0)
    m = re.search(r"https?://[a-zA-Z0-9._-]+\.lhr\.run", text)
    if m:
        return m.group(0)
    return None


def already_running():
    if not os.path.isfile(PID_FILE):
        return None
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
    except Exception:
        return None
    if os.name == "nt":
        r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"],
                           capture_output=True, text=True)
        if "No tasks" not in r.stdout:
            return pid
    else:
        try:
            os.kill(pid, 0)
            return pid
        except OSError:
            return None
    return None


def start_cloudflared(url):
    binp = ensure_cloudflared()
    cmd = [binp, "tunnel", "--no-autoupdate", "--url", url]
    log(f"启动 cloudflared 隧道：{' '.join(cmd)}")
    return subprocess.Popen(cmd, stdout=open(LOG_FILE, "a", encoding="utf-8"),
                            stderr=subprocess.STDOUT)


def start_ssh(url):
    ssh = find_ssh()
    if not ssh:
        raise RuntimeError("未找到 ssh 客户端，请安装 Git Bash 或 Windows OpenSSH")
    host_port = url.replace("http://", "").replace("https://", "")
    cmd = [ssh, "-R", f"80:{host_port}",
           "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
           "-o", "LogLevel=ERROR", "nokey@localhost.run"]
    log(f"启动 ssh localhost.run 隧道：{' '.join(cmd)}")
    return subprocess.Popen(cmd, stdout=open(LOG_FILE, "a", encoding="utf-8"),
                            stderr=subprocess.STDOUT)


def cleanup(signum, frame):
    if _child and _child.poll() is None:
        try:
            _child.terminate()
        except Exception:
            pass
    sys.exit(0)


def main():
    global _child
    ap = argparse.ArgumentParser(description="内网穿透启动器")
    ap.add_argument("--port", type=int, required=True, help="要暴露的本机端口")
    ap.add_argument("--method", default="auto",
                    choices=["auto", "cloudflared", "ssh"], help="穿透方案")
    ap.add_argument("--url", default=None, help="本机服务地址，默认 http://localhost:PORT")
    args = ap.parse_args()

    os.makedirs(STATE_DIR, exist_ok=True)
    url = args.url or f"http://localhost:{args.port}"

    pid = already_running()
    if pid:
        log(f"[TUNNEL_EXISTS] 已有隧道在运行（PID {pid}）。请先运行 stop_tunnel.py 停止，"
            f"或复用 {URL_FILE}")
        sys.exit(2)

    # 清空旧日志 / URL
    open(LOG_FILE, "w", encoding="utf-8").close()
    if os.path.isfile(URL_FILE):
        os.remove(URL_FILE)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    proc = None
    try:
        if args.method in ("auto", "cloudflared"):
            try:
                proc = start_cloudflared(url)
            except Exception as e:
                log(f"cloudflared 启动失败：{e}")
                proc = None
        if proc is None and args.method == "auto":
            log("自动降级到 ssh localhost.run 方案")
            try:
                proc = start_ssh(url)
            except Exception as e:
                log(f"ssh 方案也失败：{e}")
                proc = None
        if proc is None:
            log("[ERROR] 所有穿透方案均失败，请检查网络或手动配置")
            sys.exit(1)

        _child = proc
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))

        log("隧道进程已启动，正在等待公网地址...")
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                with open(LOG_FILE, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except Exception:
                content = ""
            found = extract_url(content)
            if found:
                with open(URL_FILE, "w", encoding="utf-8") as f:
                    f.write(found)
                log(f"[TUNNEL_READY] {found}")
                break
            if proc.poll() is not None:
                log(f"[ERROR] 隧道进程已退出，返回码 {proc.returncode}")
                try:
                    tail = open(LOG_FILE, encoding="utf-8", errors="ignore").read()[-2000:]
                    log(tail)
                except Exception:
                    pass
                sys.exit(1)
            time.sleep(1)
        else:
            log("[ERROR] 90 秒内未拿到公网地址，请查看日志：")
            try:
                log(open(LOG_FILE, encoding="utf-8", errors="ignore").read()[-2000:])
            except Exception:
                pass
            sys.exit(1)

        log("隧道保持运行中。按 Ctrl+C 或运行 stop_tunnel.py 停止。")
        while True:
            if proc.poll() is not None:
                log("[WARN] 隧道进程意外退出，隧道已断开")
                break
            time.sleep(2)
    finally:
        try:
            if proc and proc.poll() is None:
                proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
