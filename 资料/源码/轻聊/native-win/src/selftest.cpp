/*
 * 原生客户端自检程序（控制台）
 *
 * 用途：不打开图形界面的情况下，跑一遍「注册 → 登录 → 房间 → 发消息 → 拉消息 → 上传文件」，
 * 确认网络层与服务端接口完全对得上。GUI 出问题时先用它定位是「网络」还是「界面」。
 *
 * 用法：qingliao-selftest.exe [服务器地址] [账号] [密码]
 *       服务器地址默认 http://127.0.0.1:3311（本地开发服）
 */
#include <windows.h>
#include <cstdio>
#include <ctime>
#include <string>
#include <vector>
#include "json.h"
#include "http.h"
#include "api.h"

using namespace ql;

static int g_pass = 0, g_fail = 0;

static void check(const char* name, bool cond, const std::string& extra = "") {
    if (cond) {
        ++g_pass;
        printf("  \xE2\x9C\x93 %s\n", name);
    } else {
        ++g_fail;
        printf("  \xE2\x9C\x97 %s%s%s\n", name, extra.empty() ? "" : " | ", extra.c_str());
    }
}

int main(int argc, char** argv) {
    SetConsoleOutputCP(65001);

    std::string base = argc > 1 ? argv[1] : "http://127.0.0.1:3311";
    char nameBuf[64];
    snprintf(nameBuf, sizeof(nameBuf), "nat%lld", (long long)time(NULL) % 100000000LL);
    std::string username = argc > 2 ? argv[2] : nameBuf;
    std::string password = argc > 3 ? argv[3] : "pass1234";

    printf("轻聊原生客户端自检\n服务器: %s\n账号: %s\n\n", base.c_str(), username.c_str());

    Api api;
    api.setBaseUrl(base);

    /* 1. 版本接口（确认服务器可达、JSON 解析正常） */
    std::string ver = api.serverVersion();
    check("服务器可达（/api/version）", !ver.empty(), ver);
    if (ver.empty()) {
        printf("\n服务器不可达，后续跳过。\n");
        return 1;
    }
    printf("  服务端版本: %s\n", ver.c_str());

    /* 2. 注册 */
    bool reg = api.regist(username, password, "原生自检");
    check("注册并拿到 token", reg && api.loggedIn(),
          reg ? "" : api.lastError());
    if (!reg) {
        /* 账号已存在则改用登录 */
        bool lg = api.login(username, password);
        check("已存在账号可直接登录", lg, lg ? "" : api.lastError());
        if (!lg) {
            printf("\n通过: %d，失败: %d\n", g_pass, g_fail);
            return g_fail ? 1 : 0;
        }
    }
    printf("  当前用户: %s (%s)\n", api.user().nickname.c_str(), api.user().id.c_str());

    /* 3. 拉房间 */
    std::vector<Room> rooms;
    std::string pubId;
    bool gotRooms = api.fetchRooms(rooms, pubId);
    check("拉取房间列表", gotRooms, gotRooms ? "" : api.lastError());
    check("存在公共聊天室", !pubId.empty(), pubId);
    printf("  房间数: %d，公共房间: %s\n", (int)rooms.size(), pubId.c_str());

    std::string targetRoom = pubId;
    if (targetRoom.empty() && !rooms.empty()) targetRoom = rooms[0].id;

    /* 4. 发文本消息 */
    Message sent;
    std::string text = "原生客户端自检消息 " + username;
    bool sendOk = api.sendText(targetRoom, text, sent);
    check("发送文本消息", sendOk, sendOk ? "" : api.lastError());

    /* 5. 拉消息并确认能读到刚发的那条 */
    MessagePage page;
    bool gotMsgs = api.fetchMessages(targetRoom, 0, 80, page);
    check("拉取消息列表", gotMsgs, gotMsgs ? "" : api.lastError());
    bool found = false;
    for (size_t i = 0; i < page.messages.size(); ++i) {
        if (page.messages[i].id == sent.id) { found = true; break; }
    }
    check("刚发的消息出现在列表里", found);
    check("消息数量 > 0", page.messages.size() > 0,
          "共 " + std::to_string((int)page.messages.size()) + " 条");
    check("消息带发送者昵称", page.messages.empty() || !page.messages[0].senderName.empty());

    /* 6. 上传文件 */
    wchar_t tmpDir[MAX_PATH] = {0};
    GetTempPathW(MAX_PATH, tmpDir);
    std::wstring tmpFile = std::wstring(tmpDir) + L"ql_selftest.bin";
    {
        FILE* fp = _wfopen(tmpFile.c_str(), L"wb");
        if (fp) {
            std::string payload(300 * 1024, 'A');  // 300KB，跨不过大但足够验证分片逻辑
            fwrite(payload.data(), 1, payload.size(), fp);
            fclose(fp);
        }
    }
    UploadResult up;
    Message fileMsg;
    bool fileMsgSent = false;
    bool upOk = api.uploadFile(targetRoom, tmpFile, NULL, NULL, up);
    check("分片上传文件", upOk, upOk ? "" : api.lastError());
    if (upOk) {
        printf("  fileId=%s size=%lld\n", up.fileId.c_str(), (long long)up.size);
        fileMsgSent = api.sendFileMessage(targetRoom, up.fileId, "", fileMsg);
        check("发送文件消息", fileMsgSent, fileMsgSent ? "" : api.lastError());
        check("文件消息带文件元数据", fileMsg.hasFile && !fileMsg.file.name.empty(), fileMsg.file.name);
    }

    /* 7. 改昵称 */
    bool nickOk = api.setNickname("原生自检改");
    check("修改昵称", nickOk, nickOk ? "" : api.lastError());
    bool meOk = api.fetchMe();
    check("重新拉取个人资料", meOk && api.user().nickname == "原生自检改",
          meOk ? api.user().nickname : api.lastError());

    /* 8. 会话持久化 */
    api.saveSession();
    Api api2;
    bool restored = api2.loadSession();
    check("本地会话可恢复", restored);
    if (restored) {
        api2.setBaseUrl(base);
        bool me2 = api2.fetchMe();
        check("恢复的会话仍然有效", me2, me2 ? "" : api2.lastError());
    }
    /* 9. 清理：删掉本次自检发出的消息，不在公共聊天室留垃圾 */
    if (sendOk && !sent.id.empty()) {
        bool delOk = api.deleteMessage(sent.id);
        check("清理自检消息", delOk, delOk ? "" : api.lastError());
    }
    if (fileMsgSent && !fileMsg.id.empty()) {
        bool del2 = api.deleteMessage(fileMsg.id);
        check("清理自检文件消息", del2, del2 ? "" : api.lastError());
    }

    /* 默认清掉本地会话；带 --keep 时保留，供 GUI 自动登录截图 */
    bool keepSession = (argc > 4 && strcmp(argv[4], "--keep") == 0);
    if (keepSession) {
        api.saveSession();
        printf("  已保留本地会话（供 GUI 使用）\n");
    } else {
        api.clearSession();
        api2.clearSession();
    }

    printf("\n通过: %d，失败: %d\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
