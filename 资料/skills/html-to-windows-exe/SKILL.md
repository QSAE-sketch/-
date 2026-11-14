---
name: html-to-windows-exe
agent_created: true
description: 把单个自包含 HTML/JS 网页应用（游戏、工具、原型）打包成体积小的原生 Windows .exe。适用于 GFW 环境——不下载浏览器二进制（Neutralino/Electron 的 GitHub 二进制会被墙）。用 pywebview(PyPI, 调用系统 WebView2) + PyInstaller 生成单文件 exe，并用纯 Python 的 pylnk3 生成桌面快捷方式（避开被安全策略拦截的 WScript.Shell COM）。
---

# 把网页打包成 Windows 桌面 exe（GFW 安全 · 小体积）

## 适用场景
- 用户有一个**单文件、自包含**的 HTML（内联 CSS/JS，无外部资源），想变成 Windows 桌面应用。
- 目标机器是 Windows 10/11（自带 WebView2 运行时）。
- 环境在 GFW 内：`github.com` 的二进制下载（Neutralino 运行时、Electron/Chromium）会被拦截 → **不要用 Neutralino / Electron / NW.js**。

## 方案
**pywebview + PyInstaller**（均来自 PyPI，不被墙）：
- pywebview 用系统自带的 Edge（WebView2）渲染网页，**不内嵌整个浏览器**，产物仅 ~10–15MB。
- PyInstaller 把 Python 解释器 + pywebview + 网页打包成单个 `app.exe`。

## 步骤
1. 用受管 Python 建 venv（避免污染用户环境）：
   ```
   <managed-python> -m venv venv
   venv\Scripts\pip install pywebview pyinstaller pylnk3
   ```
2. 启动器 `app_launcher.py`：起一个本地 HTTP 服务加载网页（**用 HTTP 而非 file://**，保证 localStorage 存档/相对路径与原网页表现一致），再开窗口。
   ```python
   import os, sys, threading, http.server, socketserver, webview
   BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
   HTML = "index.html"
   PORT = 8765

   class _H(http.server.SimpleHTTPRequestHandler):
       def __init__(self, *a, **k):
           super().__init__(*a, directory=BASE, **k)
       def log_message(self, *a, **k): pass

   def _serve():
       socketserver.TCPServer.allow_reuse_address = True
       with socketserver.TCPServer(("127.0.0.1", PORT), _H) as s:
           s.serve_forever()

   if __name__ == "__main__":
       # ★ 存档持久化关键：pywebview 默认 private_mode=True，
       # 会把 WebView2 用户数据(含 localStorage)放到 PyInstaller 的临时 _MEI 目录，
       # 每次启动都新建、关闭即删 → 网页里的 localStorage 存档每次都丢！
       # 必须显式指定固定 storage_path（并关掉 private_mode）。
       storage_dir = os.path.join(
           os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "AppName", "WebView2Data")
       os.makedirs(storage_dir, exist_ok=True)
       os.environ["WEBVIEW2_USER_DATA_FOLDER"] = storage_dir   # 双保险
       threading.Thread(target=_serve, daemon=True).start()
       webview.create_window("AppName", f"http://127.0.0.1:{PORT}/{HTML}",
                             width=1100, height=760, resizable=True)
       webview.start(private_mode=False, storage_path=storage_dir)
   ```
   - **不要**给 `create_window()` 传 `icon` 参数（部分 pywebview 版本会抛 `TypeError: unexpected keyword argument 'icon'`）。图标应通过 PyInstaller 的 `--icon app.ico` 嵌入 exe；快捷方式会自动使用 exe 内嵌图标。
3. 打包（**注意 Windows 的 `--add-data` 用分号**）：
   ```
   venv\Scripts\pyinstaller --onefile --windowed --name AppName ^
     --add-data "index.html;." --hidden-import webview.platforms.winforms --hidden-import clr ^
     app_launcher.py
   ```
   - `--windowed` 去掉黑控制台；`--onefile` 出单文件 `dist/AppName.exe`。
   - `webview.platforms.winforms` + `clr`（pythonnet）是 Windows 默认后端的隐藏依赖，必须加 hidden-import，否则运行报 ModuleNotFoundError。
4. 产物 `dist/AppName.exe` 单文件，可直接拷贝分发。

## 存档持久化（最关键的坑 · 必看）
**现象**：网页游戏/应用把进度存到 `localStorage`，用 pywebview 打包成 exe 后，每次关闭重开数据全清空。
**根因**：pywebview **默认 `private_mode=True`**。此时 `init_storage()` 把 WebView2 的 UserDataFolder（localStorage 就存在这里）放到**临时目录**；而 PyInstaller `--onefile` 每次启动都解压到一个新的 `_MEIxxxx` 临时目录，关闭即删 → 存档自然没了。文件系统中会看到 `...\AppData\Local\Temp\_MEIxxxx\webview` 这种目录，而 `AppData/pywebview` 不存在。
**修复（一行启动参数）**：
```python
webview.start(private_mode=False, storage_path=r"固定目录如 C:\Users\xx\AppData\Local\AppName\WebView2Data")
```
- `storage_path` 必须是**不随启动变化**的固定路径（用 `LOCALAPPDATA` 或 exe 同级目录都行；用 `_MEIPASS` 临时目录不行）。
- 同时可设 `os.environ["WEBVIEW2_USER_DATA_FOLDER"] = storage_dir` 双保险（pywebview 已显式设置 UserDataFolder=storage_path，env 会被覆盖，但无害）。
**验证**：启动 exe 后检查 `LOCALAPPDATA/AppName/WebView2Data` 是否被创建（而非 `Temp/_MEI*`）。更严谨：写个 pywebview 小脚本，首个进程 `evaluate_js("localStorage.setItem('k','v')")` 后关闭，第二个进程读回，断言一致。
**兜底**：若网页有关闭时未落盘的风险（如临时数据只在关闭界面时才提交），在网页里加 `window.addEventListener("beforeunload", ()=>{ save(); })`，确保关闭即保存。

## 桌面快捷方式（关键坑）
`WScript.Shell` COM（`New-Object -ComObject WScript.Shell`）**会被安全策略拦截**（"COM object instantiation can run arbitrary code"）。改用纯 Python 的 `pylnk3`：
```python
import os, pylnk3
exe = r"D:\path\to\dist\AppName.exe"
desktop = os.path.join(os.environ["USERPROFILE"], "Desktop")
lnk = pylnk3.for_file(exe)          # 注意：用 for_file()，不是 create()（create 不设目标，path=None 会得到坏快捷方式）
lnk.work_dir = os.path.dirname(exe)
lnk.description = "AppName"
lnk.icon = exe; lnk.icon_index = 0
lnk.save(os.path.join(desktop, "AppName.lnk"))
# 校验：重新 parse 读回目标
assert pylnk3.parse(os.path.join(desktop, "AppName.lnk")).path == exe
```
- `pylnk3.create(exe)` 的 `path` 是只读属性且不会写入目标 → 必须用 `for_file()`。
- **exe 文件名不要用中文**：pylnk3 保存中文 exe 目标路径时会出现目标丢失/指向目录/指向不存在的文件等错误。若需要中文显示名，应保持 exe 文件名为英文（如 `AppName.exe`），仅将桌面快捷方式的 `.lnk` 文件名和 `lnk.description` 设为中文（如「地牢探险.lnk」），窗口标题也设为中文。

## 冒烟测试（无需 GUI/显示器）
启动 exe 后，本地服务会先起，用 curl 验证网页被正确 serve：
```
start "" dist\AppName.exe
timeout /t 5
curl -s -o nul -w "HTTP %{http_code} len=%{size_download}\n" http://127.0.0.1:8765/index.html
taskkill /IM AppName.exe /F
```
期望 `HTTP 200` 且 `Content-Length` 等于网页字节数；运行日志无 traceback 即说明能正常启动并加载游戏。

## 注意
- 最终用户机器需有 **WebView2 运行时**（Win10/11 默认自带；缺失则从微软官网装 "Microsoft Edge WebView2 Runtime"）。
- 无原生 C/C++/Rust 工具链也能做（不需要 Tauri）。
- 本机若没有显示器，窗口可能不可见，但本地 HTTP 服务可验证功能正确性。
