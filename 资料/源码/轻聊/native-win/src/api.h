/*
 * 轻聊原生客户端 · 业务 API
 *
 * 与服务端 server.js 的 HTTP 接口一一对应，不含任何 HTML/JS。
 * 所有函数都是同步阻塞的：调用方（工作线程）负责异步化，UI 线程永不直接调用。
 */
#ifndef QL_API_H
#define QL_API_H

#include <string>
#include <vector>
#include "json.h"
#include "http.h"

namespace ql {

struct User {
    std::string id, username, nickname, initial, avatarColor;
    std::string avatar;     // 自定义头像 URL（空 = 色块首字）
    bool founder, master;
    User() : founder(false), master(false) {}
};

/* 房间成员（带角色，群管理用） */
struct Member {
    std::string userId, username, nickname, displayName, role, roleName, avatar;
    long long mutedUntil;
    bool founder;
    Member() : mutedUntil(0), founder(false) {}
};

struct Room {
    std::string id, kind, name, role, roleName;
    int memberCount;
    bool joined, hasPassword, dissolved, muted;
    long long createdAt;
    Room() : memberCount(0), joined(false), hasPassword(false), dissolved(false),
             muted(false), createdAt(0) {}
};

struct MsgFile {
    std::string id, name, mime, url, dlUrl;
    long long size;
    bool isImage, isVideo, deleted;
    MsgFile() : size(0), isImage(false), isVideo(false), deleted(false) {}
};

struct Message {
    std::string id, roomId, kind, content, senderId, senderName, senderUsername;
    std::string senderAvatar;   // 发送者自定义头像 URL（空 = 色块）
    long long createdAt, seq, rev;
    bool mine, recalled, canRecall, canPurge, senderFounder;
    bool hasFile;
    MsgFile file;
    Message() : createdAt(0), seq(0), rev(0), mine(false), recalled(false),
                canRecall(false), canPurge(false), senderFounder(false), hasFile(false) {}
};

struct MessagePage {
    std::vector<Message> messages;
    std::vector<std::string> purgedIds;
    long long lastSeq;
    int total;
    bool canPost, muted, joined, dissolved;
    std::string kind, role, roleName;
    MessagePage() : lastSeq(0), total(0), canPost(false), muted(false), joined(false),
                    dissolved(false) {}
};

struct UploadResult {
    bool ok;
    std::string fileId, name, mime, error;
    long long size;
    UploadResult() : ok(false), size(0) {}
};

/* 上传进度回调：done / total 为字节数 */
typedef void (*ProgressFn)(void* ctx, long long done, long long total);

class Api {
public:
    Api();

    /* ---- 会话 ---- */
    bool loadSession();                 // 读本地保存的 token
    void saveSession();
    void clearSession();
    const std::string& token() const { return http_.token(); }
    const User& user() const { return user_; }
    bool loggedIn() const { return !http_.token().empty(); }
    const std::string& lastError() const { return lastError_; }

    void setBaseUrl(const std::string& url);
    std::string baseUrl() const { return http_.baseUrl(); }

    /* ---- 账号 ---- */
    bool login(const std::string& username, const std::string& password, const std::string& permKey = "");
    bool regist(const std::string& username, const std::string& password, const std::string& nickname);
    bool fetchMe();
    bool setNickname(const std::string& nickname);
    bool setAvatar(const std::string& dataUrl);   // data:image/...;base64,xxx
    bool clearAvatar();
    bool downloadAvatar(const std::string& urlPath, std::vector<unsigned char>& out);
    void logout();

    /* ---- 房间 ---- */
    bool fetchRooms(std::vector<Room>& out, std::string& publicRoomId);
    bool createRoom(const std::string& name, const std::string& password, Room& out);
    bool joinRoom(const std::string& roomId, const std::string& password);
    bool leaveRoom(const std::string& roomId);
    bool fetchMembers(const std::string& roomId, std::vector<User>& out);
    bool fetchMemberInfos(const std::string& roomId, std::vector<Member>& out);
    bool muteMember(const std::string& roomId, const std::string& userId, int minutes);
    bool kickMember(const std::string& roomId, const std::string& userId);
    bool appointMember(const std::string& roomId, const std::string& userId, const std::string& role);
    bool transferOwner(const std::string& roomId, const std::string& userId);
    bool dissolveRoom(const std::string& roomId);

    /* ---- 消息 ---- */
    bool fetchMessages(const std::string& roomId, long long since, int limit, MessagePage& out);
    bool sendText(const std::string& roomId, const std::string& text, Message& out);
    bool sendFileMessage(const std::string& roomId, const std::string& fileId, const std::string& caption, Message& out);
    bool recallMessage(const std::string& msgId);
    bool deleteMessage(const std::string& msgId);

    /* ---- 文件 ---- */
    bool uploadFile(const std::string& roomId, const std::wstring& localPath,
                    ProgressFn cb, void* ctx, UploadResult& out);
    bool downloadFile(const std::string& urlPath, const std::wstring& savePath);

    /* ---- 版本 ---- */
    std::string serverVersion();

    Http& http() { return http_; }

private:
    /* 线上部署带分享网关：首次请求要先访问分享链接换会话 Cookie，否则一律 403 */
    void ensureGateway();
    bool parseOk(const HttpResponse& r, Json& j);
    bool fail(const std::string& msg) { lastError_ = msg; return false; }

    Http http_;
    User user_;
    std::string lastError_;
    bool gatewayTried_;
};

/* 本地配置目录：%LOCALAPPDATA%\QingLiao */
std::wstring configDir();
std::wstring configFile(const wchar_t* name);

}  // namespace ql

#endif  // QL_API_H
