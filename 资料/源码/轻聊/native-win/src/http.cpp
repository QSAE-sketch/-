#include "http.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <cstdio>
#include <cstdlib>

#pragma comment(lib, "winhttp.lib")

namespace ql {

/* ---------------- 编码转换 ---------------- */

std::string utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), NULL, 0, NULL, NULL);
    if (n <= 0) return std::string();
    std::string out((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &out[0], n, NULL, NULL);
    return out;
}

std::wstring wide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), NULL, 0);
    if (n <= 0) {
        // 非法 UTF-8 兜底：按本地代码页再试一次，至少不丢字符
        n = MultiByteToWideChar(CP_ACP, 0, s.c_str(), (int)s.size(), NULL, 0);
        if (n <= 0) return std::wstring();
        std::wstring out((size_t)n, L'\0');
        MultiByteToWideChar(CP_ACP, 0, s.c_str(), (int)s.size(), &out[0], n);
        return out;
    }
    std::wstring out((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], n);
    return out;
}

std::string urlEncode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = (unsigned char)s[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out += (char)c;
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0xF];
        }
    }
    return out;
}

/* ---------------- URL 拆分 ---------------- */

struct UrlParts {
    bool secure;
    std::wstring host;
    INTERNET_PORT port;
    std::wstring path;
};

static bool splitUrl(const std::string& url, UrlParts& out) {
    std::string rest = url;
    out.secure = true;
    if (rest.compare(0, 7, "http://") == 0) {
        out.secure = false;
        rest = rest.substr(7);
    } else if (rest.compare(0, 8, "https://") == 0) {
        rest = rest.substr(8);
    }
    size_t slash = rest.find('/');
    std::string hostPort = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    out.path = wide((slash == std::string::npos) ? "/" : rest.substr(slash));

    out.port = out.secure ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
    size_t colon = hostPort.find(':');
    if (colon != std::string::npos) {
        out.port = (INTERNET_PORT)atoi(hostPort.substr(colon + 1).c_str());
        hostPort = hostPort.substr(0, colon);
    }
    out.host = wide(hostPort);
    return !out.host.empty();
}

/* ---------------- Http ---------------- */

static const char* kDefaultBase = "https://qingliao-chat-33476.app.workbuddy.host";

/* 本地调试地址不走系统代理：公司/机场的代理会把 127.0.0.1 也拦下来，表现成 502 */
static bool isLoopback(const std::string& base) {
    return base.find("127.0.0.1") != std::string::npos ||
           base.find("localhost") != std::string::npos ||
           base.find("://[::1]") != std::string::npos;
}

Http::Http() : base_(kDefaultBase), session_(NULL) {
    openSession();
}

void Http::openSession() {
    if (session_) { WinHttpCloseHandle((HINTERNET)session_); session_ = NULL; }
    DWORD access = isLoopback(base_) ? WINHTTP_ACCESS_TYPE_NO_PROXY
                                     : WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY;
    session_ = (void*)WinHttpOpen(L"QingLiaoNative/2.0", access,
                                  WINHTTP_NO_PROXY_NAME,
                                  WINHTTP_NO_PROXY_BYPASS, 0);
    if (session_) {
        /* 弱网下别让界面卡死：连接 8 秒、收发 30 秒 */
        WinHttpSetTimeouts((HINTERNET)session_, 8000, 8000, 15000, 30000);
    }
}

Http::~Http() {
    if (session_) WinHttpCloseHandle((HINTERNET)session_);
}

void Http::setBaseUrl(const std::string& baseUrl) {
    if (baseUrl.empty() || baseUrl == base_) return;
    base_ = baseUrl;
    cookies_.clear();  // 换服务器后旧 cookie 无效
    openSession();
}

/* 读取一个响应头（返回宽字符，长度先探再取） */
static std::wstring readHeader(HINTERNET req, DWORD query) {
    DWORD len = 0;
    WinHttpQueryHeaders(req, query, WINHTTP_HEADER_NAME_BY_INDEX,
                        WINHTTP_NO_OUTPUT_BUFFER, &len, WINHTTP_NO_HEADER_INDEX);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || len == 0) return L"";
    std::wstring out(len / sizeof(wchar_t) + 2, L'\0');
    DWORD sz = (DWORD)(out.size() * sizeof(wchar_t));
    if (!WinHttpQueryHeaders(req, query, WINHTTP_HEADER_NAME_BY_INDEX,
                             &out[0], &sz, WINHTTP_NO_HEADER_INDEX)) {
        return L"";
    }
    out.resize(wcslen(out.c_str()));
    return out;
}

/* 把 Set-Cookie 合并进本地 Cookie 串（同名覆盖） */
void Http::mergeCookie(const std::string& raw) {
    if (raw.empty()) return;
    std::string pair = raw.substr(0, raw.find(';'));
    while (!pair.empty() && (pair[0] == ' ' || pair[0] == '\t')) pair.erase(0, 1);
    while (!pair.empty() && (pair[pair.size() - 1] == ' ' || pair[pair.size() - 1] == '\t')) {
        pair.erase(pair.size() - 1);
    }
    size_t eq = pair.find('=');
    if (eq == std::string::npos || eq == 0) return;
    std::string name = pair.substr(0, eq);

    std::string out;
    size_t p = 0;
    while (p < cookies_.size()) {
        size_t e = cookies_.find("; ", p);
        std::string item = cookies_.substr(p, (e == std::string::npos) ? std::string::npos : e - p);
        if (item.compare(0, name.size() + 1, name + "=") != 0) {
            if (!out.empty()) out += "; ";
            out += item;
        }
        if (e == std::string::npos) break;
        p = e + 2;
    }
    if (!out.empty()) out += "; ";
    out += pair;
    cookies_ = out;
}

HttpResponse Http::get(const std::string& path) {
    return request(L"GET", path, NULL, 0, "", true);
}

HttpResponse Http::del(const std::string& path) {
    return request(L"DELETE", path, NULL, 0, "", true);
}

HttpResponse Http::post(const std::string& path, const std::string& jsonBody, const std::string& token) {
    std::string saved = token_;
    if (!token.empty()) token_ = token;
    HttpResponse r = request(L"POST", path, jsonBody.data(), jsonBody.size(),
                             "application/json; charset=utf-8", true);
    token_ = saved;
    return r;
}

HttpResponse Http::putBinary(const std::string& path, const void* data, size_t len, const std::string& token) {
    std::string saved = token_;
    if (!token.empty()) token_ = token;
    HttpResponse r = request(L"PUT", path, data, len, "application/octet-stream", true);
    token_ = saved;
    return r;
}

HttpResponse Http::request(const std::wstring& verb, const std::string& path,
                           const void* body, size_t len,
                           const std::string& contentType, bool useToken) {
    HttpResponse out;
    if (!session_) { out.error = utf8(L"网络组件初始化失败"); return out; }

    UrlParts u;
    std::string full = base_;
    if (!path.empty() && path[0] != '/') full += '/';
    full += path;
    if (!splitUrl(full, u)) { out.error = utf8(L"服务器地址无效"); return out; }

    HINTERNET conn = WinHttpConnect((HINTERNET)session_, u.host.c_str(), u.port, 0);
    if (!conn) { out.error = utf8(L"连接服务器失败，请检查网络"); return out; }

    DWORD flags = u.secure ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET req = WinHttpOpenRequest(conn, verb.c_str(), u.path.c_str(),
                                       NULL, WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!req) {
        WinHttpCloseHandle(conn);
        out.error = utf8(L"创建请求失败");
        return out;
    }

    std::wstring headers = L"Accept: application/json\r\n";
    if (!contentType.empty()) headers += wide("Content-Type: " + contentType + "\r\n");
    if (useToken && !token_.empty()) headers += wide("x-token: " + token_ + "\r\n");
    /* 网关会话：分享链接靠 cookie 换会话，缺了会被拦成 403 */
    if (!cookies_.empty()) headers += wide("Cookie: " + cookies_ + "\r\n");

    BOOL sent = WinHttpSendRequest(req,
                                   headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
                                   headers.empty() ? 0 : (DWORD)-1L,
                                   (LPVOID)body, (DWORD)len, (DWORD)len, 0);
    if (!sent) {
        DWORD e = GetLastError();
        WinHttpCloseHandle(req);
        WinHttpCloseHandle(conn);
        out.error = (e == ERROR_WINHTTP_TIMEOUT) ? utf8(L"连接超时，请稍后重试")
                                                 : utf8(L"请求发送失败，请检查网络");
        return out;
    }
    if (!WinHttpReceiveResponse(req, NULL)) {
        WinHttpCloseHandle(req);
        WinHttpCloseHandle(conn);
        out.error = utf8(L"等不到服务器响应，请稍后重试");
        return out;
    }

    DWORD statusCode = 0, sz = sizeof(statusCode);
    WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &sz, WINHTTP_NO_HEADER_INDEX);
    out.status = (int)statusCode;

    /* 网关在首次访问分享链接时下发会话 Cookie，后续请求必须带上 */
    std::wstring sc = readHeader(req, WINHTTP_QUERY_SET_COOKIE);
    if (!sc.empty()) {
        out.setCookie = utf8(sc);
        mergeCookie(out.setCookie);
    }

    wchar_t ctBuf[128] = {0};
    DWORD ctLen = sizeof(ctBuf) - sizeof(wchar_t);
    if (WinHttpQueryHeaders(req, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
                            ctBuf, &ctLen, WINHTTP_NO_HEADER_INDEX)) {
        out.contentType = utf8(ctBuf);
    }

    /* 逐块读取。聊天消息响应最大也就几十 KB，这里不设上限但对 0 长度做保护 */
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req, &avail)) break;
        if (avail == 0) break;
        size_t old = out.body.size();
        out.body.resize(old + avail);
        DWORD read = 0;
        if (!WinHttpReadData(req, &out.body[old], avail, &read)) {
            out.body.resize(old);
            break;
        }
        if (read < avail) out.body.resize(old + read);
    }

    WinHttpCloseHandle(req);
    WinHttpCloseHandle(conn);
    return out;
}

HttpResponse Http::downloadToFile(const std::string& path, const std::wstring& savePath) {
    HttpResponse out;
    UrlParts u;
    std::string full = base_;
    full += path;
    if (!splitUrl(full, u)) { out.error = utf8(L"下载地址无效"); return out; }

    HINTERNET conn = WinHttpConnect((HINTERNET)session_, u.host.c_str(), u.port, 0);
    if (!conn) { out.error = utf8(L"连接服务器失败"); return out; }

    HINTERNET req = WinHttpOpenRequest(conn, L"GET", u.path.c_str(), NULL, WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES,
                                       u.secure ? WINHTTP_FLAG_SECURE : 0);
    if (!req) { WinHttpCloseHandle(conn); out.error = utf8(L"创建请求失败"); return out; }

    std::wstring headers;
    if (!token_.empty()) headers = wide("x-token: " + token_ + "\r\n");
    if (!cookies_.empty()) headers += wide("Cookie: " + cookies_ + "\r\n");

    if (!WinHttpSendRequest(req,
                            headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
                            headers.empty() ? 0 : (DWORD)-1L, NULL, 0, 0, 0) ||
        !WinHttpReceiveResponse(req, NULL)) {
        WinHttpCloseHandle(req);
        WinHttpCloseHandle(conn);
        out.error = utf8(L"下载失败，请检查网络");
        return out;
    }

    DWORD statusCode = 0, sz = sizeof(statusCode);
    WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &sz, WINHTTP_NO_HEADER_INDEX);
    out.status = (int)statusCode;

    if (!out.ok()) {
        WinHttpCloseHandle(req);
        WinHttpCloseHandle(conn);
        out.error = utf8(L"文件不可用（可能已被删除）");
        return out;
    }

    FILE* fp = _wfopen(savePath.c_str(), L"wb");
    if (!fp) {
        WinHttpCloseHandle(req);
        WinHttpCloseHandle(conn);
        out.error = utf8(L"无法写入本地文件，请换一个保存位置");
        return out;
    }

    char buf[64 * 1024];
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req, &avail) || avail == 0) break;
        DWORD want = avail > sizeof(buf) ? (DWORD)sizeof(buf) : avail;
        DWORD read = 0;
        if (!WinHttpReadData(req, buf, want, &read) || read == 0) break;
        fwrite(buf, 1, read, fp);
    }
    fclose(fp);

    WinHttpCloseHandle(req);
    WinHttpCloseHandle(conn);
    return out;
}

}  // namespace ql
