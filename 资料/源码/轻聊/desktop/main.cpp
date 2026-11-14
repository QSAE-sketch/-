/*
 * 轻聊 · Windows 桌面启动器
 *
 * 定位：纯壳。不内嵌任何前端代码、不捆绑 Chromium、不本地存储业务数据。
 * 启动系统已安装的 Edge / Chrome，用「应用窗口」模式（--app=URL）打开线上站点：
 *   - 独立窗口、无地址栏/标签栏，任务栏可固定，像桌面应用
 *   - 内容 100% 来自线上，线上更新后重开即生效，无需重建本 exe
 *   - 与 Android 端共用同一个站点地址，账号/消息/文件天然同步
 *
 * 构建：MinGW-w64 g++（见 build.bat / build.sh）
 *   windres -i resources.rc -o resources.o -O coff
 *   g++ -Os -municode -mwindows -o 轻聊.exe main.cpp resources.o -lshlwapi -lshell32 -lole32
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlwapi.h>
#include <shlobj.h>
#include <shellapi.h>
#include <objbase.h>
#include <string>
#include <vector>

/* 线上站点地址：与 android/app/src/main/res/values/strings.xml 的 app_url 保持一致。
   仅此一个常量；业务代码全在线上，改功能不需要动这里、也不需要重建 exe。 */
static const wchar_t* kAppUrl =
    L"https://qingliao-chat-33476.app.workbuddy.host/?sharecode=T7ELJZOC5A";
static const wchar_t* kAppName = L"轻聊";
static const wchar_t* kMutexName = L"Local\\QingLiaoDesktopSingleInstance";

typedef std::wstring WStr;

static WStr joinPath(const WStr& a, const WStr& b) {
    if (a.empty()) return b;
    if (a[a.size() - 1] == L'\\' || a[a.size() - 1] == L'/') return a + b;
    return a + L"\\" + b;
}

static WStr envDir(int csidl) {
    wchar_t buf[MAX_PATH] = {0};
    if (SUCCEEDED(SHGetFolderPathW(NULL, csidl, NULL, 0, buf))) return WStr(buf);
    return L"";
}

static bool fileExists(const WStr& p) {
    return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES;
}

/* 从注册表读浏览器安装路径（App Paths 是 Windows 记录已注册程序位置的标准位置） */
static WStr fromRegistry(HKEY root, const wchar_t* sub, const wchar_t* val) {
    HKEY k = NULL;
    if (RegOpenKeyExW(root, sub, 0, KEY_READ | KEY_WOW64_32KEY, &k) != ERROR_SUCCESS &&
        RegOpenKeyExW(root, sub, 0, KEY_READ | KEY_WOW64_64KEY, &k) != ERROR_SUCCESS) {
        return L"";
    }
    wchar_t buf[MAX_PATH] = {0};
    DWORD sz = sizeof(buf), type = 0;
    LSTATUS r = RegQueryValueExW(k, val, NULL, &type, (LPBYTE)buf, &sz);
    RegCloseKey(k);
    if (r != ERROR_SUCCESS) return L"";
    WStr s(buf);
    if (s.size() >= 2 && s[0] == L'"' && s[s.size() - 1] == L'"') s = s.substr(1, s.size() - 2);
    return s;
}

/* 按优先级找系统里的 Chromium 内核浏览器：Edge 优先（Win10/11 自带） */
static WStr findBrowser() {
    std::vector<WStr> c;
    c.push_back(fromRegistry(HKEY_LOCAL_MACHINE,
        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe", L""));
    c.push_back(fromRegistry(HKEY_CURRENT_USER,
        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe", L""));
    c.push_back(fromRegistry(HKEY_LOCAL_MACHINE,
        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe", L""));
    c.push_back(fromRegistry(HKEY_CURRENT_USER,
        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe", L""));

    WStr pf = envDir(CSIDL_PROGRAM_FILESX86);
    WStr pf64 = envDir(CSIDL_PROGRAM_FILES);
    WStr local = envDir(CSIDL_LOCAL_APPDATA);
    c.push_back(joinPath(pf, L"Microsoft\\Edge\\Application\\msedge.exe"));
    c.push_back(joinPath(pf64, L"Microsoft\\Edge\\Application\\msedge.exe"));
    c.push_back(joinPath(pf64, L"Google\\Chrome\\Application\\chrome.exe"));
    c.push_back(joinPath(pf, L"Google\\Chrome\\Application\\chrome.exe"));
    c.push_back(joinPath(local, L"Google\\Chrome\\Application\\chrome.exe"));

    for (size_t i = 0; i < c.size(); ++i) {
        if (!c[i].empty() && fileExists(c[i])) return c[i];
    }
    return L"";
}

/* 独立的用户数据目录：与日常浏览器会话隔离，登录态/缓存只属于轻聊，
   也避免 --app 参数被已运行的浏览器实例吞掉。 */
static WStr profileDir() {
    WStr base = envDir(CSIDL_LOCAL_APPDATA);
    if (base.empty()) {
        wchar_t tmp[MAX_PATH] = {0};
        GetTempPathW(MAX_PATH, tmp);
        base = WStr(tmp);
    }
    WStr dir = joinPath(base, L"QingLiaoDesktop");
    CreateDirectoryW(dir.c_str(), NULL);
    return dir;
}

static void showError(const wchar_t* msg) {
    MessageBoxW(NULL, msg, kAppName, MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

/*
 * 单实例：已有一个轻聊窗口时，把那个窗口调到前台，不再开第二个。
 * 用命名互斥体 + 隐藏窗口的自定义消息实现，避免多进程抢同一个 profile 目录。
 */
static const UINT WM_QL_ACTIVATE = WM_APP + 0x51;
static HWND g_hwnd = NULL;

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_QL_ACTIVATE) {
        ShowWindow(h, SW_RESTORE);
        SetForegroundWindow(h);
        return 0;
    }
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(h, m, w, l);
}

static HWND createHiddenWindow() {
    WNDCLASSEXW wc = {0};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.lpszClassName = L"QingLiaoDesktopHost";
    wc.hIcon = LoadIconW(wc.hInstance, MAKEINTRESOURCEW(1));
    RegisterClassExW(&wc);
    return CreateWindowExW(0, wc.lpszClassName, kAppName, 0,
                           0, 0, 0, 0, HWND_MESSAGE, NULL, wc.hInstance, NULL);
}

static bool activateExisting() {
    HWND h = FindWindowW(L"QingLiaoDesktopHost", NULL);
    if (!h) return false;
    SendMessageTimeoutW(h, WM_QL_ACTIVATE, 0, 0, SMTO_ABORTIFHUNG, 1500, NULL);
    SetForegroundWindow(h);
    return true;
}

static bool launch(const WStr& browser) {
    /* --app 让 Chromium 以独立窗口运行：无地址栏、无标签栏、独立任务栏项。
       其余参数压掉首次运行向导和默认浏览器提示，避免第一次打开弹干扰页。 */
    WStr args = L"--app=";
    args += kAppUrl;
    args += L" --user-data-dir=\"" + profileDir() + L"\"";
    args += L" --no-first-run --no-default-browser-check --disable-features=msEdgeIdentityFRE";
    args += L" --window-size=1120,760";

    std::vector<wchar_t> buf(args.begin(), args.end());
    buf.push_back(L'\0');

    SHELLEXECUTEINFOW si = {0};
    si.cbSize = sizeof(si);
    si.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
    si.lpVerb = L"open";
    si.lpFile = browser.c_str();
    si.lpParameters = buf.data();
    si.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&si)) return false;
    if (si.hProcess) CloseHandle(si.hProcess);
    return true;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

    HANDLE mutex = CreateMutexW(NULL, TRUE, kMutexName);
    if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
        activateExisting();
        CloseHandle(mutex);
        CoUninitialize();
        return 0;
    }

    WStr browser = findBrowser();
    if (browser.empty()) {
        /* 极端兜底：没找到 Chromium 内核浏览器时，用系统默认浏览器打开普通标签页。
           功能仍完全可用，只是没有独立应用窗口。 */
        HINSTANCE r = ShellExecuteW(NULL, L"open", kAppUrl, NULL, NULL, SW_SHOWNORMAL);
        if ((INT_PTR)r <= 32) {
            showError(L"没有找到可用的浏览器，请先安装 Microsoft Edge 或 Chrome 后重试。");
            if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
            CoUninitialize();
            return 1;
        }
        if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
        CoUninitialize();
        return 0;
    }

    if (!launch(browser)) {
        showError(L"启动浏览器失败，请检查系统权限后重试。");
        if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
        CoUninitialize();
        return 1;
    }

    /* 宿主窗口只负责单实例与任务栏 presence，不渲染任何内容；
       浏览器窗口关闭后本进程随之退出。 */
    g_hwnd = createHiddenWindow();
    if (g_hwnd) {
        MSG msg;
        while (GetMessageW(&msg, NULL, 0, 0) > 0) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
    CoUninitialize();
    return 0;
}
