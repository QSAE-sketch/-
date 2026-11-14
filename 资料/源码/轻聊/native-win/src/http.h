/*
 * 轻聊原生客户端 · HTTP 层（WinHTTP）
 *
 * 不引 libcurl：WinHTTP 是系统自带组件，随 Windows 一起更新，
 * 证书校验、代理、TLS 都由系统负责，客户端不必自己维护根证书。
 *
 * 只提供客户端需要的三种动作：GET / POST(JSON) / PUT(二进制)。
 * 上传大文件按 4MB 分片，每片一次独立请求，进度天然可按片汇报。
 */
#ifndef QL_HTTP_H
#define QL_HTTP_H

#include <string>

namespace ql {

struct HttpResponse {
    int status;            // HTTP 状态码，0 表示连接失败
    std::string body;      // 响应体（UTF-8 / 原始字节）
    std::string error;     // 失败原因（给用户看的中文提示）
    std::string contentType;
    std::string setCookie; // 响应里的 Set-Cookie（网关会话就靠它）

    HttpResponse() : status(0) {}
    bool ok() const { return status >= 200 && status < 300; }
};

/* UTF 转换：界面用 UTF-16，网络与 JSON 用 UTF-8 */
std::string utf8(const std::wstring& w);
std::wstring wide(const std::string& s);
std::string urlEncode(const std::string& s);

class Http {
public:
    Http();
    ~Http();

    /* baseUrl 形如 https://host；为空则用内置线上地址 */
    void setBaseUrl(const std::string& baseUrl);
    const std::string& baseUrl() const { return base_; }

    HttpResponse get(const std::string& path);
    HttpResponse post(const std::string& path, const std::string& jsonBody, const std::string& token);
    HttpResponse putBinary(const std::string& path, const void* data, size_t len, const std::string& token);
    HttpResponse del(const std::string& path);   // DELETE（清头像等）

    /* 下载到文件，返回状态码；用于聊天里的文件消息保存到本地 */
    HttpResponse downloadToFile(const std::string& path, const std::wstring& savePath);

    void setToken(const std::string& t) { token_ = t; }
    const std::string& token() const { return token_; }
    const std::string& cookies() const { return cookies_; }
    void setCookies(const std::string& c) { cookies_ = c; }

private:
    HttpResponse request(const std::wstring& verb, const std::string& path,
                         const void* body, size_t len,
                         const std::string& contentType, bool useToken);
    void openSession();
    void mergeCookie(const std::string& raw);

    std::string base_;
    std::string token_;
    std::string cookies_;   // 手动维护的 Cookie 串（name=value; name2=value2）
    void* session_;   // HINTERNET，保持长连接复用
};

}  // namespace ql

#endif  // QL_HTTP_H
