/*
 * 轻聊 · Windows 原生客户端
 *
 * 与旧版「启动浏览器打开网页」的壳完全不同：这里没有 WebView、没有 HTML，
 * 窗口、列表、气泡、输入框全部由 Win32 原生控件与 GDI 绘制，
 * 消息通过 WinHTTP 直接和 server.js 的 /api/* 通信。
 *
 * 线程模型：
 *    UI 线程只做绘制与输入；所有网络请求投递到工作线程，
 *    结果通过 PostMessage 回到 UI 线程再刷新，界面永不卡在请求上。
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <commdlg.h>
#include <wincrypt.h>
#include <shellapi.h>
#include <shlobj.h>
#include <cstdio>
#include <cstdlib>
#include <cstdarg>
#include <cmath>
#include <cwctype>
#include <ctime>
#include <string>
#include <vector>
#include <deque>
#include <functional>
#include <map>
#include <set>

#include "json.h"
#include "http.h"
#include "api.h"
#include "image.h"

using namespace ql;

/* ================================================================== */
/* 常量与配色                                                          */
/* ================================================================== */

#define WM_QL_RESULT (WM_APP + 1)
#define WM_QL_PROGRESS (WM_APP + 2)

static const int SIDEBAR_W = 248;
static const int HEADER_H = 56;
static const int INPUT_H = 132;

/* 浅色主题（与线上站点同一套色，切过去不会有割裂感） */
static const COLORREF C_BG = RGB(242, 243, 245);
static const COLORREF C_SIDE = RGB(247, 248, 250);
static const COLORREF C_CARD = RGB(255, 255, 255);
static const COLORREF C_LINE = RGB(229, 230, 235);
static const COLORREF C_TEXT = RGB(31, 35, 40);
static const COLORREF C_SUB = RGB(110, 118, 129);
static const COLORREF C_MUTED = RGB(150, 158, 168);
static const COLORREF C_ACCENT = RGB(31, 111, 235);
static const COLORREF C_ACCENT_DIM = RGB(226, 238, 255);
static const COLORREF C_DANGER = RGB(215, 58, 73);
static const COLORREF C_BUBBLE_OTHER = RGB(255, 255, 255);
static const COLORREF C_HOVER = RGB(235, 237, 241);
static const COLORREF C_ACTIVE = RGB(226, 238, 255);

/* ================================================================== */
/* 全局状态                                                            */
/* ================================================================== */

enum View { VIEW_LOGIN, VIEW_MAIN };

struct MsgLayout {
    int top;        // 相对内容顶部的偏移
    int height;
    size_t index;
    RECT bubble;    // 气泡矩形（内容坐标系）
    RECT saveBtn;   // 文件消息的「保存」按钮
    bool hasSave;
    bool showName;  // 是否显示昵称（连续消息只显示第一条，自己发的不显示）
    bool showAvatar;// 是否画头像（自己发的也画在右侧）
};

struct AsyncResult {
    int kind;
    bool ok;
    std::string error;
    std::vector<Room> rooms;
    std::string publicId;
    MessagePage page;
    Message msg;
    UploadResult up;
    std::string text;
    std::vector<User> members;
    std::vector<Member> memberInfos;
    std::string version;
    std::string avatarUrl;              // RK_AVATAR_GET：头像地址
    std::vector<unsigned char> bytes;   // RK_AVATAR_GET：头像字节
    std::vector<RoomSearchItem> searchResults;  // RK_SEARCH
    Room room;                          // RK_SEARCH_PEEK / RK_SEARCH_JOIN：要打开的房间
    AsyncResult() : kind(0), ok(false) {}
};

enum ResKind {
    RK_LOGIN = 1, RK_REGISTER, RK_ME, RK_ROOMS, RK_MSGS, RK_SEND,
    RK_UPLOAD, RK_DOWNLOAD, RK_NICK, RK_JOIN, RK_CREATE, RK_VERSION, RK_MEMBERS,
    RK_MEMBERINFOS, RK_MUTE, RK_KICK, RK_APPOINT, RK_TRANSFER, RK_DISSOLVE,
    RK_AVATAR_SET, RK_AVATAR_CLEAR, RK_AVATAR_GET,
    RK_SEARCH, RK_SEARCH_PEEK, RK_SEARCH_JOIN
};

static HINSTANCE g_inst = NULL;
static HWND g_hwnd = NULL;
static Api g_api;

static View g_view = VIEW_LOGIN;
static bool g_registerMode = false;

static std::vector<Room> g_rooms;
static std::string g_publicRoomId;
static std::string g_roomId;
static std::string g_roomName;
static MessagePage g_page;
static std::vector<MsgLayout> g_layouts;
static int g_contentH = 0;
/* 消息列表按微信/QQ 的「自上而下」排列：旧消息在上、新消息在下。
   g_scrollY = 视口顶部相对内容顶部的偏移（0 = 看到最旧的顶部）。 */
static int g_scrollY = 0;
static bool g_atBottom = true;
/* 赋这个值 = 「想看最新」，paintChat 会把它钳到 maxScroll（= 底部） */
static const int SCROLL_BOTTOM = INT_MAX / 2;

static int g_hoverRoom = -1;
static bool g_busy = false;
static std::string g_status;
static std::wstring g_statusW;

/* 控件 */
static HWND g_edUser = NULL, g_edPass = NULL, g_edNick = NULL, g_edInput = NULL;
static HWND g_wndSettings = NULL;

static HFONT g_fontUI = NULL, g_fontSmall = NULL, g_fontBold = NULL, g_fontTitle = NULL, g_fontH1 = NULL;
static HBRUSH g_brBg = NULL, g_brSide = NULL, g_brCard = NULL, g_brField = NULL;

static RECT g_btnLogin, g_btnSwitch, g_btnSend, g_btnFile, g_btnNew, g_btnRefresh, g_btnSettings;
static RECT g_btnMembers;
static RECT g_btnSearchRoom;
/* 搜索房间窗口状态（窗口实现定义在后方） */
static HWND g_wndSearch = NULL;
static HWND g_srchInput = NULL;
static std::vector<RoomSearchItem> g_srchResults;
static std::wstring g_srchStatus;
/* 群管理窗口状态（窗口实现定义在后方） */
static HWND g_wndMembers = NULL;
static std::vector<Member> g_memberList;
static int g_memberSel = -1;
static int g_loginErrY = 0;
static std::wstring g_loginErr;
/* --shot <path>：启动后自动截一张界面图再退出，用于无人值守验证界面 */
static std::wstring g_shotPath;
/* --seed <账号> <密码> [1]：把账号写进本地凭据后退出，用于自动化测试 */
static std::wstring g_seedUser, g_seedPass;
static bool g_seedAuto = false;
/* --base <url>：临时指定服务器（测试用；不传则用内置线上地址） */
static std::wstring g_baseOverride;

/* ---------------- 记住密码 / 自动登录 / 多账号切换 ---------------- */
/*
 * 密码不落明文：所有已保存账号序列化成一个 JSON，整体用 Windows DPAPI 加密，
 * 存到 %LOCALAPPDATA%\QingLiao\cred.dat。密文只对「当前 Windows 用户」可解，
 * 文件被拷到别的机器或别的账户下都解不开。
 *
 * 只有「输入过密码并成功登录过」的账号才会进入这个列表 —— 这正是切换账号的前提。
 */
struct SavedAccount {
    std::string user, pass, nick;
    bool remember;      // 勾了「记住密码」才保存密码
    SavedAccount() : remember(false) {}
};

static std::vector<SavedAccount> g_accounts;
static std::string g_autoUser;        // 自动登录的账号名（空 = 不自动登录）
static int g_activeIdx = -1;          // 登录页当前选中的账号
static bool g_rememberMode = false;   // 已记住密码：隐藏密码框，点一下就登录
static bool g_addingAccount = false;  // 从「+」进来的：显示手动输入表单
static bool g_cbRemember = false;     // 复选框：记住密码
static bool g_cbAuto = false;         // 复选框：自动登录
static RECT g_cbRememberR, g_cbAutoR;
static std::vector<RECT> g_avRects;   // 账号头像（选择器）
static RECT g_addRect;                // 「+」添加账号
static RECT g_linkAlt, g_linkManage;  // 其他登录方式 / 账号管理
static std::string g_pendingUser, g_pendingPass;  // 本次登录使用的账号密码

static std::string dpapiEncrypt(const std::string& plain) {
    DATA_BLOB in;
    in.pbData = (BYTE*)plain.data();
    in.cbData = (DWORD)plain.size();
    DATA_BLOB out = {0, NULL};
    if (!CryptProtectData(&in, L"QingLiao", NULL, NULL, NULL,
                          CRYPTPROTECT_UI_FORBIDDEN, &out)) {
        return std::string();
    }
    std::string r((char*)out.pbData, out.cbData);
    LocalFree(out.pbData);
    return r;
}

static std::string dpapiDecrypt(const std::string& blob) {
    if (blob.empty()) return std::string();
    DATA_BLOB in;
    in.pbData = (BYTE*)blob.data();
    in.cbData = (DWORD)blob.size();
    DATA_BLOB out = {0, NULL};
    if (!CryptUnprotectData(&in, NULL, NULL, NULL, NULL,
                            CRYPTPROTECT_UI_FORBIDDEN, &out)) {
        return std::string();
    }
    std::string r((char*)out.pbData, out.cbData);
    LocalFree(out.pbData);
    return r;
}

static std::wstring credFile() { return configFile(L"cred.dat"); }

static int findAccount(const std::string& user) {
    for (size_t i = 0; i < g_accounts.size(); ++i) {
        if (g_accounts[i].user == user) return (int)i;
    }
    return -1;
}

static void loadCreds() {
    FILE* fp = _wfopen(credFile().c_str(), L"rb");
    if (!fp) return;
    int flag = fgetc(fp);
    std::string blob;
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), fp)) > 0) blob.append(buf, n);
    fclose(fp);

    std::string plain = dpapiDecrypt(blob);
    if (plain.empty()) return;

    Json root;
    if (!Json::parse(plain, root)) return;

    g_accounts.clear();
    const Json* arr = root.find("accounts");
    if (arr && arr->isArray()) {
        for (size_t i = 0; i < arr->items.size(); ++i) {
            const Json& a = arr->items[i];
            SavedAccount s;
            s.user = a.str("user");
            s.pass = a.str("pass");
            s.nick = a.str("nick");
            s.remember = a.boolOf("remember");
            if (!s.user.empty()) g_accounts.push_back(s);
        }
    }

    g_autoUser = root.str("auto");
    if (flag != 1) g_autoUser.clear();

    /* 上次使用的账号排在第一个，启动时直接对着它 */
    std::string last = root.str("last");
    int li = findAccount(last);
    if (li > 0) {
        SavedAccount t = g_accounts[(size_t)li];
        g_accounts.erase(g_accounts.begin() + li);
        g_accounts.insert(g_accounts.begin(), t);
    }
    g_activeIdx = g_accounts.empty() ? -1 : 0;
}

static void saveCreds() {
    Json root = Json::object();
    root.set("auto", g_autoUser);
    root.set("last", (g_activeIdx >= 0 && g_activeIdx < (int)g_accounts.size())
                         ? g_accounts[(size_t)g_activeIdx].user : std::string());

    Json arr = Json::array();
    for (size_t i = 0; i < g_accounts.size(); ++i) {
        Json a = Json::object();
        a.set("user", g_accounts[i].user);
        a.set("pass", g_accounts[i].pass);
        a.set("nick", g_accounts[i].nick);
        a.set("remember", g_accounts[i].remember);
        arr.push(a);
    }
    root.set("accounts", arr);

    std::string blob = dpapiEncrypt(root.dump());
    if (blob.empty()) return;
    FILE* fp = _wfopen(credFile().c_str(), L"wb");
    if (!fp) return;
    fputc(g_autoUser.empty() ? 0 : 1, fp);
    fwrite(blob.data(), 1, blob.size(), fp);
    fclose(fp);
}

/* 登录成功后登记账号：
 *   勾了「记住密码」→ 带密码留在列表里，下次可一键登录、也可被切换账号选中
 *   没勾           → 从列表移除，下次还得重新输密码
 * 因此「切换账号」里出现的账号，必然都是输入过密码并登录成功过的。 */
static void rememberAccount(const std::string& user, const std::string& pass,
                            const std::string& nick, bool remember) {
    int idx = findAccount(user);
    if (!remember) {
        if (idx >= 0) {
            g_accounts.erase(g_accounts.begin() + idx);
            if (g_autoUser == user) g_autoUser.clear();
            saveCreds();
        }
        return;
    }

    SavedAccount s;
    s.user = user;
    s.pass = pass;
    s.nick = nick;
    s.remember = true;

    if (idx >= 0) {
        g_accounts[(size_t)idx] = s;
    } else {
        g_accounts.insert(g_accounts.begin(), s);
    }
    /* 最近使用的排最前 */
    idx = findAccount(user);
    if (idx > 0) {
        g_accounts.erase(g_accounts.begin() + idx);
        g_accounts.insert(g_accounts.begin(), s);
    }
    g_activeIdx = 0;
    g_autoUser = g_cbAuto ? user : std::string();
    saveCreds();
}

static void forgetAccount(const std::string& user) {
    int idx = findAccount(user);
    if (idx < 0) return;
    g_accounts.erase(g_accounts.begin() + idx);
    if (g_autoUser == user) g_autoUser.clear();
    if (g_activeIdx >= (int)g_accounts.size()) g_activeIdx = (int)g_accounts.size() - 1;
    saveCreds();
}

/* 工作线程 */
static CRITICAL_SECTION g_cs;
static std::deque<std::function<void()> > g_jobs;

/* 工作线程投递 / 结果回收（定义在下方，头像下载要用） */
static void deliver(AsyncResult* r);
static void postJob(std::function<void()> fn);

/* ---------------- 头像缓存（url → GDI+ 图像） ---------------- */
static std::map<std::string, void*> g_avatars;
static std::set<std::string> g_avPending;   // 正在下载的头像，避免重复请求
static std::set<std::string> g_avFailed;    // 下载失败过的，不再重试

/** 取头像：有缓存返回图像，否则丢一个下载任务到后台 */
static void* avatarImage(const std::string& url) {
    if (url.empty()) return NULL;
    std::map<std::string, void*>::iterator it = g_avatars.find(url);
    if (it != g_avatars.end()) return it->second;
    if (g_avFailed.count(url) || g_avPending.count(url)) return NULL;
    g_avPending.insert(url);
    postJob([url]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_AVATAR_GET;
        r->avatarUrl = url;
        r->ok = g_api.downloadAvatar(url, r->bytes);
        r->error = g_api.lastError();
        deliver(r);
    });
    return NULL;
}

static void clearAvatarCache() {
    for (std::map<std::string, void*>::iterator it = g_avatars.begin();
         it != g_avatars.end(); ++it) {
        freeImage(it->second);
    }
    g_avatars.clear();
    g_avPending.clear();
    g_avFailed.clear();
}

/* ---------------- 下载保存位置 ---------------- */
static std::wstring g_downloadDir;   // 空 = Windows「下载」文件夹

static std::wstring defaultDownloadDir() {
    wchar_t buf[MAX_PATH] = {0};
    // 系统「下载」文件夹：<用户目录>\Downloads；不存在时退回「文档」
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_PROFILE, NULL, 0, buf))) {
        std::wstring d = std::wstring(buf) + L"\\Downloads";
        DWORD attr = GetFileAttributesW(d.c_str());
        if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) return d;
    }
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_MYDOCUMENTS, NULL, 0, buf))) return buf;
    return L".";
}

static void loadDownloadDirPref() {
    FILE* fp = _wfopen(configFile(L"prefs.txt").c_str(), L"rb");
    if (!fp) { g_downloadDir = defaultDownloadDir(); return; }
    char buf[1024] = {0};
    size_t n = fread(buf, 1, sizeof(buf) - 1, fp);
    fclose(fp);
    std::string body(buf, n);
    std::string v = body;
    size_t pos = v.find("downloaddir=");
    if (pos != std::string::npos) {
        std::string line = v.substr(pos + 12);
        size_t e = line.find('\n');
        if (e != std::string::npos) line = line.substr(0, e);
        while (!line.empty() && line[line.size()-1] == '\r') line.erase(line.size()-1);
        if (!line.empty()) { g_downloadDir = wide(line); return; }
    }
    g_downloadDir = defaultDownloadDir();
}

static void saveDownloadDirPref() {
    std::string body = "downloaddir=" + utf8(g_downloadDir) + "\n";
    FILE* fp = _wfopen(configFile(L"prefs.txt").c_str(), L"wb");
    if (!fp) return;
    fwrite(body.data(), 1, body.size(), fp);
    fclose(fp);
}
static HANDLE g_evtJob = NULL;

/* ================================================================== */
/* 小工具                                                              */
/* ================================================================== */

static int Dpi() {
    HDC dc = GetDC(NULL);
    int d = GetDeviceCaps(dc, LOGPIXELSX);
    ReleaseDC(NULL, dc);
    return d > 0 ? d : 96;
}

static HFONT makeFont(int px, bool bold) {
    LOGFONTW lf = {0};
    lf.lfHeight = -(int)(px * Dpi() / 96.0);
    lf.lfWeight = bold ? FW_SEMIBOLD : FW_NORMAL;
    lf.lfCharSet = DEFAULT_CHARSET;
    lf.lfQuality = CLEARTYPE_QUALITY;
    wcscpy(lf.lfFaceName, L"Microsoft YaHei UI");
    return CreateFontIndirectW(&lf);
}

static std::wstring fmtTime(long long ms) {
    if (ms <= 0) return L"";
    time_t t = (time_t)(ms / 1000);
    struct tm* lt = localtime(&t);
    struct tm tmv = lt ? *lt : tm();
    wchar_t buf[32];
    // 今天的消息只显示时分，更早的显示月-日 时:分
    time_t nowT = time(NULL);
    struct tm* nt = localtime(&nowT);
    struct tm nowTm = nt ? *nt : tm();
    if (tmv.tm_year == nowTm.tm_year && tmv.tm_yday == nowTm.tm_yday) {
        swprintf(buf, 32, L"%02d:%02d", tmv.tm_hour, tmv.tm_min);
    } else {
        swprintf(buf, 32, L"%d月%d日 %02d:%02d", tmv.tm_mon + 1, tmv.tm_mday,
                 tmv.tm_hour, tmv.tm_min);
    }
    return buf;
}

static std::wstring fmtSize(long long bytes) {
    wchar_t buf[64];
    if (bytes < 1024) swprintf(buf, 64, L"%lld B", bytes);
    else if (bytes < 1024 * 1024) swprintf(buf, 64, L"%.1f KB", bytes / 1024.0);
    else swprintf(buf, 64, L"%.1f MB", bytes / 1048576.0);
    return buf;
}

/* hsl(210,52%,52%) → COLORREF；服务端下发的头像色就是这个格式 */
static COLORREF parseHsl(const std::string& s) {
    int h = 210, sa = 52, li = 52;
    sscanf(s.c_str(), "hsl(%d,%d%%,%d%%)", &h, &sa, &li);
    double H = h / 360.0, S = sa / 100.0, L = li / 100.0;
    double q = L < 0.5 ? L * (1 + S) : L + S - L * S;
    double p = 2 * L - q;
    double t[3] = {H + 1.0 / 3, H, H - 1.0 / 3};
    double rgb[3];
    for (int i = 0; i < 3; ++i) {
        double v = t[i];
        if (v < 0) v += 1;
        if (v > 1) v -= 1;
        if (v < 1.0 / 6) rgb[i] = p + (q - p) * 6 * v;
        else if (v < 0.5) rgb[i] = q;
        else if (v < 2.0 / 3) rgb[i] = p + (q - p) * (2.0 / 3 - v) * 6;
        else rgb[i] = p;
    }
    return RGB((int)(rgb[0] * 255), (int)(rgb[1] * 255), (int)(rgb[2] * 255));
}

static void fillRect(HDC dc, const RECT& r, COLORREF c) {
    HBRUSH b = CreateSolidBrush(c);
    FillRect(dc, &r, b);
    DeleteObject(b);
}

static void roundRect(HDC dc, const RECT& r, int radius, COLORREF fill, COLORREF border) {
    HBRUSH b = CreateSolidBrush(fill);
    HPEN p = CreatePen(PS_SOLID, 1, border);
    HGDIOBJ ob = SelectObject(dc, b);
    HGDIOBJ op = SelectObject(dc, p);
    RoundRect(dc, r.left, r.top, r.right, r.bottom, radius * 2, radius * 2);
    SelectObject(dc, ob);
    SelectObject(dc, op);
    DeleteObject(b);
    DeleteObject(p);
}

static void textOut(HDC dc, const std::wstring& s, RECT r, COLORREF c, HFONT f,
                    UINT fmt = DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX) {
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, c);
    HGDIOBJ old = SelectObject(dc, f);
    DrawTextW(dc, s.c_str(), (int)s.size(), &r, fmt);
    SelectObject(dc, old);
}

static int measureText(HDC dc, const std::wstring& s, int maxW, HFONT f) {
    RECT r = {0, 0, maxW, 0};
    HGDIOBJ old = SelectObject(dc, f);
    DrawTextW(dc, s.c_str(), (int)s.size(), &r, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
    SelectObject(dc, old);
    return r.bottom - r.top;
}

static bool inRect(const RECT& r, int x, int y) {
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
}

/* 极简诊断日志：%TEMP%\ql_native.log，出问题时有据可查 */
static void dbg(const char* fmt, ...) {
    wchar_t tmp[MAX_PATH] = {0};
    GetTempPathW(MAX_PATH, tmp);
    std::wstring p = std::wstring(tmp) + L"ql_native.log";
    FILE* fp = _wfopen(p.c_str(), L"a");
    if (!fp) return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(fp, fmt, ap);
    va_end(ap);
    fprintf(fp, "\n");
    fclose(fp);
}

/* ================================================================== */
/* 工作线程                                                            */
/* ================================================================== */

static void deliver(AsyncResult* r) {
    PostMessage(g_hwnd, WM_QL_RESULT, 0, (LPARAM)r);
}

static void postJob(std::function<void()> fn) {
    EnterCriticalSection(&g_cs);
    g_jobs.push_back(fn);
    LeaveCriticalSection(&g_cs);
    SetEvent(g_evtJob);
}

static DWORD WINAPI workerProc(LPVOID) {
    for (;;) {
        WaitForSingleObject(g_evtJob, INFINITE);
        for (;;) {
            std::function<void()> job;
            EnterCriticalSection(&g_cs);
            if (g_jobs.empty()) {
                ResetEvent(g_evtJob);
                LeaveCriticalSection(&g_cs);
                break;
            }
            job = g_jobs.front();
            g_jobs.pop_front();
            LeaveCriticalSection(&g_cs);
            job();
        }
    }
    return 0;
}

static std::wstring getEditText(HWND ed) {
    int n = GetWindowTextLengthW(ed);
    if (n <= 0) return L"";
    std::wstring s((size_t)n + 1, L'\0');
    GetWindowTextW(ed, &s[0], n + 1);
    s.resize((size_t)n);
    return s;
}

/* ================================================================== */
/* 异步动作                                                            */
/* ================================================================== */

static void setStatus(const std::wstring& s) {
    g_statusW = s;
    InvalidateRect(g_hwnd, NULL, FALSE);
}

static void doLogin(const std::string& user, const std::string& pass) {
    g_busy = true;
    setStatus(L"正在登录…");
    postJob([user, pass]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_LOGIN;
        r->ok = g_api.login(user, pass);
        r->error = g_api.lastError();
        deliver(r);
    });
}

static void doRegister(const std::string& user, const std::string& pass, const std::string& nick) {
    g_busy = true;
    setStatus(L"正在注册…");
    postJob([user, pass, nick]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_REGISTER;
        r->ok = g_api.regist(user, pass, nick);
        r->error = g_api.lastError();
        deliver(r);
    });
}

static void loadRooms() {
    postJob([]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_ROOMS;
        r->ok = g_api.fetchRooms(r->rooms, r->publicId);
        r->error = g_api.lastError();
        deliver(r);
    });
}

static void loadMessages(bool full) {
    std::string room = g_roomId;
    long long since = full ? 0 : g_page.lastSeq;
    if (room.empty()) return;
    postJob([room, since, full]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_MSGS;
        r->ok = g_api.fetchMessages(room, since, full ? 80 : 60, r->page);
        r->error = g_api.lastError();
        r->text = full ? "full" : "inc";
        deliver(r);
    });
}

static void sendCurrentText() {
    if (g_roomId.empty() || g_busy) return;
    if (!g_page.canPost) {
        setStatus(g_page.muted ? L"你已被禁言，暂时不能发言" : L"当前不能发言");
        return;
    }
    std::wstring w = getEditText(g_edInput);
    while (!w.empty() && (w[w.size() - 1] == L'\r' || w[w.size() - 1] == L'\n')) w.erase(w.size() - 1);
    if (w.empty()) return;
    std::string text = utf8(w);
    if (text.size() > 4000) {
        setStatus(L"单条消息最多 4000 字");
        return;
    }
    SetWindowTextW(g_edInput, L"");
    std::string room = g_roomId;
    g_busy = true;
    setStatus(L"发送中…");
    postJob([room, text]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_SEND;
        r->ok = g_api.sendText(room, text, r->msg);
        r->error = g_api.lastError();
        deliver(r);
    });
}

struct UploadCtx {
    HWND hwnd;
};

static void uploadPickedFile(const std::wstring& path) {
    std::string room = g_roomId;
    if (room.empty()) return;
    g_busy = true;
    setStatus(L"正在上传…");
    postJob([room, path]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_UPLOAD;
        UploadCtx ctx;
        ctx.hwnd = g_hwnd;
        r->ok = g_api.uploadFile(room, path, NULL, NULL, r->up);
        r->error = g_api.lastError();
        if (r->ok) {
            // 上传完成后立刻把文件发成一条消息
            Message m;
            if (g_api.sendFileMessage(room, r->up.fileId, "", m)) {
                r->msg = m;
            } else {
                r->ok = false;
                r->error = g_api.lastError();
            }
        }
        deliver(r);
    });
}

static void pickAndUpload() {
    if (g_roomId.empty()) return;
    wchar_t path[MAX_PATH] = {0};
    OPENFILENAMEW ofn = {0};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = g_hwnd;
    ofn.lpstrFile = path;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrFilter = L"所有文件\0*.*\0图片\0*.png;*.jpg;*.jpeg;*.gif;*.webp\0";
    ofn.nFilterIndex = 1;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (!GetOpenFileNameW(&ofn)) return;
    uploadPickedFile(path);
}

static void saveFileTo(const Message& m) {
    if (!m.hasFile || m.file.deleted) return;
    // 直接存到「下载保存位置」（设置里可改，默认 Windows 下载文件夹），重名自动编号
    std::wstring dir = g_downloadDir.empty() ? defaultDownloadDir() : g_downloadDir;
    std::wstring base = wide(m.file.name);
    std::wstring save = dir + L"\\" + base;
    DWORD attr = GetFileAttributesW(save.c_str());
    if (attr != INVALID_FILE_ATTRIBUTES) {
        size_t dot = base.find_last_of(L'.');
        std::wstring stem = (dot == std::wstring::npos) ? base : base.substr(0, dot);
        std::wstring ext = (dot == std::wstring::npos) ? L"" : base.substr(dot);
        for (int i = 2; i < 1000; ++i) {
            wchar_t num[16];
            swprintf(num, 16, L" (%d)", i);
            save = dir + L"\\" + stem + num + ext;
            if (GetFileAttributesW(save.c_str()) == INVALID_FILE_ATTRIBUTES) break;
        }
    }

    std::string url = m.file.dlUrl.empty() ? m.file.url : m.file.dlUrl;
    setStatus(L"正在下载…");
    g_busy = true;
    postJob([url, save]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_DOWNLOAD;
        r->ok = g_api.downloadFile(url, save);
        r->error = g_api.lastError();
        deliver(r);
    });
}

static void openRoom(const Room& r) {
    g_roomId = r.id;
    g_roomName = r.name;
    g_page = MessagePage();
    g_layouts.clear();
    g_scrollY = 0;
    g_atBottom = true;
    setStatus(L"正在加载消息…");
    loadMessages(true);
}

/* ================================================================== */
/* 布局与绘制                                                          */
/* ================================================================== */

static void relayoutMessages(HDC dc, int viewW) {
    g_layouts.clear();
    int y = 10;
    const int GUTTER = 48;                                   // 左侧头像占位
    int maxBubble = (int)((viewW - GUTTER - 64) * 0.72);
    if (maxBubble < 180) maxBubble = 180;

    std::string lastSender;
    for (size_t i = 0; i < g_page.messages.size(); ++i) {
        const Message& m = g_page.messages[i];
        MsgLayout L;
        L.index = i;
        L.hasSave = false;
        L.showName = false;
        L.showAvatar = false;
        L.saveBtn = RECT();
        L.bubble = RECT();

        if (m.kind == "system") {
            int h = measureText(dc, wide(m.content), viewW - 80, g_fontSmall);
            L.top = y;
            L.height = h + 14;
            y += L.height;
            g_layouts.push_back(L);
            continue;
        }

        /* 同一个人连续发消息只画一次头像/名字，列表更清爽（微信/QQ 同款） */
        bool showName = !m.mine && (m.senderId != lastSender);
        bool showAvatar = (m.senderId != lastSender);
        lastSender = m.senderId;
        L.showName = showName;
        L.showAvatar = showAvatar;
        int nameH = showName ? 22 : 8;
        if (m.mine) nameH = 6;

        const int padV = 11, padH = 14;
        int contentH = 0, bw = 0;

        if (m.hasFile && !m.file.deleted) {
            bw = 300;
            if (bw > maxBubble) bw = maxBubble;
            int inner = bw - padH * 2;
            contentH = measureText(dc, wide(m.file.name), inner, g_fontUI) +
                       measureText(dc, L"\u4e00g", inner, g_fontSmall) + 2;
            L.hasSave = true;
        } else {
            std::wstring c = wide(m.content);
            if (m.recalled) c = L"这条消息已被撤回";
            else if (m.hasFile) c = L"[文件已删除]";

            contentH = measureText(dc, c, maxBubble - padH * 2, g_fontUI);
            RECT calc = {0, 0, maxBubble - padH * 2, 0};
            HGDIOBJ old = SelectObject(dc, g_fontUI);
            DrawTextW(dc, c.c_str(), (int)c.size(), &calc,
                      DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
            SelectObject(dc, old);
            bw = (calc.right - calc.left) + padH * 2;
            if (bw < 56) bw = 56;
            if (bw > maxBubble) bw = maxBubble;
        }

        int bubbleH = contentH + padV * 2;
        // 左右对称留 48px 头像槽，自己发的头像画右侧，不与气泡重叠
        int bx = m.mine ? (viewW - GUTTER - bw) : GUTTER;

        L.top = y;
        L.bubble.left = bx;
        L.bubble.top = y + nameH;
        L.bubble.right = bx + bw;
        L.bubble.bottom = y + nameH + bubbleH;
        L.height = nameH + bubbleH + 10;
        if (L.hasSave) L.saveBtn = L.bubble;

        y += L.height;
        g_layouts.push_back(L);
    }
    g_contentH = y + 6;
}

/* ---------------- 登录卡片几何 ---------------- */

/* 有已记住密码的账号、且不是要新增账号时，登录页显示「选择账号登录」 */
static bool loginUsePicker() {
    return !g_registerMode && !g_addingAccount && !g_accounts.empty();
}

static RECT loginCardRect(int w, int h) {
    bool picker = loginUsePicker();
    int cardW = picker ? 440 : 400;
    int cardH = picker ? 376 : (g_registerMode ? 468 : 402);
    int cx = (w - cardW) / 2;
    int cy = (h - cardH) / 2 - 8;
    if (cy < 16) cy = 16;
    return RECT{cx, cy, cx + cardW, cy + cardH};
}

static int loginFieldCount() { return g_registerMode ? 3 : 2; }

static RECT loginFieldRect(int idx, int w, int h) {
    RECT c = loginCardRect(w, h);
    int y = c.top + 162 + idx * 66;
    return RECT{c.left + 36, y, c.right - 36, y + 42};
}

static int loginBtnY(int w, int h) {
    RECT c = loginCardRect(w, h);
    if (loginUsePicker()) return c.top + 250;
    return c.top + (g_registerMode ? 376 : 310);
}

static void paintCheckbox(HDC dc, int x, int y, bool on, const std::wstring& label,
                          RECT& hit) {
    int s = 16;
    RECT box = {x, y, x + s, y + s};
    if (on) {
        roundRect(dc, box, 4, C_ACCENT, C_ACCENT);
        HPEN pen = CreatePen(PS_SOLID, 2, RGB(255, 255, 255));
        HGDIOBJ old = SelectObject(dc, pen);
        MoveToEx(dc, x + 4, y + 8, NULL);
        LineTo(dc, x + 7, y + 12);
        LineTo(dc, x + 12, y + 5);
        SelectObject(dc, old);
        DeleteObject(pen);
    } else {
        roundRect(dc, box, 4, C_CARD, RGB(198, 204, 212));
    }
    RECT lr = {x + s + 7, y - 2, x + s + 7 + 100, y + s + 2};
    textOut(dc, label, lr, C_SUB, g_fontSmall, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    hit = RECT{x, y - 6, lr.right, y + s + 6};
}

/* 圆形头像 + 首字；selected 时加蓝环与右下角勾选徽章 */
static void paintAvatar(HDC dc, const RECT& ar, const std::wstring& initial, bool selected) {
    COLORREF fill = selected ? C_ACCENT : RGB(226, 229, 234);
    COLORREF text = selected ? RGB(255, 255, 255) : RGB(138, 146, 158);

    if (selected) {
        HPEN ring = CreatePen(PS_SOLID, 2, RGB(150, 190, 250));
        HGDIOBJ op = SelectObject(dc, ring);
        HGDIOBJ ob = SelectObject(dc, GetStockObject(NULL_BRUSH));
        Ellipse(dc, ar.left - 4, ar.top - 4, ar.right + 4, ar.bottom + 4);
        SelectObject(dc, op);
        SelectObject(dc, ob);
        DeleteObject(ring);
    }

    HBRUSH b = CreateSolidBrush(fill);
    HGDIOBJ ob = SelectObject(dc, b);
    HGDIOBJ op = SelectObject(dc, GetStockObject(NULL_PEN));
    Ellipse(dc, ar.left, ar.top, ar.right, ar.bottom);
    SelectObject(dc, ob);
    SelectObject(dc, op);
    DeleteObject(b);

    textOut(dc, initial, ar, text, g_fontH1, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    if (selected) {
        RECT bd = {ar.right - 24, ar.bottom - 24, ar.right - 2, ar.bottom - 2};
        HBRUSH wb = CreateSolidBrush(C_ACCENT);
        HGDIOBJ ob2 = SelectObject(dc, wb);
        HGDIOBJ op2 = SelectObject(dc, GetStockObject(NULL_PEN));
        Ellipse(dc, bd.left, bd.top, bd.right, bd.bottom);
        SelectObject(dc, ob2);
        SelectObject(dc, op2);
        DeleteObject(wb);

        HPEN pen = CreatePen(PS_SOLID, 2, RGB(255, 255, 255));
        HGDIOBJ old = SelectObject(dc, pen);
        int cx = (bd.left + bd.right) / 2, cy = (bd.top + bd.bottom) / 2;
        MoveToEx(dc, cx - 5, cy, NULL);
        LineTo(dc, cx - 1, cy + 4);
        LineTo(dc, cx + 5, cy - 4);
        SelectObject(dc, old);
        DeleteObject(pen);
    }
}

/* -------- 账号选择模式（QQ 式：头像横排，点选后登录） -------- */
static void paintAccountPicker(HDC dc, const RECT& rc) {
    fillRect(dc, rc, C_BG);

    RECT card = loginCardRect(rc.right, rc.bottom);
    roundRect(dc, card, 16, C_CARD, C_LINE);

    RECT t = {card.left, card.top + 26, card.right, card.top + 56};
    textOut(dc, L"选择账号登录", t, C_TEXT, g_fontH1,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    int n = (int)g_accounts.size();
    if (n > 4) n = 4;  // 卡片宽度有限，最多并排 4 个 + 一个「+」
    int av = 68, gap = 22;
    int cells = n + 1;
    int totalW = cells * av + (cells - 1) * gap;
    int startX = card.left + (card.right - card.left - totalW) / 2;
    int y = card.top + 92;

    POINT pt;
    GetCursorPos(&pt);
    ScreenToClient(g_hwnd, &pt);

    g_avRects.clear();
    for (int i = 0; i < n; ++i) {
        int x = startX + i * (av + gap);
        RECT ar = {x, y, x + av, y + av};
        g_avRects.push_back(ar);

        const SavedAccount& a = g_accounts[(size_t)i];
        std::wstring wn = wide(a.nick.empty() ? a.user : a.nick);
        std::wstring ini = wn.substr(0, 2);  // 头像里两字最合适，三字会顶满
        bool sel = (i == g_activeIdx);
        paintAvatar(dc, ar, ini, sel);

        if (inRect(ar, pt.x, pt.y) && !sel) {
            // 悬停提示：浅色描边
            HPEN p = CreatePen(PS_SOLID, 1, RGB(180, 200, 230));
            HGDIOBJ op = SelectObject(dc, p);
            HGDIOBJ ob = SelectObject(dc, GetStockObject(NULL_BRUSH));
            Ellipse(dc, ar.left - 2, ar.top - 2, ar.right + 2, ar.bottom + 2);
            SelectObject(dc, op);
            SelectObject(dc, ob);
            DeleteObject(p);
        }

        RECT nr = {ar.left - 14, ar.bottom + 8, ar.right + 14, ar.bottom + 28};
        textOut(dc, wn, nr, sel ? C_TEXT : C_MUTED,
                sel ? g_fontBold : g_fontSmall,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    }

    /* 「+」添加账号 */
    int px = startX + n * (av + gap);
    g_addRect = RECT{px, y, px + av, y + av};
    roundRect(dc, g_addRect, 34, RGB(247, 248, 250), RGB(222, 226, 232));
    textOut(dc, L"＋", g_addRect, RGB(150, 158, 168), g_fontTitle,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    RECT an = {g_addRect.left - 14, g_addRect.bottom + 8, g_addRect.right + 14,
               g_addRect.bottom + 28};
    textOut(dc, L"添加账号", an, C_MUTED, g_fontSmall,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    /* 自动登录 */
    int cbY = card.top + 202;
    int cbW = 16 + 7 + 56;
    int cbX = card.left + (card.right - card.left - cbW) / 2;
    paintCheckbox(dc, cbX, cbY, g_cbAuto, L"自动登录", g_cbAutoR);
    g_cbRememberR = RECT();  // 选择器里没有「记住密码」

    /* 登录按钮 */
    int btnY = loginBtnY(rc.right, rc.bottom);
    RECT btn = {card.left + 36, btnY, card.right - 36, btnY + 48};
    g_btnLogin = btn;
    bool hov = inRect(btn, pt.x, pt.y);
    roundRect(dc, btn, 10, hov ? RGB(23, 95, 205) : C_ACCENT,
              hov ? RGB(23, 95, 205) : C_ACCENT);
    textOut(dc, g_busy ? L"请稍候…" : L"登录", btn, RGB(255, 255, 255), g_fontH1,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    /* 底部：其他登录方式 | 账号管理 */
    int ly = card.top + 316;
    int mid = (card.left + card.right) / 2;
    g_linkAlt = RECT{card.left + 36, ly, mid - 12, ly + 22};
    g_linkManage = RECT{mid + 12, ly, card.right - 36, ly + 22};
    textOut(dc, L"其他登录方式", g_linkAlt, C_ACCENT, g_fontSmall,
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER);
    textOut(dc, L"账号管理", g_linkManage, C_ACCENT, g_fontSmall,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    RECT sep = {mid - 1, ly + 4, mid, ly + 18};
    fillRect(dc, sep, C_LINE);

    if (!g_loginErr.empty()) {
        RECT er = {card.left + 24, btnY - 26, card.right - 24, btnY - 6};
        textOut(dc, g_loginErr, er, C_DANGER, g_fontSmall,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    }

    RECT vb = {0, rc.bottom - 28, rc.right, rc.bottom - 6};
    textOut(dc, L"轻聊原生客户端 · Windows", vb, C_MUTED, g_fontSmall,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

/* -------- 手动输入模式（首次登录 / 注册 / 添加账号） -------- */
static void paintLoginForm(HDC dc, const RECT& rc) {
    fillRect(dc, rc, C_BG);

    RECT card = loginCardRect(rc.right, rc.bottom);
    roundRect(dc, card, 14, C_CARD, C_LINE);

    int logoSz = 46;
    RECT logo = {(card.left + card.right - logoSz) / 2, card.top + 24,
                 (card.left + card.right - logoSz) / 2 + logoSz, card.top + 24 + logoSz};
    roundRect(dc, logo, 12, C_ACCENT, C_ACCENT);
    textOut(dc, L"轻", logo, RGB(255, 255, 255), g_fontH1,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    RECT t = {card.left, card.top + 82, card.right, card.top + 110};
    textOut(dc, L"轻聊", t, C_TEXT, g_fontH1, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    RECT st = {card.left, card.top + 112, card.right, card.top + 134};
    textOut(dc, g_registerMode ? L"创建账号，开始聊天" : L"登录后即可收发消息", st, C_SUB,
            g_fontSmall, DT_CENTER | DT_SINGLELINE);

    static const wchar_t* labels[3] = {L"账号", L"密码", L"昵称"};
    for (int i = 0; i < loginFieldCount(); ++i) {
        RECT f = loginFieldRect(i, rc.right, rc.bottom);
        RECT lr = {f.left + 2, f.top - 20, f.right, f.top - 2};
        textOut(dc, labels[i], lr, C_SUB, g_fontSmall, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        roundRect(dc, f, 9, RGB(247, 248, 250), RGB(222, 226, 232));
    }

    int cbY = card.top + (g_registerMode ? 348 : 282);
    paintCheckbox(dc, card.left + 36, cbY, g_cbRemember, L"记住密码", g_cbRememberR);
    paintCheckbox(dc, card.left + 174, cbY, g_cbAuto, L"自动登录", g_cbAutoR);

    int btnY = loginBtnY(rc.right, rc.bottom);
    RECT btn = {card.left + 36, btnY, card.right - 36, btnY + 46};
    g_btnLogin = btn;
    POINT pt;
    GetCursorPos(&pt);
    ScreenToClient(g_hwnd, &pt);
    bool hov = inRect(btn, pt.x, pt.y);
    COLORREF bc = hov ? RGB(23, 95, 205) : C_ACCENT;
    roundRect(dc, btn, 9, bc, bc);
    textOut(dc, g_busy ? L"请稍候…" : (g_registerMode ? L"注册并登录" : L"登录"),
            btn, RGB(255, 255, 255), g_fontBold, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    RECT sw = {card.left + 36, btnY + 56, card.right - 36, btnY + 80};
    g_btnSwitch = sw;
    std::wstring link;
    if (g_registerMode) link = L"已有账号？返回登录";
    else if (!g_accounts.empty()) link = L"返回账号选择";
    else link = L"没有账号？立即注册";
    textOut(dc, link, sw, C_ACCENT, g_fontSmall, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    if (!g_loginErr.empty()) {
        RECT er = {card.left + 24, btnY - 24, card.right - 24, btnY - 4};
        textOut(dc, g_loginErr, er, C_DANGER, g_fontSmall,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    }

    RECT vb = {0, rc.bottom - 28, rc.right, rc.bottom - 6};
    textOut(dc, L"轻聊原生客户端 · Windows", vb, C_MUTED, g_fontSmall,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

static void paintLogin(HDC dc, const RECT& rc) {
    if (loginUsePicker()) {
        g_btnSwitch = RECT();
        paintAccountPicker(dc, rc);
    } else {
        g_linkAlt = RECT();
        g_linkManage = RECT();
        g_addRect = RECT();
        g_avRects.clear();
        paintLoginForm(dc, rc);
    }
}

static void paintSidebar(HDC dc, const RECT& side) {
    fillRect(dc, side, C_SIDE);

    /* 顶部署名 */
    User u = g_api.user();
    int av = 34;
    RECT avR = {16, 16, 16 + av, 16 + av};
    void* avImg = avatarImage(u.avatar);
    if (avImg) {
        drawImageCircle(dc, avImg, avR);
    } else {
        COLORREF ac = parseHsl(u.avatarColor);
        HBRUSH ab = CreateSolidBrush(ac);
        HGDIOBJ ob = SelectObject(dc, ab);
        HGDIOBJ op = SelectObject(dc, GetStockObject(NULL_PEN));
        Ellipse(dc, avR.left, avR.top, avR.right, avR.bottom);
        SelectObject(dc, ob);
        SelectObject(dc, op);
        DeleteObject(ab);
        RECT iniR = avR;
        textOut(dc, wide(u.initial.empty() ? "?" : u.initial), iniR, RGB(255, 255, 255),
                g_fontBold, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    }
    if (u.founder) drawGoldRing(dc, avR);   // 刘子墨：侧栏头像也戴金环

    RECT nm = {16 + av + 10, 18, side.right - 56, 40};
    textOut(dc, wide(u.nickname.empty() ? u.username : u.nickname), nm, C_TEXT, g_fontBold,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    RECT un = {16 + av + 10, 38, side.right - 56, 56};
    textOut(dc, L"@" + wide(u.username), un, C_MUTED, g_fontSmall,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    RECT setR = {side.right - 46, 20, side.right - 16, 46};
    g_btnSettings = setR;
    textOut(dc, L"⚙", setR, C_SUB, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    /* 分隔 */
    RECT line = {0, 68, side.right, 69};
    fillRect(dc, line, C_LINE);

    /* 房间列表 */
    int y = 78;
    int itemH = 56;
    RECT listClip = {0, 70, side.right, side.bottom - 56};
    HRGN clip = CreateRectRgn(listClip.left, listClip.top, listClip.right, listClip.bottom);
    SelectClipRgn(dc, clip);

    g_hoverRoom = -1;
    POINT pt;
    GetCursorPos(&pt);
    ScreenToClient(g_hwnd, &pt);

    for (size_t i = 0; i < g_rooms.size(); ++i) {
        const Room& r = g_rooms[i];
        RECT it = {0, y, side.right, y + itemH};
        if (it.top > listClip.bottom) break;

        bool active = (r.id == g_roomId);
        if (active) {
            fillRect(dc, it, C_ACTIVE);
        } else if (inRect(it, pt.x, pt.y)) {
            fillRect(dc, it, C_HOVER);
            g_hoverRoom = (int)i;
        }

        /* 房间头像：公共大厅用蓝色，群用灰蓝 */
        int sz = 34;
        RECT av2 = {16, y + 11, 16 + sz, y + 11 + sz};
        COLORREF rc2 = (r.kind == "public") ? C_ACCENT : RGB(120, 132, 148);
        if (r.id == g_roomId) rc2 = C_ACCENT;
        roundRect(dc, av2, 8, rc2, rc2);
        std::wstring inis = L"#";
        if (r.kind == "dm") inis = L"私";
        else if (r.kind == "public") inis = L"公";
        textOut(dc, inis, av2, RGB(255, 255, 255), g_fontSmall,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        RECT rn = {16 + sz + 10, y + 10, side.right - 58, y + 34};
        textOut(dc, wide(r.name), rn, C_TEXT, g_fontUI,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

        std::wstring sub;
        if (r.dissolved) sub = L"已解散";
        else if (r.kind == "public") sub = L"所有人在此";
        else {
            wchar_t b[48];
            swprintf(b, 48, L"%d 人", r.memberCount);
            sub = b;
        }
        if (r.hasPassword) sub += L" · 🔒";
        RECT rs = {16 + sz + 10, y + 32, side.right - 16, y + 52};
        textOut(dc, sub, rs, C_MUTED, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

        /* 人数徽标 */
        y += itemH;
    }
    SelectClipRgn(dc, NULL);
    DeleteObject(clip);

    /* 底部两颗按钮：搜索房间 | 新建房间 */
    int half = (side.right - 36) / 2;
    RECT sb = {12, side.bottom - 48, 12 + half, side.bottom - 12};
    g_btnSearchRoom = sb;
    bool hov = inRect(sb, pt.x, pt.y);
    roundRect(dc, sb, 8, hov ? C_ACCENT_DIM : C_CARD, C_LINE);
    textOut(dc, L"搜索房间", sb, C_ACCENT, g_fontUI,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    RECT nb = {20 + half, side.bottom - 48, side.right - 12, side.bottom - 12};
    g_btnNew = nb;
    hov = inRect(nb, pt.x, pt.y);
    roundRect(dc, nb, 8, hov ? C_ACCENT_DIM : C_CARD, C_LINE);
    textOut(dc, L"＋ 新建", nb, C_ACCENT, g_fontUI,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

static void paintChat(HDC dc, const RECT& chat) {
    fillRect(dc, chat, C_BG);

    /* 顶部栏 */
    RECT hd = {chat.left, 0, chat.right, HEADER_H};
    fillRect(dc, hd, C_CARD);
    RECT hl = {chat.left, HEADER_H - 1, chat.right, HEADER_H};
    fillRect(dc, hl, C_LINE);

    textOut(dc, wide(g_roomName.empty() ? "选择一个房间" : g_roomName),
            RECT{chat.left + 20, 10, chat.right - 200, 38}, C_TEXT, g_fontBold,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    std::wstring sub;
    if (!g_roomId.empty()) {
        if (g_page.dissolved) sub = L"该房间已解散，仅可查看历史";
        else {
            wchar_t b[96];
            swprintf(b, 96, L"%d 条消息%s", g_page.total, g_page.roleName.empty() ? L"" : L" · ");
            sub = b;
            if (!g_page.roleName.empty()) sub += wide(g_page.roleName);
        }
    }
    textOut(dc, sub, RECT{chat.left + 20, 32, chat.right - 200, 50}, C_MUTED, g_fontSmall,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    POINT pt;
    GetCursorPos(&pt);
    ScreenToClient(g_hwnd, &pt);

    RECT rf = {chat.right - 96, 12, chat.right - 16, 44};
    g_btnRefresh = rf;
    roundRect(dc, rf, 6, inRect(rf, pt.x, pt.y) ? C_HOVER : C_CARD, C_LINE);
    textOut(dc, L"刷新", rf, C_SUB, g_fontSmall, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    // 群管理入口（成员/禁言/踢出/转让/解散），与网页版能力同步
    RECT mg = {chat.right - 196, 12, chat.right - 104, 44};
    g_btnMembers = mg;
    roundRect(dc, mg, 6, inRect(mg, pt.x, pt.y) ? C_HOVER : C_CARD, C_LINE);
    textOut(dc, L"群管理", mg, C_SUB, g_fontSmall, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    /* -------- 消息区 -------- */
    RECT view = {chat.left, HEADER_H, chat.right, chat.bottom - INPUT_H};
    int viewW = view.right - view.left;
    int viewH = view.bottom - view.top;

    HRGN clip = CreateRectRgn(view.left, view.top, view.right, view.bottom);
    SelectClipRgn(dc, clip);

    relayoutMessages(dc, viewW);

    /* 自上而下：内容从视口顶部往下排（微信/QQ 同款），滚到底看新消息 */
    int maxScroll = g_contentH + 16 - viewH;
    if (maxScroll < 0) maxScroll = 0;
    if (g_scrollY > maxScroll) g_scrollY = maxScroll;
    if (g_scrollY < 0) g_scrollY = 0;
    g_atBottom = (g_scrollY >= maxScroll);
    int baseY = view.top + 8 - g_scrollY;

    for (size_t i = 0; i < g_layouts.size(); ++i) {
        const MsgLayout& L = g_layouts[i];
        int top = baseY + L.top;
        if (top > view.bottom || top + L.height < view.top) continue;
        const Message& m = g_page.messages[L.index];

        if (m.kind == "system") {
            RECT sr = {view.left, top + 4, view.right, top + L.height};
            textOut(dc, wide(m.content), sr, C_MUTED, g_fontSmall,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
            continue;
        }

        /* 头像：同一个人的连续消息只画一次；自己的画右侧 */
        if (L.showAvatar) {
            int av = 32;
            RECT ar = m.mine
                ? RECT{view.right - 8 - av, top, view.right - 8, top + av}
                : RECT{view.left + 8, top, view.left + 8 + av, top + av};
            void* img = avatarImage(m.senderAvatar);
            if (img) {
                drawImageCircle(dc, img, ar);
            } else {
                HBRUSH b = CreateSolidBrush(m.mine ? C_ACCENT : RGB(96, 132, 196));
                HGDIOBJ ob = SelectObject(dc, b);
                HGDIOBJ op = SelectObject(dc, GetStockObject(NULL_PEN));
                Ellipse(dc, ar.left, ar.top, ar.right, ar.bottom);
                SelectObject(dc, ob);
                SelectObject(dc, op);
                DeleteObject(b);
                std::wstring ini = m.senderName.empty() ? L"?" : wide(m.senderName).substr(0, 2);
                textOut(dc, ini, ar, RGB(255, 255, 255), g_fontSmall,
                        DT_CENTER | DT_SINGLELINE | DT_VCENTER);
            }
            // 刘子墨：金色头像环
            if (m.senderFounder) drawGoldRing(dc, ar);
        }

        /* 名字 + 时间 */
        if (!m.mine && L.showName) {
            RECT nr = {view.left + 48, top - 2, view.left + 48 + 200, top + 16};
            textOut(dc, wide(m.senderName), nr,
                    m.senderFounder ? RGB(180, 130, 20) : C_SUB, g_fontSmall,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
            RECT tr = {nr.right + 6, top - 2, nr.right + 80, top + 16};
            textOut(dc, fmtTime(m.createdAt), tr, C_MUTED, g_fontSmall,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        }

        /* 气泡：L.bubble 是「相对内容顶部」的坐标，只能加 baseY，不能加已含行偏移的 top */
        RECT br = L.bubble;
        OffsetRect(&br, view.left, baseY);
        if (br.right > view.right - 8) {
            int over = br.right - (view.right - 8);
            br.left -= over;
            br.right -= over;
        }
        COLORREF bg = m.mine ? C_ACCENT : C_BUBBLE_OTHER;
        if (m.recalled) bg = m.mine ? RGB(158, 176, 200) : RGB(240, 241, 243);
        if (m.senderFounder && !m.recalled) {
            // 刘子墨：金色烫金流动气泡（发的消息整体金质）
            fillGoldRoundRect(dc, br, 10, GetTickCount() / 40);
        } else {
            roundRect(dc, br, 10, bg, m.mine ? C_ACCENT : C_LINE);
        }

        // 刘子墨的金泡用深金棕文字，保证可读
        COLORREF fgMain = (m.senderFounder && !m.recalled) ? RGB(92, 67, 16)
                                                          : (m.mine ? RGB(255, 255, 255) : C_TEXT);
        COLORREF fgSub  = (m.senderFounder && !m.recalled) ? RGB(143, 116, 40)
                                                          : (m.mine ? RGB(210, 228, 255) : C_SUB);
        if (m.hasFile && !m.file.deleted) {
            RECT fn = {br.left + 14, br.top + 9, br.right - 14, br.top + 31};
            textOut(dc, wide(m.file.name), fn, fgMain,
                    g_fontUI, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
            std::wstring meta = fmtSize(m.file.size) + L"  ·  点击保存";
            RECT mt = {br.left + 14, br.top + 31, br.right - 14, br.top + 53};
            textOut(dc, meta, mt, fgSub, g_fontSmall,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        } else {
            std::wstring content = wide(m.content);
            if (m.recalled) content = L"这条消息已被撤回";
            else if (m.hasFile) content = L"[文件已删除]";
            RECT tx = {br.left + 14, br.top + 8, br.right - 14, br.bottom - 8};
            textOut(dc, content, tx, fgMain, g_fontUI,
                    DT_LEFT | DT_TOP | DT_WORDBREAK | DT_NOPREFIX);
        }
    }

    /* 空状态 */
    if (g_page.messages.empty() && !g_roomId.empty() && !g_busy) {
        RECT e = {view.left, view.top + viewH / 2 - 20, view.right, view.top + viewH / 2 + 20};
        textOut(dc, L"还没有消息，说点什么吧", e, C_MUTED, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    }
    if (g_roomId.empty()) {
        RECT e = {view.left, view.top + viewH / 2 - 20, view.right, view.top + viewH / 2 + 20};
        textOut(dc, L"从左侧选择一个房间开始聊天", e, C_MUTED, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    }

    SelectClipRgn(dc, NULL);
    DeleteObject(clip);

    /* -------- 输入区 -------- */
    RECT ia = {chat.left, chat.bottom - INPUT_H, chat.right, chat.bottom};
    fillRect(dc, ia, C_CARD);
    fillRect(dc, RECT{chat.left, ia.top, chat.right, ia.top + 1}, C_LINE);

    /* 输入框底框：与 layoutControls 中 EDIT 的位置共用同一套公式 */
    int ix = chat.left + 76;
    int iw = chat.right - ix - 116;
    if (iw > 20) {
        RECT ifr = {ix - 12, chat.bottom - 124, ix + iw + 12, chat.bottom - 64};
        roundRect(dc, ifr, 8, RGB(247, 248, 250), RGB(222, 226, 232));
    }

    /* 发送按钮 */
    RECT sb = {chat.right - 104, chat.bottom - 124, chat.right - 20, chat.bottom - 78};
    g_btnSend = sb;
    bool canSend = !g_roomId.empty() && g_page.canPost;
    bool hov = inRect(sb, pt.x, pt.y);
    COLORREF sbc = canSend ? (hov ? RGB(23, 95, 205) : C_ACCENT) : RGB(200, 206, 214);
    roundRect(dc, sb, 8, sbc, sbc);
    textOut(dc, L"发送", sb, RGB(255, 255, 255), g_fontBold,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    /* 附件按钮 */
    RECT fb = {chat.left + 16, chat.bottom - 124, chat.left + 60, chat.bottom - 78};
    g_btnFile = fb;
    roundRect(dc, fb, 8, inRect(fb, pt.x, pt.y) ? C_HOVER : RGB(247, 248, 250),
              RGB(222, 226, 232));
    textOut(dc, L"📎", fb, C_SUB, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

    /* 底部提示 / 状态 */
    RECT tip = {chat.left + 18, chat.bottom - 56, chat.right - 20, chat.bottom - 34};
    if (!g_statusW.empty()) {
        textOut(dc, g_statusW, tip, C_SUB, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    } else {
        textOut(dc, L"Enter 发送 · Shift+Enter 换行", tip, RGB(178, 186, 196), g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    }
}

/* ================================================================== */
/* 控件位置                                                            */
/* ================================================================== */

static void layoutControls(int w, int h) {
    if (g_view == VIEW_LOGIN) {
        if (loginUsePicker()) {
            /* 账号选择器是纯自绘，不需要任何输入控件 */
            ShowWindow(g_edUser, SW_HIDE);
            ShowWindow(g_edPass, SW_HIDE);
            ShowWindow(g_edNick, SW_HIDE);
            ShowWindow(g_edInput, SW_HIDE);
            return;
        }
        ShowWindow(g_edUser, SW_SHOW);
        ShowWindow(g_edPass, SW_SHOW);
        ShowWindow(g_edNick, g_registerMode ? SW_SHOW : SW_HIDE);
        ShowWindow(g_edInput, SW_HIDE);

        for (int i = 0; i < 3; ++i) {
            HWND ed = (i == 0) ? g_edUser : (i == 1 ? g_edPass : g_edNick);
            RECT f = loginFieldRect(i, w, h);
            MoveWindow(ed, f.left + 14, f.top + 9, (f.right - f.left) - 28,
                       (f.bottom - f.top) - 18, TRUE);
        }
        SendMessageW(g_edUser, EM_SETREADONLY, FALSE, 0);
    } else {
        ShowWindow(g_edUser, SW_HIDE);
        ShowWindow(g_edPass, SW_HIDE);
        ShowWindow(g_edNick, SW_HIDE);
        ShowWindow(g_edInput, SW_SHOW);
        int x = SIDEBAR_W + 76;
        int iw = w - x - 116;
        if (iw < 100) iw = 100;
        MoveWindow(g_edInput, x, h - 116, iw, 44, TRUE);
    }
}

/* ================================================================== */
/* 结果处理                                                            */
/* ================================================================== */

static void handleResult(AsyncResult* r) {
    switch (r->kind) {
    case RK_LOGIN:
    case RK_REGISTER:
        g_busy = false;
        if (!r->ok) {
            g_loginErr = wide(r->error);
            setStatus(L"");
            /* 记住的密码失效（改过密码 / 账号被删）：清掉记录，退回手动输入 */
            bool credentialProblem = r->error.find("密码") != std::string::npos ||
                                     r->error.find("账号") != std::string::npos;
            if (credentialProblem && !g_addingAccount) {
                forgetAccount(g_pendingUser);
                g_addingAccount = true;
                SetWindowTextW(g_edUser, wide(g_pendingUser).c_str());
                SetWindowTextW(g_edPass, L"");
                RECT rc;
                GetClientRect(g_hwnd, &rc);
                layoutControls(rc.right, rc.bottom);
            }
        } else {
            rememberAccount(g_pendingUser, g_pendingPass, g_api.user().nickname, g_cbRemember);
            g_view = VIEW_MAIN;
            g_loginErr.clear();
            setStatus(L"");
            RECT rc;
            GetClientRect(g_hwnd, &rc);
            layoutControls(rc.right, rc.bottom);
            loadRooms();
        }
        break;

    case RK_ME:
        /* 自动登录时用旧 token 探活；失效则用记住的密码重新登录一次 */
        if (!r->ok) {
            g_api.clearSession();
            if (g_activeIdx >= 0 && g_activeIdx < (int)g_accounts.size() &&
                !g_accounts[(size_t)g_activeIdx].pass.empty()) {
                g_loginErr.clear();
                doLogin(g_accounts[(size_t)g_activeIdx].user,
                        g_accounts[(size_t)g_activeIdx].pass);
            } else {
                g_view = VIEW_LOGIN;
                RECT rc;
                GetClientRect(g_hwnd, &rc);
                layoutControls(rc.right, rc.bottom);
            }
        }
        break;

    case RK_ROOMS:
        if (r->ok) {
            g_rooms = r->rooms;
            g_publicRoomId = r->publicId;
            if (g_roomId.empty() || !g_rooms.empty()) {
                // 首次进入自动打开公共大厅
                if (g_roomId.empty()) {
                    for (size_t i = 0; i < g_rooms.size(); ++i) {
                        if (g_rooms[i].kind == "public") { openRoom(g_rooms[i]); break; }
                    }
                    if (g_roomId.empty() && !g_rooms.empty()) openRoom(g_rooms[0]);
                }
            }
        } else {
            setStatus(wide(r->error));
        }
        break;

    case RK_MSGS:
        if (r->ok) {
            bool full = (r->text == "full");
            if (r->page.messages.empty() && full) {
                g_page = r->page;
            } else {
                // 增量合并：按 id 去重后追加
                for (size_t i = 0; i < r->page.messages.size(); ++i) {
                    const Message& nm = r->page.messages[i];
                    bool dup = false;
                    for (size_t k = 0; k < g_page.messages.size(); ++k) {
                        if (g_page.messages[k].id == nm.id) {
                            g_page.messages[k] = nm;  // 撤回/编辑后覆盖
                            dup = true;
                            break;
                        }
                    }
                    if (!dup) g_page.messages.push_back(nm);
                }
                // 删除通知
                for (size_t i = 0; i < r->page.purgedIds.size(); ++i) {
                    for (size_t k = 0; k < g_page.messages.size(); ++k) {
                        if (g_page.messages[k].id == r->page.purgedIds[i]) {
                            g_page.messages.erase(g_page.messages.begin() + k);
                            break;
                        }
                    }
                }
                g_page.lastSeq = r->page.lastSeq;
                g_page.total = r->page.total;
                g_page.canPost = r->page.canPost;
                g_page.muted = r->page.muted;
                g_page.dissolved = r->page.dissolved;
            }
            // 原本就看着最新消息：新内容到了继续贴在底部
            if (g_atBottom) g_scrollY = SCROLL_BOTTOM;  // 下次绘制时钳到 maxScroll
            // 有金泡消息就开流光定时器
            {
                bool hasGold = false;
                for (size_t i = 0; i < g_page.messages.size(); ++i) {
                    if (g_page.messages[i].senderFounder && !g_page.messages[i].recalled) {
                        hasGold = true;
                        break;
                    }
                }
                if (hasGold) SetTimer(g_hwnd, 3, 80, NULL);
            }
            setStatus(L"");
        } else {
            // 401 时回登录页
            if (r->error.find("登录") != std::string::npos) {
                g_view = VIEW_LOGIN;
                g_loginErr = wide(r->error);
            }
            setStatus(wide(r->error));
        }
        break;

    case RK_SEND:
        g_busy = false;
        if (!r->ok) {
            setStatus(wide(r->error));
        } else {
            setStatus(L"");
            g_atBottom = true;
            g_scrollY = SCROLL_BOTTOM;
            loadMessages(false);
        }
        break;

    case RK_UPLOAD:
        g_busy = false;
        if (!r->ok) {
            setStatus(wide(r->error));
        } else {
            setStatus(L"已发送：" + wide(r->up.name));
            g_atBottom = true;
            g_scrollY = SCROLL_BOTTOM;
            loadMessages(false);
        }
        break;

    case RK_DOWNLOAD:
        g_busy = false;
        setStatus(r->ok ? (L"已保存到 " + g_downloadDir) : wide(r->error));
        break;

    case RK_NICK:
        if (r->ok) setStatus(L"昵称已更新");
        else setStatus(wide(r->error));
        break;

    case RK_JOIN:
        if (r->ok) loadRooms();
        else setStatus(wide(r->error));
        break;

    case RK_CREATE:
        g_busy = false;
        if (r->ok) {
            loadRooms();
            setStatus(L"房间已创建");
        } else {
            setStatus(wide(r->error));
        }
        break;

    case RK_AVATAR_GET:
        // 头像字节到货：解码进缓存后重绘（失败不再重试）
        if (r->ok && !r->bytes.empty()) {
            void* img = decodeImage(&r->bytes[0], r->bytes.size());
            if (img) {
                std::map<std::string, void*>::iterator it = g_avatars.find(r->avatarUrl);
                if (it != g_avatars.end()) freeImage(it->second);
                g_avatars[r->avatarUrl] = img;
            } else {
                g_avFailed.insert(r->avatarUrl);
            }
        } else {
            g_avFailed.insert(r->avatarUrl);
        }
        g_avPending.erase(r->avatarUrl);
        break;

    case RK_AVATAR_SET:
        if (r->ok) {
            g_api.saveSession();
            setStatus(L"头像已更新");
            clearAvatarCache();
            loadMessages(false);
        } else {
            setStatus(wide(r->error));
        }
        break;

    case RK_AVATAR_CLEAR:
        if (r->ok) {
            g_api.saveSession();
            setStatus(L"已恢复默认头像");
            clearAvatarCache();
            loadMessages(false);
        } else {
            setStatus(wide(r->error));
        }
        break;

    case RK_MEMBERINFOS:
        if (r->ok) {
            g_memberList = r->memberInfos;
            if (g_memberSel >= (int)g_memberList.size()) g_memberSel = -1;
            if (g_wndMembers) InvalidateRect(g_wndMembers, NULL, TRUE);
        } else if (g_wndMembers) {
            MessageBoxW(g_wndMembers, wide(r->error).c_str(), L"群管理", MB_OK | MB_ICONWARNING);
        }
        break;
    case RK_MUTE:
    case RK_KICK:
    case RK_APPOINT:
    case RK_TRANSFER:
    case RK_DISSOLVE:
        if (!r->ok && g_wndMembers) {
            MessageBoxW(g_wndMembers, wide(r->error).c_str(), L"群管理", MB_OK | MB_ICONWARNING);
        } else if (r->ok) {
            setStatus(L"操作完成");
            loadRooms();
        }
        break;

    case RK_SEARCH:
        if (r->ok) {
            g_srchResults = r->searchResults;
            if (g_srchResults.empty()) g_srchStatus = L"没有找到相关房间，换个关键词试试";
            else {
                wchar_t b[64];
                swprintf(b, 64, L"找到 %d 个房间", (int)g_srchResults.size());
                g_srchStatus = b;
            }
        } else {
            g_srchResults.clear();
            g_srchStatus = wide(r->error);
        }
        if (g_wndSearch) InvalidateRect(g_wndSearch, NULL, TRUE);
        break;

    case RK_SEARCH_PEEK:
        if (r->ok) {
            g_view = VIEW_MAIN;
            openRoom(r->room);
            RECT rc2;
            GetClientRect(g_hwnd, &rc2);
            layoutControls(rc2.right, rc2.bottom);
            InvalidateRect(g_hwnd, NULL, TRUE);
            setStatus(L"正在查看「" + wide(r->room.name) + L"」（未加入，只读）");
        } else if (g_wndSearch) {
            MessageBoxW(g_wndSearch, wide(r->error).c_str(), L"搜索房间", MB_OK | MB_ICONWARNING);
        }
        break;

    case RK_SEARCH_JOIN:
        if (r->ok) {
            loadRooms();
            g_view = VIEW_MAIN;
            openRoom(r->room);
            RECT rc3;
            GetClientRect(g_hwnd, &rc3);
            layoutControls(rc3.right, rc3.bottom);
            InvalidateRect(g_hwnd, NULL, TRUE);
            setStatus(L"已加入「" + wide(r->room.name) + L"」");
        } else if (g_wndSearch) {
            MessageBoxW(g_wndSearch, wide(r->error).c_str(), L"搜索房间", MB_OK | MB_ICONWARNING);
        }
        break;

    default:
        break;
    }
    delete r;
    InvalidateRect(g_hwnd, NULL, FALSE);
}

/* ================================================================== */
/* 设置窗口                                                            */
/* ================================================================== */

static HWND g_setNick = NULL, g_setServer = NULL;
static RECT g_setOk, g_setQuit;
static RECT g_setAvatar, g_setAvatarReset, g_setCache, g_setPickDir;

/* 更换头像：选图 → 缩成 256px JPEG → base64 上传 */
static void pickAndUploadAvatar() {
    wchar_t path[MAX_PATH] = {0};
    OPENFILENAMEW ofn = {0};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = g_wndSettings ? g_wndSettings : g_hwnd;
    ofn.lpstrFile = path;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrFilter = L"图片\0*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp\0所有文件\0*.*\0";
    ofn.nFilterIndex = 1;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (!GetOpenFileNameW(&ofn)) return;

    std::wstring file = path;
    setStatus(L"正在处理头像…");
    postJob([file]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_AVATAR_SET;
        std::vector<unsigned char> jpg = scaleToAvatarJpeg(file);
        if (jpg.empty()) {
            r->ok = false;
            r->error = "图片读取失败，请换一张（支持 PNG/JPEG/GIF/BMP）";
        } else {
            std::string b64 = base64Encode(&jpg[0], jpg.size());
            r->ok = g_api.setAvatar("data:image/jpeg;base64," + b64);
            r->error = g_api.lastError();
        }
        deliver(r);
    });
}

/* 清除缓存：头像缓存 + 本机残留的临时文件 */
static void doClearCacheNow() {
    size_t freed = 0;
    for (std::map<std::string, void*>::iterator it = g_avatars.begin();
         it != g_avatars.end(); ++it) {
        freeImage(it->second);
    }
    freed += g_avatars.size() * 8192;   // 估算
    g_avatars.clear();
    g_avPending.clear();
    g_avFailed.clear();

    // 顺手清掉 %TEMP% 下上个版本可能残留的自检截图
    wchar_t tmp[MAX_PATH] = {0};
    GetTempPathW(MAX_PATH, tmp);
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW((std::wstring(tmp) + L"ql_*.bmp").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            DeleteFileW((std::wstring(tmp) + fd.cFileName).c_str());
            freed += fd.nFileSizeLow;
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }

    wchar_t msg[128];
    swprintf(msg, 128, L"缓存已清理，释放约 %d KB", (int)(freed / 1024));
    MessageBoxW(g_wndSettings ? g_wndSettings : g_hwnd, msg, L"清除缓存", MB_OK | MB_ICONINFORMATION);
    InvalidateRect(g_hwnd, NULL, TRUE);
}

/* 选下载文件夹：SHBrowseForFolderW，选完写进 prefs */
static void pickDownloadDir() {
    BROWSEINFOW bi = {0};
    bi.hwndOwner = g_wndSettings ? g_wndSettings : g_hwnd;
    bi.lpszTitle = L"选择文件下载位置";
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
    LPITEMIDLIST pidl = SHBrowseForFolderW(&bi);
    if (!pidl) return;
    wchar_t buf[MAX_PATH] = {0};
    if (SHGetPathFromIDListW(pidl, buf)) {
        g_downloadDir = buf;
        saveDownloadDirPref();
        setStatus(L"下载位置已更改");
    }
    CoTaskMemFree(pidl);
    if (g_wndSettings) InvalidateRect(g_wndSettings, NULL, TRUE);
}

static LRESULT CALLBACK settingsProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    case WM_CREATE: {
        g_setNick = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                                    WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                                    130, 40, 220, 28, h, (HMENU)101, g_inst, NULL);
        g_setServer = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                                      WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                                      130, 78, 220, 28, h, (HMENU)102, g_inst, NULL);
        SendMessageW(g_setNick, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SendMessageW(g_setServer, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SetWindowTextW(g_setNick, wide(g_api.user().nickname).c_str());
        SetWindowTextW(g_setServer, wide(g_api.baseUrl()).c_str());
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc;
        GetClientRect(h, &rc);
        fillRect(dc, rc, C_CARD);

        textOut(dc, L"账号设置", RECT{16, 10, rc.right - 16, 32}, C_TEXT, g_fontBold,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        textOut(dc, L"昵称", RECT{16, 42, 130, 62}, C_SUB, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        textOut(dc, L"服务器地址", RECT{16, 80, 130, 100}, C_SUB, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);

        /* 头像行 */
        g_setAvatar = RECT{16, 116, 136, 152};
        roundRect(dc, g_setAvatar, 6,
                  inRect(g_setAvatar, 0, 0) ? C_CARD : C_ACCENT_DIM, C_LINE);
        textOut(dc, L"更换头像", g_setAvatar, C_ACCENT, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        g_setAvatarReset = RECT{146, 116, 266, 152};
        roundRect(dc, g_setAvatarReset, 6, C_CARD, C_LINE);
        textOut(dc, L"恢复默认头像", g_setAvatarReset, C_SUB, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        /* 下载位置 */
        textOut(dc, L"下载保存位置", RECT{16, 166, 350, 186}, C_SUB, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        std::wstring dirShow = g_downloadDir.empty() ? defaultDownloadDir() : g_downloadDir;
        textOut(dc, dirShow, RECT{16, 186, 366, 210}, C_TEXT, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        g_setPickDir = RECT{16, 214, 136, 246};
        roundRect(dc, g_setPickDir, 6, C_CARD, C_LINE);
        textOut(dc, L"更改…", g_setPickDir, C_ACCENT, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        /* 缓存 */
        g_setCache = RECT{146, 214, 266, 246};
        roundRect(dc, g_setCache, 6, C_CARD, C_LINE);
        textOut(dc, L"清除缓存", g_setCache, C_DANGER, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        /* 底部按钮 */
        g_setOk = RECT{16, rc.bottom - 48, 136, rc.bottom - 14};
        roundRect(dc, g_setOk, 6, C_ACCENT, C_ACCENT);
        textOut(dc, L"保存", g_setOk, RGB(255, 255, 255), g_fontBold,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        g_setQuit = RECT{146, rc.bottom - 48, rc.right - 16, rc.bottom - 14};
        roundRect(dc, g_setQuit, 6, C_CARD, C_LINE);
        textOut(dc, L"退出登录", g_setQuit, C_DANGER, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(l), y = GET_Y_LPARAM(l);
        if (inRect(g_setAvatar, x, y)) {
            pickAndUploadAvatar();
            return 0;
        }
        if (inRect(g_setAvatarReset, x, y)) {
            if (MessageBoxW(h, L"恢复为默认的色块头像吗？", L"轻聊",
                            MB_OKCANCEL | MB_ICONQUESTION) == IDOK) {
                postJob([]() {
                    AsyncResult* r = new AsyncResult();
                    r->kind = RK_AVATAR_CLEAR;
                    r->ok = g_api.clearAvatar();
                    r->error = g_api.lastError();
                    deliver(r);
                });
            }
            return 0;
        }
        if (inRect(g_setPickDir, x, y)) {
            pickDownloadDir();
            return 0;
        }
        if (inRect(g_setCache, x, y)) {
            doClearCacheNow();
            return 0;
        }
        if (inRect(g_setOk, x, y)) {
            std::wstring nick = getEditText(g_setNick);
            std::wstring srv = getEditText(g_setServer);
            g_api.setBaseUrl(utf8(srv));
            g_api.saveSession();
            std::string n = utf8(nick);
            postJob([n]() {
                AsyncResult* r = new AsyncResult();
                r->kind = RK_NICK;
                r->ok = g_api.setNickname(n);
                r->error = g_api.lastError();
                if (r->ok) g_api.saveSession();
                deliver(r);
            });
            DestroyWindow(h);
            g_wndSettings = NULL;
            return 0;
        }
        if (inRect(g_setQuit, x, y)) {
            if (MessageBoxW(h, L"确定退出登录吗？\r\n\r\n记住密码的账号仍会保留，下次点一下即可重新登录。", L"轻聊",
                            MB_OKCANCEL | MB_ICONQUESTION) == IDOK) {
                g_api.logout();
                g_view = VIEW_LOGIN;
                g_rooms.clear();
                g_roomId.clear();
                g_roomName.clear();
                g_page = MessagePage();
                g_addingAccount = g_accounts.empty();
                g_loginErr.clear();
                DestroyWindow(h);
                g_wndSettings = NULL;
                RECT rc;
                GetClientRect(g_hwnd, &rc);
                layoutControls(rc.right, rc.bottom);
                InvalidateRect(g_hwnd, NULL, TRUE);
            }
            return 0;
        }
        return 0;
    }
    case WM_CLOSE:
        DestroyWindow(h);
        g_wndSettings = NULL;
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void openSettings() {
    if (g_wndSettings) { SetForegroundWindow(g_wndSettings); return; }
    static bool reg = false;
    if (!reg) {
        WNDCLASSEXW wc = {0};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = settingsProc;
        wc.hInstance = g_inst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = g_brCard;
        wc.lpszClassName = L"QingLiaoSettings";
        RegisterClassExW(&wc);
        reg = true;
    }
    RECT pr;
    GetWindowRect(g_hwnd, &pr);
    int w = 380, h = 330;
    g_wndSettings = CreateWindowExW(WS_EX_DLGMODALFRAME, L"QingLiaoSettings", L"设置",
                                    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                                    pr.left + 120, pr.top + 80, w, h,
                                    g_hwnd, NULL, g_inst, NULL);
    ShowWindow(g_wndSettings, SW_SHOW);
    UpdateWindow(g_wndSettings);
}

/* ================================================================== */
/* 群管理窗口（成员列表 + 禁言/踢出/任命/转让/解散）                    */
/* ================================================================== */

static RECT g_mbMute, g_mbKick, g_mbAppoint, g_mbTransfer, g_mbDissolve, g_mbClose;

static void reloadMembers();

static void memberAction(const wchar_t* verb, std::function<void()> job) {
    if (g_memberSel < 0 || g_memberSel >= (int)g_memberList.size()) {
        MessageBoxW(g_wndMembers, L"请先在列表里选中一个成员", L"群管理", MB_OK | MB_ICONINFORMATION);
        return;
    }
    const Member& m = g_memberList[(size_t)g_memberSel];
    std::wstring tip = std::wstring(verb) + L"「" + wide(m.displayName) + L"」？";
    if (MessageBoxW(g_wndMembers, tip.c_str(), L"群管理", MB_OKCANCEL | MB_ICONQUESTION) != IDOK) return;
    postJob([job]() { job(); });
}

static LRESULT CALLBACK membersProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc;
        GetClientRect(h, &rc);
        fillRect(dc, rc, C_CARD);
        textOut(dc, L"群管理 · 成员", RECT{14, 8, rc.right - 14, 30}, C_TEXT, g_fontBold,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);

        /* 成员列表 */
        int y = 36;
        RECT listR = {14, y, rc.right - 14, y + 220};
        roundRect(dc, listR, 6, RGB(247, 248, 250), C_LINE);
        for (int i = 0; i < (int)g_memberList.size() && i < 9; ++i) {
            const Member& m = g_memberList[(size_t)i];
            RECT row = {listR.left + 2, listR.top + 4 + i * 23, listR.right - 2, listR.top + 4 + (i + 1) * 23};
            if (i == g_memberSel) fillRect(dc, row, C_ACTIVE);
            std::wstring line = wide(m.displayName) + L"  ·  " + wide(m.roleName);
            if (m.mutedUntil > 0) line += L"  [禁言中]";
            textOut(dc, line, RECT{row.left + 8, row.top, row.right - 8, row.bottom},
                    m.founder ? RGB(180, 130, 20) : C_TEXT, g_fontSmall,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        }
        if (g_memberList.empty()) {
            textOut(dc, L"暂无成员", listR, C_MUTED, g_fontSmall,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        }
        if (g_memberList.size() > 9) {
            textOut(dc, L"（仅显示前 9 位，滚轮不可用，后续版本补全）",
                    RECT{listR.left, listR.bottom + 2, listR.right, listR.bottom + 22},
                    C_MUTED, g_fontSmall, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        }

        /* 操作按钮行 */
        int by = rc.bottom - 50;
        g_mbMute = RECT{14, by, 94, by + 34};
        g_mbKick = RECT{102, by, 182, by + 34};
        g_mbAppoint = RECT{190, by, 286, by + 34};
        g_mbTransfer = RECT{294, by, 390, by + 34};
        g_mbDissolve = RECT{14, by - 42, 134, by - 8};
        g_mbClose = RECT{142, by - 42, 242, by - 8};

        roundRect(dc, g_mbMute, 6, C_CARD, C_LINE);
        textOut(dc, L"禁言", g_mbMute, C_ACCENT, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        roundRect(dc, g_mbKick, 6, C_CARD, C_LINE);
        textOut(dc, L"踢出", g_mbKick, C_DANGER, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        roundRect(dc, g_mbAppoint, 6, C_CARD, C_LINE);
        textOut(dc, L"任命职级", g_mbAppoint, C_ACCENT, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        roundRect(dc, g_mbTransfer, 6, C_CARD, C_LINE);
        textOut(dc, L"转让群主", g_mbTransfer, C_ACCENT, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        roundRect(dc, g_mbDissolve, 6, C_CARD, C_LINE);
        textOut(dc, L"解散本群", g_mbDissolve, C_DANGER, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        roundRect(dc, g_mbClose, 6, C_ACCENT, C_ACCENT);
        textOut(dc, L"关闭", g_mbClose, RGB(255, 255, 255), g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(l), y = GET_Y_LPARAM(l);
        RECT rc;
        GetClientRect(h, &rc);
        RECT listR = {14, 36, rc.right - 14, 36 + 220};
        if (inRect(listR, x, y)) {
            int idx = (y - listR.top - 4) / 23;
            if (idx >= 0 && idx < (int)g_memberList.size() && idx < 9) {
                g_memberSel = idx;
                InvalidateRect(h, NULL, FALSE);
            }
            return 0;
        }
        std::string roomId = g_roomId;
        if (inRect(g_mbClose, x, y)) {
            DestroyWindow(h);
            g_wndMembers = NULL;
            return 0;
        }
        if (inRect(g_mbMute, x, y)) {
            memberAction(L"禁言 10 分钟", [roomId]() {
                if (g_memberSel < 0) return;
                AsyncResult* r = new AsyncResult();
                r->kind = RK_MUTE;
                r->ok = g_api.muteMember(roomId, g_memberList[(size_t)g_memberSel].userId, 10);
                r->error = g_api.lastError();
                deliver(r);
                reloadMembers();
            });
            return 0;
        }
        if (inRect(g_mbKick, x, y)) {
            memberAction(L"踢出", [roomId]() {
                if (g_memberSel < 0) return;
                AsyncResult* r = new AsyncResult();
                r->kind = RK_KICK;
                r->ok = g_api.kickMember(roomId, g_memberList[(size_t)g_memberSel].userId);
                r->error = g_api.lastError();
                deliver(r);
                reloadMembers();
            });
            return 0;
        }
        if (inRect(g_mbAppoint, x, y)) {
            memberAction(L"任命为管理员", [roomId]() {
                if (g_memberSel < 0) return;
                AsyncResult* r = new AsyncResult();
                r->kind = RK_APPOINT;
                r->ok = g_api.appointMember(roomId, g_memberList[(size_t)g_memberSel].userId, "admin");
                r->error = g_api.lastError();
                deliver(r);
                reloadMembers();
            });
            return 0;
        }
        if (inRect(g_mbTransfer, x, y)) {
            memberAction(L"转让群主给", [roomId]() {
                if (g_memberSel < 0) return;
                AsyncResult* r = new AsyncResult();
                r->kind = RK_TRANSFER;
                r->ok = g_api.transferOwner(roomId, g_memberList[(size_t)g_memberSel].userId);
                r->error = g_api.lastError();
                deliver(r);
                reloadMembers();
            });
            return 0;
        }
        if (inRect(g_mbDissolve, x, y)) {
            if (MessageBoxW(h, L"解散本群不可恢复（公共大厅仅最高权限可解），确定吗？", L"群管理",
                            MB_OKCANCEL | MB_ICONWARNING) == IDOK) {
                postJob([roomId]() {
                    AsyncResult* r = new AsyncResult();
                    r->kind = RK_DISSOLVE;
                    r->ok = g_api.dissolveRoom(roomId);
                    r->error = g_api.lastError();
                    deliver(r);
                    loadRooms();
                });
            }
            return 0;
        }
        return 0;
    }
    case WM_CLOSE:
        DestroyWindow(h);
        g_wndMembers = NULL;
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void reloadMembers() {
    std::string roomId = g_roomId;
    postJob([roomId]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_MEMBERINFOS;
        r->ok = g_api.fetchMemberInfos(roomId, r->memberInfos);
        r->error = g_api.lastError();
        deliver(r);
    });
}

static void openMembers() {
    if (g_roomId.empty()) return;
    if (g_wndMembers) { SetForegroundWindow(g_wndMembers); return; }
    static bool reg = false;
    if (!reg) {
        WNDCLASSEXW wc = {0};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = membersProc;
        wc.hInstance = g_inst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = g_brCard;
        wc.lpszClassName = L"QingLiaoMembers";
        RegisterClassExW(&wc);
        reg = true;
    }
    RECT pr;
    GetWindowRect(g_hwnd, &pr);
    g_wndMembers = CreateWindowExW(WS_EX_DLGMODALFRAME, L"QingLiaoMembers", L"群管理",
                                   WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                                   pr.left + 140, pr.top + 90, 420, 360,
                                   g_hwnd, NULL, g_inst, NULL);
    ShowWindow(g_wndMembers, SW_SHOW);
    UpdateWindow(g_wndMembers);
    g_memberSel = -1;
    reloadMembers();
}

/* ================================================================== */
/* 搜索房间窗口（按名称搜索，结果带「进去看看 / 加入该房间」）          */
/* ================================================================== */

struct SrchRow { RECT peek, join; };
static std::vector<SrchRow> g_srchBtns;

/* 密码输入小窗（进去看看 / 加入 时给带密码的房间用） */
static HWND g_wndPrompt = NULL, g_promptEdit = NULL;
static std::function<void(std::string)> g_promptCb;
static std::wstring g_promptTitle;
static RECT g_promptOk;

static Room roomFromItem(const RoomSearchItem& it) {
    Room r;
    r.id = it.id;
    r.kind = it.kind;
    r.name = it.name;
    r.memberCount = it.memberCount;
    r.hasPassword = it.hasPassword;
    r.joined = it.joined;
    r.createdAt = it.createdAt;
    return r;
}

/** 绘制带关键词高亮的文本（命中片段金底深金字） */
static void textOutHighlight(HDC dc, const std::wstring& text, const std::wstring& kw,
                             RECT r, COLORREF fg) {
    std::wstring lt = text, lk = kw;
    for (size_t i = 0; i < lt.size(); ++i) lt[i] = (wchar_t)towlower(lt[i]);
    for (size_t i = 0; i < lk.size(); ++i) lk[i] = (wchar_t)towlower(lk[i]);
    size_t pos = lk.empty() ? std::wstring::npos : lt.find(lk);
    if (pos == std::wstring::npos) {
        textOut(dc, text, r, fg, g_fontUI, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        return;
    }
    HGDIOBJ oldFont = SelectObject(dc, g_fontUI);
    int x = r.left;
    std::wstring pre = text.substr(0, pos);
    std::wstring mid = text.substr(pos, kw.size());
    std::wstring suf = text.substr(pos + kw.size());
    SIZE sz = {0, 0};
    if (!pre.empty()) {
        GetTextExtentPoint32W(dc, pre.c_str(), (int)pre.size(), &sz);
        RECT r1 = {x, r.top, x + sz.cx + 2, r.bottom};
        textOut(dc, pre, r1, fg, g_fontUI, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        x += sz.cx;
    }
    GetTextExtentPoint32W(dc, mid.c_str(), (int)mid.size(), &sz);
    RECT hl = {x - 2, r.top + 3, x + sz.cx + 4, r.bottom - 3};
    HBRUSH hb = CreateSolidBrush(RGB(246, 224, 140));
    FillRect(dc, &hl, hb);
    DeleteObject(hb);
    RECT r2 = {x, r.top, x + sz.cx + 2, r.bottom};
    textOut(dc, mid, r2, RGB(92, 67, 16), g_fontBold, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    x += sz.cx;
    if (!suf.empty()) {
        RECT r3 = {x, r.top, r.right, r.bottom};
        textOut(dc, suf, r3, fg, g_fontUI, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    }
    SelectObject(dc, oldFont);
}

static void doSearchRooms(const std::wstring& kw) {
    std::string q = utf8(kw);
    g_srchStatus = L"搜索中…";
    if (g_wndSearch) InvalidateRect(g_wndSearch, NULL, TRUE);
    postJob([q]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_SEARCH;
        r->ok = g_api.searchRooms(q, r->searchResults);
        r->error = g_api.lastError();
        deliver(r);
    });
}

/* 进去看看：免密直接进（不加入），密码房先验证 */
static void doPeekRoom(const RoomSearchItem& item, const std::string& pwd) {
    Room room = roomFromItem(item);
    postJob([item, pwd, room]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_SEARCH_PEEK;
        r->room = room;
        if (item.hasPassword) {
            r->ok = g_api.verifyRoom(item.id, pwd);
        } else {
            r->ok = true;
        }
        r->error = g_api.lastError();
        deliver(r);
    });
}

/* 加入该房间：成功后进入房间 */
static void doSearchJoin(const RoomSearchItem& item, const std::string& pwd) {
    Room room = roomFromItem(item);
    postJob([item, pwd, room]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_SEARCH_JOIN;
        r->room = room;
        r->ok = g_api.joinRoom(item.id, pwd);
        r->error = g_api.lastError();
        deliver(r);
    });
}

static void promptThen(const std::wstring& title, std::function<void(std::string)> cb);

/* 结果行的两颗按钮点击 */
static void searchRowAction(int idx, bool peek) {
    if (idx < 0 || idx >= (int)g_srchResults.size()) return;
    RoomSearchItem item = g_srchResults[(size_t)idx];
    if (item.hasPassword) {
        promptThen(L"输入房间密码 · " + wide(item.name), [item, peek](std::string pwd) {
            if (peek) doPeekRoom(item, pwd);
            else doSearchJoin(item, pwd);
        });
    } else {
        if (peek) doPeekRoom(item, std::string());
        else doSearchJoin(item, std::string());
    }
}

static LRESULT CALLBACK srchInputProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_KEYDOWN && w == VK_RETURN) {
        doSearchRooms(getEditText(g_srchInput));
        return 0;
    }
    return CallWindowProcW((WNDPROC)GetWindowLongPtrW(h, GWLP_USERDATA), h, m, w, l);
}

static LRESULT CALLBACK searchProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    case WM_CREATE: {
        g_srchInput = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                                      WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                                      14, 42, 300, 30, h, (HMENU)201, g_inst, NULL);
        SendMessageW(g_srchInput, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SendMessageW(g_srchInput, EM_SETCUEBANNER, TRUE, (LPARAM)L"输入房间名关键词…");
        SetWindowLongPtrW(g_srchInput, GWLP_USERDATA,
                          (LONG_PTR)SetWindowLongPtrW(g_srchInput, GWLP_WNDPROC, (LONG_PTR)srchInputProc));
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc;
        GetClientRect(h, &rc);
        fillRect(dc, rc, C_CARD);

        textOut(dc, L"搜索房间", RECT{14, 10, rc.right - 14, 34}, C_TEXT, g_fontBold,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);

        /* 搜索按钮 */
        RECT gb = {rc.right - 88, 42, rc.right - 14, 72};
        POINT pt;
        GetCursorPos(&pt);
        ScreenToClient(h, &pt);
        roundRect(dc, gb, 6, inRect(gb, pt.x, pt.y) ? RGB(23, 95, 205) : C_ACCENT, C_ACCENT);
        textOut(dc, L"搜索", gb, RGB(255, 255, 255), g_fontBold,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        /* 状态行 */
        textOut(dc, g_srchStatus, RECT{14, 76, rc.right - 14, 98}, C_MUTED, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

        /* 结果行 */
        g_srchBtns.clear();
        int y = 102;
        const int ROW_H = 58;
        std::wstring kw;
        {
            wchar_t kbuf[64] = {0};
            GetWindowTextW(g_srchInput, kbuf, 63);
            kw = kbuf;
        }
        for (int i = 0; i < (int)g_srchResults.size(); ++i) {
            if (y + ROW_H > rc.bottom - 8) {
                textOut(dc, L"（仅显示前几条，可换个更精确的关键词）",
                        RECT{14, y, rc.right - 14, y + 22}, C_MUTED, g_fontSmall,
                        DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                break;
            }
            const RoomSearchItem& it = g_srchResults[(size_t)i];
            RECT row = {8, y, rc.right - 8, y + ROW_H};
            if (i % 2 == 1) fillRect(dc, row, RGB(247, 248, 250));

            /* 行尾两颗按钮：进去看看 / 加入该房间 */
            RECT jb = {rc.right - 112, y + 13, rc.right - 16, y + 45};
            RECT pb = {jb.left - 96, y + 13, jb.left - 8, y + 45};
            roundRect(dc, pb, 6, inRect(pb, pt.x, pt.y) ? C_HOVER : C_CARD, C_LINE);
            textOut(dc, L"进去看看", pb, C_ACCENT, g_fontSmall,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER);
            roundRect(dc, jb, 6, inRect(jb, pt.x, pt.y) ? RGB(23, 95, 205) : C_ACCENT, C_ACCENT);
            textOut(dc, L"加入该房间", jb, RGB(255, 255, 255), g_fontSmall,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER);
            g_srchBtns.push_back(SrchRow{pb, jb});

            /* 名称（关键词高亮）+ 副信息 */
            RECT nameR = {16, y + 6, pb.left - 12, y + 30};
            textOutHighlight(dc, wide(it.name), kw, nameR, C_TEXT);

            wchar_t cnt[24];
            swprintf(cnt, 24, L"%d 人", it.memberCount);
            std::wstring sub = std::wstring(cnt) + L" · " +
                (it.hasPassword ? L"密码房" : L"免密") + L" · " +
                (it.ownerName.empty() ? L"未知房主" : wide(it.ownerName)) +
                (it.joined ? L" · 已加入" : L"");
            RECT subR = {16, y + 30, pb.left - 12, y + 52};
            textOut(dc, sub, subR, C_MUTED, g_fontSmall,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
            y += ROW_H;
        }
        if (g_srchResults.empty() && !g_srchStatus.empty() && g_srchStatus != L"搜索中…") {
            /* 状态行已经显示了空结果/错误提示，这里不重复画 */
        }
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(l), y = GET_Y_LPARAM(l);
        RECT rc;
        GetClientRect(h, &rc);
        RECT gb = {rc.right - 88, 42, rc.right - 14, 72};
        if (inRect(gb, x, y)) {
            doSearchRooms(getEditText(g_srchInput));
            return 0;
        }
        for (int i = 0; i < (int)g_srchBtns.size(); ++i) {
            if (inRect(g_srchBtns[(size_t)i].peek, x, y)) { searchRowAction(i, true); return 0; }
            if (inRect(g_srchBtns[(size_t)i].join, x, y)) { searchRowAction(i, false); return 0; }
        }
        return 0;
    }
    case WM_MOUSEMOVE:
        InvalidateRect(h, NULL, FALSE);   // 按钮 hover 高亮
        return 0;
    case WM_CLOSE:
        DestroyWindow(h);
        g_wndSearch = NULL;
        g_srchInput = NULL;
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void openSearchWindow() {
    if (g_wndSearch) { SetForegroundWindow(g_wndSearch); return; }
    static bool reg = false;
    if (!reg) {
        WNDCLASSEXW wc = {0};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = searchProc;
        wc.hInstance = g_inst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = g_brCard;
        wc.lpszClassName = L"QingLiaoSearch";
        RegisterClassExW(&wc);
        reg = true;
    }
    RECT pr;
    GetWindowRect(g_hwnd, &pr);
    g_wndSearch = CreateWindowExW(WS_EX_DLGMODALFRAME, L"QingLiaoSearch", L"搜索房间",
                                  WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                                  pr.left + 130, pr.top + 70, 480, 470,
                                  g_hwnd, NULL, g_inst, NULL);
    ShowWindow(g_wndSearch, SW_SHOW);
    UpdateWindow(g_wndSearch);
}

/* ---------------- 密码输入小窗 ---------------- */

static LRESULT CALLBACK promptProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    case WM_CREATE: {
        g_promptEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                                       WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_PASSWORD,
                                       16, 52, 268, 30, h, (HMENU)301, g_inst, NULL);
        SendMessageW(g_promptEdit, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SendMessageW(g_promptEdit, EM_SETCUEBANNER, TRUE, (LPARAM)L"房间密码");
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc;
        GetClientRect(h, &rc);
        fillRect(dc, rc, C_CARD);
        textOut(dc, g_promptTitle, RECT{16, 12, rc.right - 16, 42}, C_TEXT, g_fontUI,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        POINT pt;
        GetCursorPos(&pt);
        ScreenToClient(h, &pt);
        g_promptOk = RECT{rc.right - 100, 52, rc.right - 16, 86};
        roundRect(dc, g_promptOk, 6,
                  inRect(g_promptOk, pt.x, pt.y) ? RGB(23, 95, 205) : C_ACCENT, C_ACCENT);
        textOut(dc, L"确定", g_promptOk, RGB(255, 255, 255), g_fontBold,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(l), y = GET_Y_LPARAM(l);
        if (inRect(g_promptOk, x, y)) {
            std::string v = utf8(getEditText(g_promptEdit));
            std::function<void(std::string)> cb = g_promptCb;
            g_promptCb = std::function<void(std::string)>();
            g_wndPrompt = NULL;
            g_promptEdit = NULL;
            DestroyWindow(h);
            if (cb) cb(v);
        }
        return 0;
    }
    case WM_KEYDOWN:
        if (w == VK_RETURN) {
            SendMessageW(h, WM_LBUTTONDOWN, 0, MAKELPARAM(g_promptOk.left + 4, g_promptOk.top + 4));
            return 0;
        }
        break;
    case WM_CLOSE:
        g_wndPrompt = NULL;
        g_promptEdit = NULL;
        g_promptCb = std::function<void(std::string)>();
        DestroyWindow(h);
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void promptThen(const std::wstring& title, std::function<void(std::string)> cb) {
    if (g_wndPrompt) {
        SetForegroundWindow(g_wndPrompt);
        return;
    }
    static bool reg = false;
    if (!reg) {
        WNDCLASSEXW wc = {0};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = promptProc;
        wc.hInstance = g_inst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = g_brCard;
        wc.lpszClassName = L"QingLiaoPrompt";
        RegisterClassExW(&wc);
        reg = true;
    }
    g_promptTitle = title;
    g_promptCb = cb;
    RECT pr;
    GetWindowRect(g_wndSearch ? g_wndSearch : g_hwnd, &pr);
    g_wndPrompt = CreateWindowExW(WS_EX_DLGMODALFRAME, L"QingLiaoPrompt", L"输入密码",
                                  WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                                  pr.left + 120, pr.top + 160, 320, 132,
                                  g_wndSearch ? g_wndSearch : g_hwnd, NULL, g_inst, NULL);
    ShowWindow(g_wndPrompt, SW_SHOW);
    UpdateWindow(g_wndPrompt);
    if (g_promptEdit) SetFocus(g_promptEdit);
}

/* 新建房间：用一个最小输入窗（复用设置窗口思路，单独简单实现） */
static std::wstring g_newRoomName;
static bool g_newRoomDone = false;

static LRESULT CALLBACK newRoomProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    static HWND ed = NULL;
    static RECT okR;
    switch (m) {
    case WM_CREATE:
        ed = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                             WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                             20, 48, 300, 30, h, (HMENU)201, g_inst, NULL);
        SendMessageW(ed, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SetFocus(ed);
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc;
        GetClientRect(h, &rc);
        fillRect(dc, rc, C_CARD);
        textOut(dc, L"新建房间", RECT{20, 12, rc.right - 20, 36}, C_TEXT, g_fontBold,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        textOut(dc, L"房间名称", RECT{20, 30, 200, 46}, C_SUB, g_fontSmall,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        okR = RECT{20, rc.bottom - 52, 170, rc.bottom - 16};
        roundRect(dc, okR, 6, C_ACCENT, C_ACCENT);
        textOut(dc, L"创建", okR, RGB(255, 255, 255), g_fontBold,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        RECT cc = {180, rc.bottom - 52, rc.right - 20, rc.bottom - 16};
        roundRect(dc, cc, 6, C_CARD, C_LINE);
        textOut(dc, L"取消", cc, C_SUB, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(l), y = GET_Y_LPARAM(l);
        if (inRect(okR, x, y)) {
            g_newRoomName = getEditText(ed);
            g_newRoomDone = true;
            DestroyWindow(h);
            return 0;
        }
        RECT rc;
        GetClientRect(h, &rc);
        RECT cc = {180, rc.bottom - 52, rc.right - 20, rc.bottom - 16};
        if (inRect(cc, x, y)) { g_newRoomDone = false; DestroyWindow(h); return 0; }
        return 0;
    }
    case WM_CLOSE:
        g_newRoomDone = false;
        DestroyWindow(h);
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void openNewRoomDialog() {
    static bool reg = false;
    if (!reg) {
        WNDCLASSEXW wc = {0};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = newRoomProc;
        wc.hInstance = g_inst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = g_brCard;
        wc.lpszClassName = L"QingLiaoNewRoom";
        RegisterClassExW(&wc);
        reg = true;
    }
    g_newRoomDone = false;
    g_newRoomName.clear();
    RECT pr;
    GetWindowRect(g_hwnd, &pr);
    HWND h = CreateWindowExW(WS_EX_DLGMODALFRAME, L"QingLiaoNewRoom", L"新建房间",
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                             pr.left + 200, pr.top + 140, 340, 200,
                             g_hwnd, NULL, g_inst, NULL);
    ShowWindow(h, SW_SHOW);
    UpdateWindow(h);

    MSG msg;
    while (IsWindow(h) && GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    if (!g_newRoomDone || g_newRoomName.empty()) return;

    std::string name = utf8(g_newRoomName);
    g_busy = true;
    setStatus(L"正在创建房间…");
    postJob([name]() {
        AsyncResult* r = new AsyncResult();
        r->kind = RK_CREATE;
        Room room;
        r->ok = g_api.createRoom(name, "", room);
        r->error = g_api.lastError();
        deliver(r);
    });
}

/* ================================================================== */
/* 主窗口                                                              */
/* ================================================================== */

static void paintTo(HDC dc, const RECT& rc) {
    if (rc.right <= 0 || rc.bottom <= 0) return;

    if (g_view == VIEW_LOGIN) {
        paintLogin(dc, rc);
    } else {
        RECT side = {0, 0, SIDEBAR_W, rc.bottom};
        RECT chat = {SIDEBAR_W, 0, rc.right, rc.bottom};
        paintChat(dc, chat);
        paintSidebar(dc, side);
        // 侧栏与聊天区之间的分隔线
        fillRect(dc, RECT{SIDEBAR_W - 1, 0, SIDEBAR_W, rc.bottom}, C_LINE);
    }
}

static void paint(HDC target, const RECT& rc) {
    if (rc.right <= 0 || rc.bottom <= 0) return;

    HDC mem = CreateCompatibleDC(target);
    HBITMAP bmp = CreateCompatibleBitmap(target, rc.right, rc.bottom);
    HGDIOBJ old = SelectObject(mem, bmp);

    paintTo(mem, rc);

    BitBlt(target, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
}

/* 把当前界面存成 BMP（自动化验证用：不需要人工盯着窗口） */
static bool saveScreenshot(const std::wstring& path) {
    RECT rc;
    GetClientRect(g_hwnd, &rc);
    int w = rc.right, h = rc.bottom;
    if (w <= 0 || h <= 0) return false;

    HDC sdc = GetDC(g_hwnd);
    HDC mem = CreateCompatibleDC(sdc);
    HBITMAP bmp = CreateCompatibleBitmap(sdc, w, h);
    HGDIOBJ old = SelectObject(mem, bmp);
    paintTo(mem, rc);
    SelectObject(mem, old);

    BITMAPINFO bi = {0};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;  // 自上而下
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    int rowBytes = w * 4;
    std::vector<unsigned char> pixels((size_t)rowBytes * h);
    GetDIBits(mem, bmp, 0, (UINT)h, &pixels[0], &bi, DIB_RGB_COLORS);

    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(g_hwnd, sdc);

    BITMAPFILEHEADER fh = {0};
    fh.bfType = 0x4D42;
    fh.bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER) + 0;
    fh.bfSize = fh.bfOffBits + (DWORD)pixels.size();

    FILE* fp = _wfopen(path.c_str(), L"wb");
    if (!fp) return false;
    fwrite(&fh, 1, sizeof(fh), fp);
    BITMAPINFOHEADER ih = bi.bmiHeader;
    ih.biSizeImage = (DWORD)pixels.size();
    fwrite(&ih, 1, sizeof(ih), fp);
    fwrite(&pixels[0], 1, pixels.size(), fp);
    fclose(fp);
    return true;
}

/* ---------------- 切换账号 ---------------- */
/*
 * 只列出「输入过密码并且登录成功过」的账号（即 g_accounts 里的成员）。
 * 选一个 → 回到登录卡片，账号已就位、密码框隐藏，点「登录」即可。
 */
static int g_pickIndex = -1;
static bool g_pickOther = false;
static bool g_pickRemove = false;

static LRESULT CALLBACK pickerProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    static std::vector<RECT> itemRects;
    static std::vector<RECT> delRects;
    switch (m) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc;
        GetClientRect(h, &rc);
        fillRect(dc, rc, C_CARD);

        textOut(dc, L"切换账号", RECT{20, 12, rc.right - 20, 38}, C_TEXT, g_fontBold,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        textOut(dc, L"这些账号都已记住密码，点一下即可登录", RECT{20, 36, rc.right - 20, 56},
                C_MUTED, g_fontSmall, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

        itemRects.clear();
        delRects.clear();
        int y = 66;
        for (size_t i = 0; i < g_accounts.size(); ++i) {
            RECT it = {12, y, rc.right - 12, y + 58};
            itemRects.push_back(it);
            if ((int)i == g_activeIdx) fillRect(dc, it, C_ACTIVE);

            int av = 36;
            RECT ar = {it.left + 12, y + 11, it.left + 12 + av, y + 11 + av};
            roundRect(dc, ar, 8, C_ACCENT, C_ACCENT);
            std::wstring wn = wide(g_accounts[i].nick.empty() ? g_accounts[i].user : g_accounts[i].nick);
            std::wstring ini = wn.substr(0, 3);
            textOut(dc, ini, ar, RGB(255, 255, 255), g_fontSmall,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER);

            RECT nr = {ar.right + 12, y + 10, it.right - 50, y + 34};
            textOut(dc, wn, nr, C_TEXT, g_fontUI,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
            RECT ur = {ar.right + 12, y + 32, it.right - 50, y + 52};
            textOut(dc, L"@" + wide(g_accounts[i].user), ur, C_MUTED, g_fontSmall,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

            RECT dr = {it.right - 42, y + 16, it.right - 12, y + 42};
            delRects.push_back(dr);
            textOut(dc, L"×", dr, C_MUTED, g_fontUI, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
            y += 62;
        }

        RECT ob = {20, rc.bottom - 52, rc.right - 20, rc.bottom - 16};
        roundRect(dc, ob, 8, C_CARD, C_LINE);
        textOut(dc, L"使用其他账号登录", ob, C_ACCENT, g_fontUI,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER);

        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(l), y = GET_Y_LPARAM(l);
        for (size_t i = 0; i < itemRects.size(); ++i) {
            if (i < delRects.size() && inRect(delRects[i], x, y)) {
                g_pickIndex = (int)i;
                g_pickRemove = true;
                DestroyWindow(h);
                return 0;
            }
            if (inRect(itemRects[i], x, y)) {
                g_pickIndex = (int)i;
                DestroyWindow(h);
                return 0;
            }
        }
        RECT rc;
        GetClientRect(h, &rc);
        RECT ob = {20, rc.bottom - 52, rc.right - 20, rc.bottom - 16};
        if (inRect(ob, x, y)) {
            g_pickOther = true;
            DestroyWindow(h);
        }
        return 0;
    }
    case WM_CLOSE:
        DestroyWindow(h);
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void layoutControls(int w, int h);  // 前置声明

static void openAccountPicker() {
    if (g_accounts.empty()) {
        /* 没有可切换的账号：直接进入手动输入 */
        g_addingAccount = true;
        g_cbRemember = false;
        g_cbAuto = false;
        SetWindowTextW(g_edUser, L"");
        SetWindowTextW(g_edPass, L"");
        RECT rc;
        GetClientRect(g_hwnd, &rc);
        layoutControls(rc.right, rc.bottom);
        InvalidateRect(g_hwnd, NULL, TRUE);
        return;
    }

    static bool reg = false;
    if (!reg) {
        WNDCLASSEXW wc = {0};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = pickerProc;
        wc.hInstance = g_inst;
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = g_brCard;
        wc.lpszClassName = L"QingLiaoPicker";
        RegisterClassExW(&wc);
        reg = true;
    }

    g_pickIndex = -1;
    g_pickOther = false;
    g_pickRemove = false;

    int n = (int)g_accounts.size();
    int hgt = 128 + n * 62 + 66;
    if (hgt > 560) hgt = 560;

    RECT pr;
    GetWindowRect(g_hwnd, &pr);
    HWND h = CreateWindowExW(WS_EX_DLGMODALFRAME, L"QingLiaoPicker", L"切换账号",
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                             pr.left + 180, pr.top + 90, 400, hgt,
                             g_hwnd, NULL, g_inst, NULL);
    ShowWindow(h, SW_SHOW);
    UpdateWindow(h);

    MSG msg;
    while (IsWindow(h) && GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    RECT rc;
    GetClientRect(g_hwnd, &rc);

    if (g_pickRemove && g_pickIndex >= 0 && g_pickIndex < (int)g_accounts.size()) {
        std::string u = g_accounts[(size_t)g_pickIndex].user;
        forgetAccount(u);
        if (!g_accounts.empty()) {
            openAccountPicker();
        } else {
            g_addingAccount = true;
            SetWindowTextW(g_edUser, L"");
            layoutControls(rc.right, rc.bottom);
            InvalidateRect(g_hwnd, NULL, TRUE);
        }
        return;
    }

    if (g_pickOther) {
        g_addingAccount = true;
        g_cbRemember = false;
        g_cbAuto = false;
        SetWindowTextW(g_edUser, L"");
        SetWindowTextW(g_edPass, L"");
        layoutControls(rc.right, rc.bottom);
        InvalidateRect(g_hwnd, NULL, TRUE);
        return;
    }

    if (g_pickIndex >= 0 && g_pickIndex < (int)g_accounts.size()) {
        g_activeIdx = g_pickIndex;
        g_addingAccount = false;
        g_registerMode = false;
        g_cbAuto = (g_autoUser == g_accounts[(size_t)g_activeIdx].user);
        g_loginErr.clear();
        saveCreds();
        layoutControls(rc.right, rc.bottom);
        InvalidateRect(g_hwnd, NULL, TRUE);
    }
}

static void doClick(int x, int y) {
    if (g_view == VIEW_LOGIN) {
        RECT rc;
        GetClientRect(g_hwnd, &rc);

        /* ---------- 账号选择模式 ---------- */
        if (loginUsePicker()) {
            if (inRect(g_cbAutoR, x, y)) {
                g_cbAuto = !g_cbAuto;
                g_autoUser = (g_cbAuto && g_activeIdx >= 0 && g_activeIdx < (int)g_accounts.size())
                                 ? g_accounts[(size_t)g_activeIdx].user : std::string();
                saveCreds();
                InvalidateRect(g_hwnd, NULL, FALSE);
                return;
            }
            for (size_t i = 0; i < g_avRects.size() && i < g_accounts.size(); ++i) {
                if (inRect(g_avRects[i], x, y)) {
                    g_activeIdx = (int)i;
                    g_cbAuto = (g_autoUser == g_accounts[i].user);
                    g_loginErr.clear();
                    saveCreds();
                    InvalidateRect(g_hwnd, NULL, TRUE);
                    return;
                }
            }
            if (inRect(g_addRect, x, y) || inRect(g_linkAlt, x, y)) {
                g_addingAccount = true;
                g_registerMode = false;
                g_cbRemember = true;
                SetWindowTextW(g_edUser, L"");
                SetWindowTextW(g_edPass, L"");
                layoutControls(rc.right, rc.bottom);
                InvalidateRect(g_hwnd, NULL, TRUE);
                SetFocus(g_edUser);
                return;
            }
            if (inRect(g_linkManage, x, y)) {
                openAccountPicker();
                return;
            }
            if (inRect(g_btnLogin, x, y)) {
                if (g_activeIdx < 0 || g_activeIdx >= (int)g_accounts.size()) return;
                const SavedAccount& a = g_accounts[(size_t)g_activeIdx];
                if (a.pass.empty()) {
                    g_addingAccount = true;
                    layoutControls(rc.right, rc.bottom);
                    InvalidateRect(g_hwnd, NULL, TRUE);
                    return;
                }
                g_pendingUser = a.user;
                g_pendingPass = a.pass;
                g_loginErr.clear();
                doLogin(a.user, a.pass);
            }
            return;
        }

        /* ---------- 手动输入模式 ---------- */
        if (inRect(g_cbRememberR, x, y)) {
            g_cbRemember = !g_cbRemember;
            if (!g_cbRemember) g_cbAuto = false;
            InvalidateRect(g_hwnd, NULL, FALSE);
            return;
        }
        if (inRect(g_cbAutoR, x, y)) {
            g_cbAuto = !g_cbAuto;
            if (g_cbAuto) g_cbRemember = true;
            InvalidateRect(g_hwnd, NULL, FALSE);
            return;
        }

        if (inRect(g_btnLogin, x, y)) {
            std::string u = utf8(getEditText(g_edUser));
            std::string p = utf8(getEditText(g_edPass));
            if (u.empty() || p.empty()) {
                g_loginErr = L"请填写账号和密码";
                InvalidateRect(g_hwnd, NULL, FALSE);
                return;
            }
            g_pendingUser = u;
            g_pendingPass = p;
            g_loginErr.clear();
            if (g_registerMode) {
                doRegister(u, p, utf8(getEditText(g_edNick)));
            } else {
                doLogin(u, p);
            }
        } else if (inRect(g_btnSwitch, x, y)) {
            if (g_registerMode) {
                g_registerMode = false;
                g_loginErr.clear();
                layoutControls(rc.right, rc.bottom);
                InvalidateRect(g_hwnd, NULL, TRUE);
            } else if (!g_accounts.empty()) {
                /* 回到账号选择 */
                g_addingAccount = false;
                g_loginErr.clear();
                SetWindowTextW(g_edPass, L"");
                layoutControls(rc.right, rc.bottom);
                InvalidateRect(g_hwnd, NULL, TRUE);
            } else {
                g_registerMode = true;
                g_loginErr.clear();
                SetWindowTextW(g_edPass, L"");
                layoutControls(rc.right, rc.bottom);
                InvalidateRect(g_hwnd, NULL, TRUE);
            }
        }
        return;
    }

    /* 主界面 */
    if (inRect(g_btnSettings, x, y)) { openSettings(); return; }
    if (inRect(g_btnSend, x, y)) { sendCurrentText(); return; }
    if (inRect(g_btnFile, x, y)) { pickAndUpload(); return; }
    if (inRect(g_btnSearchRoom, x, y)) { openSearchWindow(); return; }
    if (inRect(g_btnNew, x, y)) { openNewRoomDialog(); return; }
    if (inRect(g_btnRefresh, x, y)) { if (!g_roomId.empty()) loadMessages(false); return; }
    if (inRect(g_btnMembers, x, y)) { openMembers(); return; }

    /* 房间列表点击 */
    if (x < SIDEBAR_W && y > 70 && y < (int)100000) {
        int idx = (y - 78) / 56;
        if (idx >= 0 && idx < (int)g_rooms.size()) {
            const Room& r = g_rooms[(size_t)idx];
            if (r.id != g_roomId) openRoom(r);
            return;
        }
    }

    /* 消息区：点击文件消息保存 */
    RECT chat = {SIDEBAR_W, 0, 0, 0};
    RECT rc;
    GetClientRect(g_hwnd, &rc);
    chat.right = rc.right;
    chat.bottom = rc.bottom;
    int viewTop = HEADER_H;
    int viewH = chat.bottom - INPUT_H - viewTop;
    if (y > viewTop && y < chat.bottom - INPUT_H) {
        HDC dc = GetDC(g_hwnd);
        int baseY = viewTop + 8 - g_scrollY;
        for (size_t i = 0; i < g_layouts.size(); ++i) {
            const MsgLayout& L = g_layouts[i];
            if (!L.hasSave) continue;
            RECT br = L.bubble;
            OffsetRect(&br, SIDEBAR_W, baseY);
            if (inRect(br, x, y)) {
                saveFileTo(g_page.messages[L.index]);
                break;
            }
        }
        ReleaseDC(g_hwnd, dc);
    }
}

static LRESULT CALLBACK inputProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_KEYDOWN) {
        if (w == VK_RETURN) {
            bool shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
            if (!shift) {
                sendCurrentText();
                return 0;
            }
        }
    }
    return CallWindowProcW((WNDPROC)GetWindowLongPtrW(h, GWLP_USERDATA), h, m, w, l);
}

/* 登录表单的输入框：回车直接提交 */
static LRESULT CALLBACK loginInputProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_KEYDOWN && w == VK_RETURN && g_view == VIEW_LOGIN && !loginUsePicker()) {
        RECT b = g_btnLogin;
        doClick((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        return 0;
    }
    return CallWindowProcW((WNDPROC)GetWindowLongPtrW(h, GWLP_USERDATA), h, m, w, l);
}

static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        /* CreateWindowExW 返回前就会派发 WM_CREATE，此处必须先把窗口句柄存下来，
           否则自动登录触发的后台结果回传会 PostMessage 到空句柄，界面停在「加载中」 */
        g_hwnd = hwnd;
        g_edUser = CreateWindowExW(0, L"EDIT", L"",
                                   WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                                   0, 0, 10, 10, hwnd, (HMENU)1, g_inst, NULL);
        g_edPass = CreateWindowExW(0, L"EDIT", L"",
                                   WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_PASSWORD,
                                   0, 0, 10, 10, hwnd, (HMENU)2, g_inst, NULL);
        g_edNick = CreateWindowExW(0, L"EDIT", L"",
                                   WS_CHILD | ES_AUTOHSCROLL,
                                   0, 0, 10, 10, hwnd, (HMENU)3, g_inst, NULL);
        g_edInput = CreateWindowExW(0, L"EDIT", L"",
                                    WS_CHILD | ES_AUTOHSCROLL,
                                    0, 0, 10, 10, hwnd, (HMENU)4, g_inst, NULL);

        SendMessageW(g_edUser, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SendMessageW(g_edPass, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SendMessageW(g_edNick, WM_SETFONT, (WPARAM)g_fontUI, TRUE);
        SendMessageW(g_edInput, WM_SETFONT, (WPARAM)g_fontUI, TRUE);

        SendMessageW(g_edUser, EM_SETCUEBANNER, TRUE, (LPARAM)L"输入账号");
        SendMessageW(g_edPass, EM_SETCUEBANNER, TRUE, (LPARAM)L"输入密码");
        SendMessageW(g_edNick, EM_SETCUEBANNER, TRUE, (LPARAM)L"显示给别人的名字");
        SendMessageW(g_edInput, EM_SETCUEBANNER, TRUE, (LPARAM)L"输入消息，Enter 发送");

        SetWindowLongPtrW(g_edInput, GWLP_USERDATA,
                          (LONG_PTR)SetWindowLongPtrW(g_edInput, GWLP_WNDPROC, (LONG_PTR)inputProc));

        SetWindowLongPtrW(g_edUser, GWLP_USERDATA,
                          (LONG_PTR)SetWindowLongPtrW(g_edUser, GWLP_WNDPROC, (LONG_PTR)loginInputProc));
        SetWindowLongPtrW(g_edPass, GWLP_USERDATA,
                          (LONG_PTR)SetWindowLongPtrW(g_edPass, GWLP_WNDPROC, (LONG_PTR)loginInputProc));
        SetWindowLongPtrW(g_edNick, GWLP_USERDATA,
                          (LONG_PTR)SetWindowLongPtrW(g_edNick, GWLP_WNDPROC, (LONG_PTR)loginInputProc));

        /* 读本地记住的账号：有密码记录的进「选择账号登录」，否则进手动输入 */
        loadCreds();
        g_cbAuto = !g_autoUser.empty();
        g_cbRemember = !g_accounts.empty();
        g_activeIdx = g_accounts.empty() ? -1 : 0;
        g_addingAccount = g_accounts.empty();

        /* 勾了自动登录：拿保存的密码直接换 token，不打扰用户 */
        int autoIdx = g_autoUser.empty() ? -1 : findAccount(g_autoUser);
        if (autoIdx >= 0 && !g_accounts[(size_t)autoIdx].pass.empty()) {
            g_activeIdx = autoIdx;
            g_pendingUser = g_accounts[(size_t)autoIdx].user;
            g_pendingPass = g_accounts[(size_t)autoIdx].pass;
            doLogin(g_pendingUser, g_pendingPass);
        }
        return 0;
    }

    case WM_SIZE: {
        layoutControls(LOWORD(lp), HIWORD(lp));
        InvalidateRect(hwnd, NULL, FALSE);
        return 0;
    }

    case WM_ERASEBKGND:
        return 1;  // 全部自绘，避免闪烁

    case WM_CTLCOLOREDIT: {
        /* 输入域用无边框 EDIT，背景色与自绘底框保持一致，看起来才是一个整体 */
        HDC dc = (HDC)wp;
        SetTextColor(dc, C_TEXT);
        if ((HWND)lp == g_edInput) {
            SetBkColor(dc, C_CARD);
            return (LRESULT)g_brCard;
        }
        SetBkColor(dc, RGB(247, 248, 250));
        return (LRESULT)g_brField;
    }

    case WM_PAINT: {
        /* 必须走 BeginPaint/EndPaint：只 GetDC 不验证更新区域的话，
           WM_PAINT 会被无限重新投递，把定时器和网络回调全部饿死 */
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        RECT rc;
        GetClientRect(hwnd, &rc);
        paint(dc, rc);
        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_LBUTTONDOWN: {
        int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
        doClick(x, y);
        return 0;
    }

    case WM_KEYDOWN:
        if (wp == VK_RETURN && g_view == VIEW_LOGIN && loginUsePicker()) {
            RECT b = g_btnLogin;
            doClick((b.left + b.right) / 2, (b.top + b.bottom) / 2);
            return 0;
        }
        break;

    case WM_MOUSEWHEEL: {
        if (g_view != VIEW_MAIN) return 0;
        int delta = GET_WHEEL_DELTA_WPARAM(wp);
        RECT rc;
        GetClientRect(hwnd, &rc);
        int viewH = rc.bottom - INPUT_H - HEADER_H;
        int maxScroll = g_contentH + 16 - viewH;
        if (maxScroll > 0) {
            g_scrollY -= (delta > 0 ? 1 : -1) * 72;
            if (g_scrollY < 0) g_scrollY = 0;
            if (g_scrollY > maxScroll) g_scrollY = maxScroll;
            g_atBottom = (g_scrollY >= maxScroll);
            InvalidateRect(hwnd, NULL, FALSE);
        }
        return 0;
    }

    case WM_SETCURSOR: {
        if (LOWORD(lp) == HTCLIENT) {
            POINT pt;
            GetCursorPos(&pt);
            ScreenToClient(hwnd, &pt);
            bool hand = false;
            if (g_view == VIEW_MAIN) {
                hand = inRect(g_btnSend, pt.x, pt.y) || inRect(g_btnFile, pt.x, pt.y) ||
                       inRect(g_btnNew, pt.x, pt.y) || inRect(g_btnRefresh, pt.x, pt.y) ||
                       inRect(g_btnSearchRoom, pt.x, pt.y) ||
                       inRect(g_btnMembers, pt.x, pt.y) ||
                       inRect(g_btnSettings, pt.x, pt.y) ||
                       (pt.x < SIDEBAR_W && pt.y > 70);
            } else {
                hand = inRect(g_btnLogin, pt.x, pt.y) || inRect(g_btnSwitch, pt.x, pt.y);
            }
            SetCursor(LoadCursor(NULL, hand ? IDC_HAND : IDC_ARROW));
            return TRUE;
        }
        break;
    }

    case WM_TIMER:
        if (wp == 1) {
            if (g_view == VIEW_MAIN && !g_roomId.empty() && !g_busy) loadMessages(false);
        } else if (wp == 3) {
            // 刘子墨金泡流光：有 founder 消息时持续重绘，否则停表省电
            bool hasGold = false;
            for (size_t i = 0; i < g_page.messages.size(); ++i) {
                if (g_page.messages[i].senderFounder && !g_page.messages[i].recalled) {
                    hasGold = true;
                    break;
                }
            }
            if (hasGold && g_view == VIEW_MAIN) InvalidateRect(hwnd, NULL, FALSE);
            else KillTimer(hwnd, 3);
        } else if (wp == 2 && !g_shotPath.empty()) {
            KillTimer(hwnd, 2);
            dbg("timer2 fired, begin shot");
            bool s = saveScreenshot(g_shotPath);
            dbg("shot done saved=%d", (int)s);
            PostQuitMessage(0);
        }
        return 0;

    case WM_QL_RESULT:
        handleResult((AsyncResult*)lp);
        return 0;

    case WM_DESTROY:
        clearAvatarCache();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int show) {
    g_inst = inst;
    SetProcessDPIAware();
    dbg("=== start ===");
    imageInit();              // GDI+：头像解码 / 金泡渐变
    loadDownloadDirPref();    // 下载保存位置（默认 Windows 下载文件夹）

    INITCOMMONCONTROLSEX icc = {0};
    icc.dwSize = sizeof(icc);
    icc.dwICC = ICC_STANDARD_CLASSES;
    InitCommonControlsEx(&icc);

    /* 命令行：--shot <bmp路径> */
    {
        int argc = 0;
        LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        if (argv) {
            for (int i = 1; i < argc; ++i) {
                if (wcscmp(argv[i], L"--shot") == 0 && i + 1 < argc) g_shotPath = argv[i + 1];
                if (wcscmp(argv[i], L"--seed") == 0 && i + 2 < argc) {
                    g_seedUser = argv[i + 1];
                    g_seedPass = argv[i + 2];
                    g_seedAuto = (i + 3 < argc && wcscmp(argv[i + 3], L"1") == 0);
                }
                if (wcscmp(argv[i], L"--base") == 0 && i + 1 < argc) {
                    g_baseOverride = argv[i + 1];
                }
            }
            dbg("argc=%d shotPath=%ls", argc, g_shotPath.c_str());
            LocalFree(argv);
        }
    }

    if (!g_baseOverride.empty()) g_api.setBaseUrl(utf8(g_baseOverride));

    /* --seed：只写凭据，不开窗口（自动化测试用） */
    if (!g_seedUser.empty()) {
        loadCreds();
        g_cbAuto = g_seedAuto;
        rememberAccount(utf8(g_seedUser), utf8(g_seedPass), utf8(g_seedUser), true);
        dbg("seed done auto=%d accounts=%d", (int)g_seedAuto, (int)g_accounts.size());
        return 0;
    }

    /* GDI 资源 */
    g_fontUI = makeFont(14, false);
    g_fontSmall = makeFont(12, false);
    g_fontBold = makeFont(14, true);
    g_fontTitle = makeFont(26, true);
    g_fontH1 = makeFont(19, true);
    g_brBg = CreateSolidBrush(C_BG);
    g_brSide = CreateSolidBrush(C_SIDE);
    g_brCard = CreateSolidBrush(C_CARD);
    g_brField = CreateSolidBrush(RGB(247, 248, 250));

    InitializeCriticalSection(&g_cs);
    g_evtJob = CreateEventW(NULL, FALSE, FALSE, NULL);
    CloseHandle(CreateThread(NULL, 0, workerProc, NULL, 0, NULL));

    WNDCLASSEXW wc = {0};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = wndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground = g_brBg;
    wc.lpszClassName = L"QingLiaoNative";
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
    wc.hIconSm = wc.hIcon;
    RegisterClassExW(&wc);

    int w = 1120 * Dpi() / 96;
    int h = 760 * Dpi() / 96;
    g_hwnd = CreateWindowExW(0, L"QingLiaoNative", L"轻聊",
                             WS_OVERLAPPEDWINDOW,
                             CW_USEDEFAULT, CW_USEDEFAULT, w, h,
                             NULL, NULL, inst, NULL);
    dbg("create window -> %p (err %lu)", (void*)g_hwnd, GetLastError());
    if (!g_hwnd) return 1;

    RECT rc;
    GetClientRect(g_hwnd, &rc);
    layoutControls(rc.right, rc.bottom);

    ShowWindow(g_hwnd, show);
    UpdateWindow(g_hwnd);
    dbg("shown");
    SetTimer(g_hwnd, 1, 2500, NULL);
    if (!g_shotPath.empty()) {
        UINT_PTR t = SetTimer(g_hwnd, 2, 3000, NULL);
        dbg("shot timer id=%llu", (unsigned long long)t);
    }

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        if (!g_wndSettings || !IsDialogMessage(g_wndSettings, &msg)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    KillTimer(g_hwnd, 1);
    DeleteObject(g_fontUI);
    DeleteObject(g_fontSmall);
    DeleteObject(g_fontBold);
    DeleteObject(g_fontTitle);
    DeleteObject(g_brBg);
    DeleteObject(g_brSide);
    DeleteObject(g_brCard);
    return 0;
}
