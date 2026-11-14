#include "api.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <string>

namespace ql {

/* ---------------- 本地配置 ---------------- */

std::wstring configDir() {
    wchar_t buf[MAX_PATH] = {0};
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, buf))) {
        GetTempPathW(MAX_PATH, buf);
    }
    std::wstring dir = buf;
    dir += L"\\QingLiao";
    CreateDirectoryW(dir.c_str(), NULL);
    return dir;
}

std::wstring configFile(const wchar_t* name) {
    return configDir() + L"\\" + name;
}

static std::string readTextFile(const std::wstring& path) {
    FILE* fp = _wfopen(path.c_str(), L"rb");
    if (!fp) return std::string();
    std::string out;
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), fp)) > 0) out.append(buf, n);
    fclose(fp);
    return out;
}

static bool writeTextFile(const std::wstring& path, const std::string& text) {
    FILE* fp = _wfopen(path.c_str(), L"wb");
    if (!fp) return false;
    fwrite(text.data(), 1, text.size(), fp);
    fclose(fp);
    return true;
}

/* 极简 KV：一行一个 key=value，value 不做转义（username 不会含换行，token 是十六进制） */
static std::string kvGet(const std::string& body, const std::string& key) {
    std::string prefix = key + "=";
    size_t p = 0;
    while (p < body.size()) {
        size_t e = body.find('\n', p);
        if (e == std::string::npos) e = body.size();
        std::string line = body.substr(p, e - p);
        if (line.compare(0, prefix.size(), prefix) == 0) {
            std::string v = line.substr(prefix.size());
            while (!v.empty() && (v[v.size() - 1] == '\r')) v.erase(v.size() - 1);
            return v;
        }
        p = e + 1;
    }
    return std::string();
}

/* ---------------- 解析 ---------------- */

static User parseUser(const Json& j) {
    User u;
    u.id = j.str("id");
    u.username = j.str("username");
    u.nickname = j.str("nickname");
    u.initial = j.str("initial");
    u.avatarColor = j.str("avatarColor", "hsl(210,52%,52%)");
    u.avatar = j.str("avatar");
    u.founder = j.boolOf("founder");
    u.master = j.boolOf("master");
    if (u.nickname.empty()) u.nickname = u.username;
    if (u.initial.empty() && !u.nickname.empty()) {
        // 首字：取第一个 UTF-8 字符
        unsigned char c = (unsigned char)u.nickname[0];
        size_t len = (c < 0x80) ? 1 : (c < 0xE0 ? 2 : (c < 0xF0 ? 3 : 4));
        u.initial = u.nickname.substr(0, len);
    }
    return u;
}

static Room parseRoom(const Json& j) {
    Room r;
    r.id = j.str("id");
    r.kind = j.str("kind", "group");
    r.name = j.str("name");
    r.role = j.str("role");
    r.roleName = j.str("roleName");
    r.memberCount = (int)j.num("memberCount");
    r.joined = j.boolOf("joined");
    r.hasPassword = j.boolOf("hasPassword");
    r.dissolved = j.boolOf("dissolved");
    r.muted = j.boolOf("muted");
    r.createdAt = j.i64("createdAt");
    return r;
}

static Message parseMessage(const Json& j) {
    Message m;
    m.id = j.str("id");
    m.roomId = j.str("roomId");
    m.kind = j.str("kind", "text");
    m.content = j.str("content");
    m.senderId = j.str("senderId");
    m.senderName = j.str("senderName");
    m.senderUsername = j.str("senderUsername");
    m.senderAvatar = j.str("senderAvatar");
    m.createdAt = j.i64("createdAt");
    m.seq = j.i64("seq");
    m.rev = j.i64("rev");
    m.mine = j.boolOf("mine");
    m.recalled = j.boolOf("recalled");
    m.canRecall = j.boolOf("canRecall");
    m.canPurge = j.boolOf("canPurge");
    m.senderFounder = j.boolOf("senderFounder");
    const Json* f = j.find("file");
    if (f && f->isObject()) {
        m.hasFile = true;
        m.file.id = f->str("id");
        m.file.name = f->str("name");
        m.file.mime = f->str("mime");
        m.file.url = f->str("url");
        m.file.dlUrl = f->str("dlUrl");
        m.file.size = f->i64("size");
        m.file.isImage = f->boolOf("isImage");
        m.file.isVideo = f->boolOf("isVideo");
        m.file.deleted = f->boolOf("deleted");
    }
    return m;
}

/* ---------------- Api ---------------- */

Api::Api() : gatewayTried_(false) {}

void Api::setBaseUrl(const std::string& url) {
    http_.setBaseUrl(url);
    gatewayTried_ = false;
}

/*
 * 线上地址是「带分享码的分享链接」，网关要求先访问一次拿到会话 Cookie，
 * 之后的 /api/* 才放行。本地开发服不需要，多这一步也无害（返回首页而已）。
 */
static const char* kShareCode = "T7ELJZOC5A";

void Api::ensureGateway() {
    if (gatewayTried_) return;
    gatewayTried_ = true;
    if (http_.get(std::string("/?sharecode=") + kShareCode).status == 0) {
        gatewayTried_ = false;  // 网络暂时不通，下次再试
    }
}

bool Api::parseOk(const HttpResponse& r, Json& j) {
    if (r.status == 0) return fail(r.error.empty() ? std::string("网络不可用") : r.error);
    if (!Json::parse(r.body, j)) {
        char buf[96];
        snprintf(buf, sizeof(buf), "服务器返回了无法识别的内容（HTTP %d）", r.status);
        return fail(buf);
    }
    if (!j.boolOf("ok")) {
        std::string e = j.str("error");
        if (e.empty()) {
            if (r.status == 401) e = "登录已过期，请重新登录";
            else if (r.status == 403) e = "没有权限执行该操作";
            else if (r.status == 404) e = "内容不存在";
            else e = "操作失败，请稍后重试";
        }
        return fail(e);
    }
    lastError_.clear();
    return true;
}

/* ---- 会话 ---- */

bool Api::loadSession() {
    std::string body = readTextFile(configFile(L"session.txt"));
    if (body.empty()) return false;
    std::string base = kvGet(body, "base");
    std::string token = kvGet(body, "token");
    if (token.empty()) return false;
    if (!base.empty()) http_.setBaseUrl(base);
    http_.setToken(token);
    std::string uj = kvGet(body, "user");
    if (!uj.empty()) {
        Json j;
        if (Json::parse(uj, j)) user_ = parseUser(j);
    }
    return true;
}

void Api::saveSession() {
    if (http_.token().empty()) return;
    std::string body;
    body += "base=" + http_.baseUrl() + "\n";
    body += "token=" + http_.token() + "\n";
    Json u = Json::object();
    u.set("id", user_.id);
    u.set("username", user_.username);
    u.set("nickname", user_.nickname);
    u.set("initial", user_.initial);
    u.set("avatarColor", user_.avatarColor);
    u.set("founder", user_.founder);
    u.set("master", user_.master);
    body += "user=" + u.dump() + "\n";
    writeTextFile(configFile(L"session.txt"), body);
}

void Api::clearSession() {
    http_.setToken("");
    user_ = User();
    _wremove(configFile(L"session.txt").c_str());
}

/* ---- 账号 ---- */

bool Api::login(const std::string& username, const std::string& password, const std::string& permKey) {
    ensureGateway();
    Json req = Json::object();
    req.set("username", username);
    req.set("password", password);
    if (!permKey.empty()) req.set("permKey", permKey);

    HttpResponse r = http_.post("/api/login", req.dump(), "");
    Json j;
    if (!parseOk(r, j)) return false;

    http_.setToken(j.str("token"));
    const Json* u = j.find("user");
    if (u) user_ = parseUser(*u);
    if (http_.token().empty()) return fail("登录响应缺少凭证");
    if (!user_.nickname.empty()) { /* 保持服务端下发的显示名 */ }
    saveSession();
    return true;
}

bool Api::regist(const std::string& username, const std::string& password, const std::string& nickname) {
    ensureGateway();
    Json req = Json::object();
    req.set("username", username);
    req.set("password", password);
    req.set("nickname", nickname);

    HttpResponse r = http_.post("/api/register", req.dump(), "");
    Json j;
    if (!parseOk(r, j)) return false;

    http_.setToken(j.str("token"));
    const Json* u = j.find("user");
    if (u) user_ = parseUser(*u);
    if (http_.token().empty()) return fail("注册响应缺少凭证");
    saveSession();
    return true;
}

bool Api::fetchMe() {
    ensureGateway();
    HttpResponse r = http_.get("/api/me");
    Json j;
    if (!parseOk(r, j)) return false;
    const Json* u = j.find("user");
    if (u) user_ = parseUser(*u);
    return true;
}

bool Api::setNickname(const std::string& nickname) {
    Json req = Json::object();
    req.set("nickname", nickname);
    HttpResponse r = http_.post("/api/me/nickname", req.dump(), "");
    Json j;
    if (!parseOk(r, j)) return false;
    const Json* u = j.find("user");
    if (u) user_ = parseUser(*u);
    return true;
}

bool Api::setAvatar(const std::string& dataUrl) {
    Json req = Json::object();
    req.set("dataUrl", dataUrl);
    HttpResponse r = http_.post("/api/me/avatar", req.dump(), "");
    Json j;
    if (!parseOk(r, j)) return false;
    const Json* u = j.find("user");
    if (u) user_ = parseUser(*u);
    return true;
}

bool Api::clearAvatar() {
    HttpResponse r = http_.del("/api/me/avatar");
    Json j;
    if (!parseOk(r, j)) return false;
    const Json* u = j.find("user");
    if (u) user_ = parseUser(*u);
    return true;
}

bool Api::downloadAvatar(const std::string& urlPath, std::vector<unsigned char>& out) {
    HttpResponse r = http_.get(urlPath);
    if (r.status == 0) return fail(r.error.empty() ? std::string("网络不可用") : r.error);
    if (!r.ok()) return fail("头像下载失败");
    out.assign(r.body.begin(), r.body.end());
    return true;
}

void Api::logout() {
    if (!http_.token().empty()) http_.post("/api/logout", "{}", "");
    clearSession();
}

/* ---- 房间 ---- */

bool Api::fetchRooms(std::vector<Room>& out, std::string& publicRoomId) {
    HttpResponse r = http_.get("/api/rooms");
    Json j;
    if (!parseOk(r, j)) return false;

    out.clear();
    publicRoomId = j.str("publicRoomId");
    const Json* arr = j.find("rooms");
    if (arr && arr->isArray()) {
        for (size_t i = 0; i < arr->items.size(); ++i) out.push_back(parseRoom(arr->items[i]));
    }
    return true;
}

bool Api::createRoom(const std::string& name, const std::string& password, Room& out) {
    Json req = Json::object();
    req.set("name", name);
    if (!password.empty()) req.set("password", password);
    HttpResponse r = http_.post("/api/rooms", req.dump(), "");
    Json j;
    if (!parseOk(r, j)) return false;
    const Json* room = j.find("room");
    if (room) out = parseRoom(*room);
    return true;
}

bool Api::joinRoom(const std::string& roomId, const std::string& password) {
    Json req = Json::object();
    req.set("password", password);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/join", req.dump(), "");
    Json j;
    return parseOk(r, j);
}

bool Api::leaveRoom(const std::string& roomId) {
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/leave", "{}", "");
    Json j;
    return parseOk(r, j);
}

bool Api::fetchMembers(const std::string& roomId, std::vector<User>& out) {
    HttpResponse r = http_.get("/api/rooms/" + roomId + "/members");
    Json j;
    if (!parseOk(r, j)) return false;
    out.clear();
    const Json* arr = j.find("members");
    if (arr && arr->isArray()) {
        for (size_t i = 0; i < arr->items.size(); ++i) out.push_back(parseUser(arr->items[i]));
    }
    return true;
}

bool Api::fetchMemberInfos(const std::string& roomId, std::vector<Member>& out) {
    HttpResponse r = http_.get("/api/rooms/" + roomId + "/members");
    Json j;
    if (!parseOk(r, j)) return false;
    out.clear();
    const Json* arr = j.find("members");
    if (arr && arr->isArray()) {
        for (size_t i = 0; i < arr->items.size(); ++i) {
            const Json& m = arr->items[i];
            Member mem;
            mem.userId = m.str("userId");
            mem.username = m.str("username");
            mem.nickname = m.str("nickname");
            mem.displayName = m.str("displayName");
            if (mem.displayName.empty()) mem.displayName = mem.nickname;
            mem.role = m.str("role");
            mem.roleName = m.str("roleName");
            mem.avatar = m.str("avatar");
            mem.mutedUntil = m.i64("mutedUntil");
            mem.founder = m.boolOf("founder");
            out.push_back(mem);
        }
    }
    return true;
}

bool Api::muteMember(const std::string& roomId, const std::string& userId, int minutes) {
    Json req = Json::object();
    req.set("userId", userId);
    req.set("minutes", (double)minutes);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/mute", req.dump(), "");
    Json j;
    return parseOk(r, j);
}

bool Api::kickMember(const std::string& roomId, const std::string& userId) {
    Json req = Json::object();
    req.set("userId", userId);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/kick", req.dump(), "");
    Json j;
    return parseOk(r, j);
}

bool Api::appointMember(const std::string& roomId, const std::string& userId, const std::string& role) {
    Json req = Json::object();
    req.set("userId", userId);
    req.set("role", role);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/appoint", req.dump(), "");
    Json j;
    return parseOk(r, j);
}

bool Api::transferOwner(const std::string& roomId, const std::string& userId) {
    Json req = Json::object();
    req.set("userId", userId);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/transfer", req.dump(), "");
    Json j;
    return parseOk(r, j);
}

bool Api::dissolveRoom(const std::string& roomId) {
    Json req = Json::object();
    req.set("confirm", true);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/dissolve", req.dump(), "");
    Json j;
    return parseOk(r, j);
}

/* ---- 消息 ---- */

bool Api::fetchMessages(const std::string& roomId, long long since, int limit, MessagePage& out) {
    char q[128];
    snprintf(q, sizeof(q), "/api/rooms/%s/messages?since=%lld&limit=%d",
             roomId.c_str(), (long long)since, limit);
    HttpResponse r = http_.get(q);
    Json j;
    if (!parseOk(r, j)) return false;

    out = MessagePage();
    out.lastSeq = j.i64("lastSeq");
    out.total = (int)j.num("total");
    out.canPost = j.boolOf("canPost");
    out.muted = j.boolOf("muted");
    out.joined = j.boolOf("joined");
    out.dissolved = j.boolOf("dissolved");
    out.kind = j.str("kind");
    out.role = j.str("role");
    out.roleName = j.str("roleName");

    const Json* msgs = j.find("messages");
    if (msgs && msgs->isArray()) {
        for (size_t i = 0; i < msgs->items.size(); ++i) out.messages.push_back(parseMessage(msgs->items[i]));
    }
    const Json* purged = j.find("purgedIds");
    if (purged && purged->isArray()) {
        for (size_t i = 0; i < purged->items.size(); ++i) out.purgedIds.push_back(purged->items[i].sval);
    }
    return true;
}

bool Api::sendText(const std::string& roomId, const std::string& text, Message& out) {
    Json req = Json::object();
    req.set("kind", "text");
    req.set("content", text);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/messages", req.dump(), "");
    Json j;
    if (!parseOk(r, j)) return false;
    const Json* m = j.find("message");
    if (m) out = parseMessage(*m);
    return true;
}

bool Api::sendFileMessage(const std::string& roomId, const std::string& fileId,
                          const std::string& caption, Message& out) {
    Json req = Json::object();
    req.set("kind", "file");
    req.set("fileId", fileId);
    req.set("content", caption);
    HttpResponse r = http_.post("/api/rooms/" + roomId + "/messages", req.dump(), "");
    Json j;
    if (!parseOk(r, j)) return false;
    const Json* m = j.find("message");
    if (m) out = parseMessage(*m);
    return true;
}

bool Api::recallMessage(const std::string& msgId) {
    HttpResponse r = http_.post("/api/messages/" + msgId + "/recall", "{}", "");
    Json j;
    return parseOk(r, j);
}

bool Api::deleteMessage(const std::string& msgId) {
    HttpResponse r = http_.post("/api/messages/" + msgId + "/delete", "{}", "");
    Json j;
    return parseOk(r, j);
}

/* ---- 文件 ---- */

bool Api::uploadFile(const std::string& roomId, const std::wstring& localPath,
                     ProgressFn cb, void* ctx, UploadResult& out) {
    out = UploadResult();

    FILE* fp = _wfopen(localPath.c_str(), L"rb");
    if (!fp) { fail("打不开要上传的文件"); out.error = lastError_; return false; }

    if (fseek(fp, 0, SEEK_END) != 0) { fclose(fp); fail("读取文件失败"); out.error = lastError_; return false; }
    long long size = _ftelli64(fp);
    rewind(fp);
    if (size <= 0) { fclose(fp); fail("文件为空"); out.error = lastError_; return false; }
    if (size > 200LL * 1024 * 1024) { fclose(fp); fail("文件超过 200MB 上限"); out.error = lastError_; return false; }

    /* 文件名：取路径最后一段 */
    size_t cut = localPath.find_last_of(L"\\/");
    std::wstring wname = (cut == std::wstring::npos) ? localPath : localPath.substr(cut + 1);
    std::string name = utf8(wname);

    Json init = Json::object();
    init.set("name", name);
    init.set("size", size);
    init.set("roomId", roomId);
    init.set("mime", "application/octet-stream");

    HttpResponse r = http_.post("/api/files/init", init.dump(), "");
    Json j;
    if (!parseOk(r, j)) { fclose(fp); out.error = lastError_; return false; }

    std::string fileId = j.str("fileId");
    long long chunkSize = j.i64("chunkSize", 4 * 1024 * 1024);
    if (chunkSize <= 0) chunkSize = 4 * 1024 * 1024;
    if (fileId.empty()) { fclose(fp); fail("上传初始化失败"); out.error = lastError_; return false; }

    /* 服务端可能已经收过一部分（断点续传），从第一个未收到的分片开始 */
    std::vector<bool> have;
    const Json* received = j.find("received");
    if (received && received->isArray()) {
        have.assign((size_t)((size + chunkSize - 1) / chunkSize), false);
        for (size_t i = 0; i < received->items.size(); ++i) {
            long long idx = (long long)received->items[i].nval;
            if (idx >= 0 && idx < (long long)have.size() && received->items[i].type == Json::BOOL) {
                // 布尔数组形态：true 表示已收
            }
            (void)idx;
        }
        // 服务端 received 是布尔数组，逐位对齐
        for (size_t i = 0; i < received->items.size() && i < have.size(); ++i) {
            have[i] = received->items[i].type == Json::BOOL ? received->items[i].bval
                                                            : (received->items[i].nval != 0);
        }
    }

    std::vector<char> buf((size_t)chunkSize);
    long long totalChunks = (size + chunkSize - 1) / chunkSize;
    for (long long i = 0; i < totalChunks; ++i) {
        if (!have.empty() && i < (long long)have.size() && have[(size_t)i]) {
            if (cb) cb(ctx, (i + 1) * chunkSize > size ? size : (i + 1) * chunkSize, size);
            continue;
        }
        long long want = size - i * chunkSize;
        if (want > chunkSize) want = chunkSize;
        size_t got = fread(&buf[0], 1, (size_t)want, fp);
        if (got != (size_t)want) { fclose(fp); fail("读取文件时中断，请重试"); out.error = lastError_; return false; }

        char q[160];
        snprintf(q, sizeof(q), "/api/files/%s/chunk?i=%lld", fileId.c_str(), (long long)i);
        HttpResponse cr = http_.putBinary(q, &buf[0], got, "");
        Json cj;
        if (!parseOk(cr, cj)) { fclose(fp); out.error = lastError_; return false; }

        if (cb) cb(ctx, (i + 1) * chunkSize > size ? size : (i + 1) * chunkSize, size);
    }
    fclose(fp);

    HttpResponse done = http_.post("/api/files/" + fileId + "/complete", "{}", "");
    Json dj;
    if (!parseOk(done, dj)) { out.error = lastError_; return false; }

    out.ok = true;
    out.fileId = dj.str("fileId", fileId.c_str());
    out.name = dj.str("name", name.c_str());
    out.mime = dj.str("mime", "application/octet-stream");
    out.size = dj.i64("size", size);
    return true;
}

bool Api::downloadFile(const std::string& urlPath, const std::wstring& savePath) {
    HttpResponse r = http_.downloadToFile(urlPath, savePath);
    if (r.status == 0) return fail(r.error);
    if (!r.ok()) return fail(r.error.empty() ? std::string("下载失败") : r.error);
    return true;
}

std::string Api::serverVersion() {
    ensureGateway();
    HttpResponse r = http_.get("/api/version");
    Json j;
    if (!Json::parse(r.body, j)) return std::string();
    // 响应形如 { ok, version: { name, code, notes }, serverTime, ... }
    const Json* v = j.find("version");
    if (v && v->isObject()) {
        char buf[48];
        snprintf(buf, sizeof(buf), " (%d)", (int)v->num("code"));
        return v->str("name") + buf;
    }
    return j.str("name");
}

}  // namespace ql
