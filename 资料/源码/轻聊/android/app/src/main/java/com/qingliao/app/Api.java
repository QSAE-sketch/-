package com.qingliao.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 轻聊 Android 原生客户端的网络层。
 *
 * 直接对接 server.js 的 /api/*，不加载任何网页。
 * 所有方法都是同步阻塞的，调用方必须放在子线程（见 MainActivity 的 runBg）。
 *
 * 关于 Cookie：线上部署在分享网关后面，必须先访问一次带 sharecode 的首页
 * 换成会话 Cookie，否则 /api/* 一律 403。这里用系统 CookieManager 自动维护。
 */
public class Api {

    public static final String DEFAULT_BASE = "https://qingliao-chat-33476.app.workbuddy.host";
    private static final String SHARE_CODE = "T7ELJZOC5A";

    /** 服务器地址，可在「我的」里改（调试用） */
    private String base;
    private String token = "";
    private boolean gatewayDone = false;

    public Api() {
        this(DEFAULT_BASE);
    }

    public Api(String baseUrl) {
        this.base = (baseUrl == null || baseUrl.length() == 0) ? DEFAULT_BASE : baseUrl;
        // 系统级 Cookie 管理器：网关下发的会话 Cookie 由它保存并自动回传
        if (CookieHandler.getDefault() == null) {
            CookieManager cm = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
            CookieHandler.setDefault(cm);
        }
    }

    public String base() { return base; }
    public void setBase(String b) {
        if (b != null && b.length() > 0 && !b.equals(base)) {
            base = b;
            gatewayDone = false;
        }
    }
    public String token() { return token; }
    public void setToken(String t) { token = t == null ? "" : t; }
    public boolean loggedIn() { return token.length() > 0; }

    /* ---------------- 底层请求 ---------------- */

    public static class Resp {
        public int status;
        public String body = "";
        public String error = "";
        public boolean ok() { return status >= 200 && status < 300; }
    }

    private Resp request(String method, String path, byte[] body, String contentType) {
        Resp r = new Resp();
        HttpURLConnection c = null;
        try {
            URL url = new URL(base + path);
            c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("Accept", "application/json");
            if (token.length() > 0) c.setRequestProperty("x-token", token);
            if (contentType != null) c.setRequestProperty("Content-Type", contentType);
            if (body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                OutputStream os = c.getOutputStream();
                os.write(body);
                os.flush();
                os.close();
            }
            r.status = c.getResponseCode();
            InputStream is = (r.status >= 200 && r.status < 300)
                    ? c.getInputStream() : c.getErrorStream();
            if (is != null) {
                BufferedReader br = new BufferedReader(new InputStreamReader(is, "utf-8"));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
                r.body = sb.toString();
            }
        } catch (Exception e) {
            r.status = 0;
            r.error = "网络不可用：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
        return r;
    }

    private Resp get(String path) { return request("GET", path, null, null); }

    private Resp postJson(String path, JSONObject obj) {
        String s = obj == null ? "{}" : obj.toString();
        byte[] b;
        try {
            b = s.getBytes("utf-8");
        } catch (Exception e) {
            b = s.getBytes();
        }
        return request("POST", path, b, "application/json; charset=utf-8");
    }

    /**
     * 网关握手：访问一次分享链接换 Cookie。只做一次。
     * 本地开发的局域网地址不需要，多这一步也无害。
     */
    public void ensureGateway() {
        if (gatewayDone) return;
        Resp r = get("/?sharecode=" + SHARE_CODE);
        if (r.status > 0) gatewayDone = true;
    }

    /** 解析统一响应 {ok:true,...} / {ok:false,error} */
    private JSONObject unwrap(Resp r) throws ApiException {
        if (r.status == 0) throw new ApiException(r.error);
        JSONObject j;
        try {
            j = new JSONObject(r.body);
        } catch (JSONException e) {
            String msg;
            if (r.status == 403) msg = "网关拒绝了请求（请检查服务器地址）";
            else if (r.status == 502 || r.status == 503) msg = "服务器暂时不可用";
            else msg = "服务器返回了无法识别的内容（HTTP " + r.status + "）";
            throw new ApiException(msg);
        }
        if (!j.optBoolean("ok", false)) {
            String e = j.optString("error", "");
            if (e.length() == 0) {
                if (r.status == 401) e = "登录已过期，请重新登录";
                else if (r.status == 403) e = "没有权限执行该操作";
                else if (r.status == 404) e = "内容不存在";
                else e = "操作失败，请稍后重试";
            }
            throw new ApiException(e);
        }
        return j;
    }

    public static class ApiException extends Exception {
        public ApiException(String m) { super(m); }
    }

    /* ---------------- 数据模型 ---------------- */

    public static class User {
        public String id = "", username = "", nickname = "", initial = "", avatarColor = "";
        /** 真实头像的相对路径（/api/avatars/<id>?v=N），没传过头像时为空 */
        public String avatar = "";
        public boolean founder, master;
    }

    /** 好友（用于私聊入口）。私聊不是房间，单独走这里，不进房间列表。 */
    public static class Friend {
        public String id = "", username = "", nickname = "", initial = "", avatarColor = "";
        public String avatar = "";
    }

    public static class Room {
        public String id = "", kind = "", name = "", role = "", roleName = "";
        public int memberCount;
        public boolean joined, hasPassword, dissolved, muted;
        public long createdAt;
        public String ownerName = "";
    }

    /** 好友申请（收到的 / 发出的共用） */
    public static class FriendReq {
        public String id = "", userId = "", username = "", nickname = "", message = "";
    }

    /** 房间搜索结果 */
    public static class SearchRoom {
        public String id = "", kind = "", name = "", ownerName = "";
        public int memberCount;
        public boolean hasPassword, joined;
    }

    /** 群成员 */
    public static class Member {
        public String userId = "", username = "", nickname = "", displayName = "";
        public String role = "", roleName = "", avatar = "", avatarColor = "", initial = "";
        public boolean founder;
    }

    /** 成员面板返回的整体信息 */
    public static class MemberPage {
        public List<Member> members = new ArrayList<Member>();
        public String myRole = "", roomName = "";
        public boolean canManage, canDissolve, publicHall, master, dissolved;
        public String heirId = "", myRoomNickname = "";
    }

    public static class MsgFile {
        public String id = "", name = "", mime = "", url = "", dlUrl = "";
        public long size;
        public boolean isImage, isVideo, deleted;
    }

    public static class Message {
        public String id = "", roomId = "", kind = "text", content = "";
        public String senderId = "", senderName = "";
        /** 发送者头像相对路径（/api/avatars/<id>?v=N），没传过头像时为空 */
        public String senderAvatar = "";
        public long createdAt, seq, rev;
        public boolean mine, recalled, canRecall, senderFounder, hasFile;
        public MsgFile file;
    }

    public static class MessagePage {
        public List<Message> messages = new ArrayList<Message>();
        public List<String> purgedIds = new ArrayList<String>();
        public long lastSeq;
        public int total;
        public boolean canPost, muted, joined, dissolved;
        public String kind = "", roleName = "";
    }

    private static User parseUser(JSONObject o) {
        User u = new User();
        u.id = o.optString("id", "");
        u.username = o.optString("username", "");
        u.nickname = o.optString("nickname", u.username);
        u.initial = o.optString("initial", "");
        u.avatarColor = o.optString("avatarColor", "");
        u.avatar = o.optString("avatar", "");
        u.founder = o.optBoolean("founder", false);
        u.master = o.optBoolean("master", false);
        if (u.initial.length() == 0 && u.nickname.length() > 0) {
            u.initial = u.nickname.substring(0, 1);
        }
        return u;
    }

    private static Room parseRoom(JSONObject o) {
        Room r = new Room();
        r.id = o.optString("id", "");
        r.kind = o.optString("kind", "group");
        r.name = o.optString("name", "");
        r.role = o.optString("role", "");
        r.roleName = o.optString("roleName", "");
        r.memberCount = o.optInt("memberCount", 0);
        r.joined = o.optBoolean("joined", false);
        r.hasPassword = o.optBoolean("hasPassword", false);
        r.dissolved = o.optBoolean("dissolved", false);
        r.muted = o.optBoolean("muted", false);
        r.createdAt = o.optLong("createdAt", 0);
        r.ownerName = o.optString("ownerName", "");
        return r;
    }

    private static Message parseMessage(JSONObject o) {
        Message m = new Message();
        m.id = o.optString("id", "");
        m.roomId = o.optString("roomId", "");
        m.kind = o.optString("kind", "text");
        m.content = o.optString("content", "");
        m.senderId = o.optString("senderId", "");
        m.senderName = o.optString("senderName", "");
        m.senderAvatar = o.optString("senderAvatar", "");
        m.createdAt = o.optLong("createdAt", 0);
        m.seq = o.optLong("seq", 0);
        m.rev = o.optLong("rev", 0);
        m.mine = o.optBoolean("mine", false);
        m.recalled = o.optBoolean("recalled", false);
        m.canRecall = o.optBoolean("canRecall", false);
        m.senderFounder = o.optBoolean("senderFounder", false);
        JSONObject f = o.optJSONObject("file");
        if (f != null) {
            m.hasFile = true;
            MsgFile mf = new MsgFile();
            mf.id = f.optString("id", "");
            mf.name = f.optString("name", "");
            mf.mime = f.optString("mime", "");
            mf.url = f.optString("url", "");
            mf.dlUrl = f.optString("dlUrl", "");
            mf.size = f.optLong("size", 0);
            mf.isImage = f.optBoolean("isImage", false);
            mf.isVideo = f.optBoolean("isVideo", false);
            mf.deleted = f.optBoolean("deleted", false);
            m.file = mf;
        }
        return m;
    }

    /* ---------------- 账号 ---------------- */

    public User user = new User();

    public User login(String username, String password) throws ApiException {
        ensureGateway();
        try {
            JSONObject req = new JSONObject();
            req.put("username", username);
            req.put("password", password);
            JSONObject j = unwrap(postJson("/api/login", req));
            token = j.optString("token", "");
            if (token.length() == 0) throw new ApiException("登录响应缺少凭证");
            user = parseUser(j.optJSONObject("user"));
            return user;
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public User register(String username, String password, String nickname) throws ApiException {
        ensureGateway();
        try {
            JSONObject req = new JSONObject();
            req.put("username", username);
            req.put("password", password);
            req.put("nickname", nickname);
            JSONObject j = unwrap(postJson("/api/register", req));
            token = j.optString("token", "");
            if (token.length() == 0) throw new ApiException("注册响应缺少凭证");
            user = parseUser(j.optJSONObject("user"));
            return user;
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public User me() throws ApiException {
        ensureGateway();
        JSONObject j = unwrap(get("/api/me"));
        user = parseUser(j.optJSONObject("user"));
        return user;
    }

    public void setNickname(String nick) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("nickname", nick);
            JSONObject j = unwrap(postJson("/api/me/nickname", req));
            JSONObject u = j.optJSONObject("user");
            if (u != null) user = parseUser(u);
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public void logout() {
        try {
            postJson("/api/logout", new JSONObject());
        } catch (Exception ignored) {
        }
        token = "";
    }

    /** 注销账号（不可逆）：成功后本地凭证必须清掉 */
    public void deleteAccount() throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("confirm", true);
            unwrap(postJson("/api/account/delete", req));
            token = "";
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    /** 上传头像：走二进制体，Content-Type 由图片探测决定 */
    public void setAvatar(File file, String mime) throws ApiException {
        byte[] buf;
        try {
            FileInputStream fis = new FileInputStream(file);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] tmp = new byte[16384];
            int n;
            while ((n = fis.read(tmp)) > 0) bos.write(tmp, 0, n);
            fis.close();
            buf = bos.toByteArray();
        } catch (IOException e) {
            throw new ApiException("读取图片失败");
        }
        JSONObject j = unwrap(request("POST", "/api/me/avatar", buf,
                mime == null || mime.length() == 0 ? "application/octet-stream" : mime));
        JSONObject u = j.optJSONObject("user");
        if (u != null) user = parseUser(u);
    }

    public void clearAvatar() throws ApiException {
        JSONObject j = unwrap(request("DELETE", "/api/me/avatar", null, null));
        JSONObject u = j.optJSONObject("user");
        if (u != null) user = parseUser(u);
    }

    /** 激活 / 续期最高权限 */
    public boolean activatePerm(String key) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("key", key);
            JSONObject j = unwrap(postJson("/api/auth/perm", req));
            JSONObject u = j.optJSONObject("user");
            if (u != null) user = parseUser(u);
            return true;
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    /** 版本 / 更新记录 / 公告（公开接口，不需要登录） */
    public JSONObject version() throws ApiException {
        return unwrap(get("/api/version"));
    }

    /** 公共聊天室在线人数 */
    public int onlineCount() throws ApiException {
        return unwrap(get("/api/online-count")).optInt("online", 0);
    }

    /* ---------------- 房间 ---------------- */

    public List<Room> rooms() throws ApiException {
        JSONObject j = unwrap(get("/api/rooms"));
        List<Room> out = new ArrayList<Room>();
        JSONArray arr = j.optJSONArray("rooms");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null) out.add(parseRoom(o));
            }
        }
        return out;
    }

    /** 我的好友列表（只用于发起私聊，不是房间）。 */
    public List<Friend> friends() throws ApiException {
        JSONObject j = unwrap(get("/api/friends"));
        List<Friend> out = new ArrayList<Friend>();
        JSONArray arr = j.optJSONArray("friends");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Friend f = new Friend();
                f.id = o.optString("id", "");
                f.username = o.optString("username", "");
                f.nickname = o.optString("nickname", f.username);
                f.initial = o.optString("initial", "");
                f.avatarColor = o.optString("avatarColor", "");
                f.avatar = o.optString("avatar", "");
                out.add(f);
            }
        }
        return out;
    }

    /** 好友页完整数据：好友 + 收到的申请 + 发出的申请 */
    public static class FriendData {
        public List<Friend> friends = new ArrayList<Friend>();
        public List<FriendReq> incoming = new ArrayList<FriendReq>();
        public List<FriendReq> outgoing = new ArrayList<FriendReq>();
    }

    public FriendData friendData() throws ApiException {
        JSONObject j = unwrap(get("/api/friends"));
        FriendData d = new FriendData();
        JSONArray arr = j.optJSONArray("friends");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Friend f = new Friend();
                f.id = o.optString("id", "");
                f.username = o.optString("username", "");
                f.nickname = o.optString("nickname", f.username);
                f.initial = o.optString("initial", "");
                f.avatarColor = o.optString("avatarColor", "");
                f.avatar = o.optString("avatar", "");
                d.friends.add(f);
            }
        }
        arr = j.optJSONArray("incoming");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                FriendReq r = new FriendReq();
                r.id = o.optString("id", "");
                r.userId = o.optString("fromId", "");
                r.username = o.optString("username", "");
                r.nickname = o.optString("nickname", r.username);
                r.message = o.optString("message", "");
                d.incoming.add(r);
            }
        }
        arr = j.optJSONArray("outgoing");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                FriendReq r = new FriendReq();
                r.id = o.optString("id", "");
                r.userId = o.optString("toId", "");
                r.username = o.optString("username", "");
                r.nickname = o.optString("nickname", r.username);
                r.message = o.optString("message", "");
                d.outgoing.add(r);
            }
        }
        return d;
    }

    /** 按账号名/昵称搜索用户，用于加好友 */
    public List<Friend> searchUsers(String q) throws ApiException {
        JSONObject j = unwrap(get("/api/users?q=" + encode(q)));
        List<Friend> out = new ArrayList<Friend>();
        JSONArray arr = j.optJSONArray("users");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Friend f = new Friend();
                f.id = o.optString("id", "");
                f.username = o.optString("username", "");
                f.nickname = o.optString("nickname", f.username);
                f.initial = o.optString("initial", "");
                f.avatarColor = o.optString("avatarColor", "");
                f.avatar = o.optString("avatar", "");
                out.add(f);
            }
        }
        return out;
    }

    public void requestFriend(String username, String message) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            if (username != null && username.length() > 0) req.put("username", username);
            if (message != null && message.length() > 0) req.put("message", message);
            unwrap(postJson("/api/friends/request", req));
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public void acceptFriend(String reqId) throws ApiException {
        unwrap(postJson("/api/friends/" + reqId + "/accept", new JSONObject()));
    }

    public void rejectFriend(String reqId) throws ApiException {
        unwrap(postJson("/api/friends/" + reqId + "/reject", new JSONObject()));
    }

    /** 打开/获取与某个好友的私聊（服务端按 pairKey 复用同一条会话）。 */
    public Room dm(String userId) throws ApiException {
        JSONObject j = unwrap(get("/api/dm/" + userId));
        return parseRoom(j.optJSONObject("room"));
    }

    public Room createRoom(String name, String password) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("name", name);
            if (password != null && password.length() > 0) req.put("password", password);
            JSONObject j = unwrap(postJson("/api/rooms", req));
            return parseRoom(j.optJSONObject("room"));
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    /** 搜索房间（私聊不出现在结果里，和网页一致） */
    public List<SearchRoom> searchRooms(String q) throws ApiException {
        JSONObject j = unwrap(get("/api/rooms/search?q=" + encode(q)));
        List<SearchRoom> out = new ArrayList<SearchRoom>();
        JSONArray arr = j.optJSONArray("results");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                SearchRoom s = new SearchRoom();
                s.id = o.optString("id", "");
                s.kind = o.optString("kind", "");
                s.name = o.optString("name", "");
                s.ownerName = o.optString("ownerName", "");
                s.memberCount = o.optInt("memberCount", 0);
                s.hasPassword = o.optBoolean("hasPassword", false);
                s.joined = o.optBoolean("joined", false);
                out.add(s);
            }
        }
        return out;
    }

    /** 验证房间密码：通过后服务端在会话里记住权限，join 直接调用即可 */
    public void verifyRoom(String roomId, String password) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("password", password);
            unwrap(postJson("/api/rooms/" + roomId + "/verify", req));
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public void joinRoom(String roomId) throws ApiException {
        unwrap(postJson("/api/rooms/" + roomId + "/join", new JSONObject()));
    }

    public void leaveRoom(String roomId) throws ApiException {
        unwrap(postJson("/api/rooms/" + roomId + "/leave", new JSONObject()));
    }

    /** 成员面板 */
    public MemberPage members(String roomId) throws ApiException {
        JSONObject j = unwrap(get("/api/rooms/" + roomId + "/members"));
        MemberPage p = new MemberPage();
        p.myRole = j.optString("myRole", "");
        p.roomName = j.optString("roomName", "");
        p.heirId = j.optString("heirId", "");
        p.myRoomNickname = j.optString("myRoomNickname", "");
        p.canManage = j.optBoolean("canManage", false);
        p.canDissolve = j.optBoolean("canDissolve", false);
        p.publicHall = j.optBoolean("publicHall", false);
        p.master = j.optBoolean("master", false);
        p.dissolved = j.optBoolean("dissolved", false);
        JSONArray arr = j.optJSONArray("members");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Member m = new Member();
                m.userId = o.optString("userId", "");
                m.username = o.optString("username", "");
                m.nickname = o.optString("nickname", "");
                m.displayName = o.optString("displayName", m.nickname);
                m.role = o.optString("role", "");
                m.roleName = o.optString("roleName", "");
                m.avatar = o.optString("avatar", "");
                m.avatarColor = o.optString("avatarColor", "");
                m.initial = o.optString("initial", "");
                m.founder = o.optBoolean("founder", false);
                p.members.add(m);
            }
        }
        return p;
    }

    public void kickMember(String roomId, String userId) throws ApiException {
        JSONObject req = new JSONObject();
        try { req.put("userId", userId); } catch (JSONException ignored) { }
        unwrap(postJson("/api/rooms/" + roomId + "/kick", req));
    }

    public void setMute(String roomId, String userId, int minutes) throws ApiException {
        JSONObject req = new JSONObject();
        try {
            req.put("userId", userId);
            req.put("minutes", minutes);
        } catch (JSONException ignored) { }
        unwrap(postJson("/api/rooms/" + roomId + "/mute", req));
    }

    public void transferOwner(String roomId, String userId) throws ApiException {
        JSONObject req = new JSONObject();
        try {
            req.put("userId", userId);
            req.put("confirm", true);
        } catch (JSONException ignored) { }
        unwrap(postJson("/api/rooms/" + roomId + "/transfer", req));
    }

    public void setHeir(String roomId, String userId) throws ApiException {
        JSONObject req = new JSONObject();
        try { req.put("heirId", userId == null ? "" : userId); } catch (JSONException ignored) { }
        unwrap(postJson("/api/rooms/" + roomId + "/heir", req));
    }

    public void dissolveRoom(String roomId) throws ApiException {
        JSONObject req = new JSONObject();
        try { req.put("confirm", true); } catch (JSONException ignored) { }
        unwrap(postJson("/api/rooms/" + roomId + "/dissolve", req));
    }

    public void setRoomNickname(String roomId, String nickname) throws ApiException {
        JSONObject req = new JSONObject();
        try { req.put("nickname", nickname == null ? "" : nickname); } catch (JSONException ignored) { }
        unwrap(postJson("/api/rooms/" + roomId + "/nickname", req));
    }

    private static String encode(String s) {
        try { return java.net.URLEncoder.encode(s == null ? "" : s, "utf-8"); }
        catch (Exception e) { return s == null ? "" : s; }
    }

    /* ---------------- 消息 ---------------- */

    public MessagePage messages(String roomId, long since, int limit) throws ApiException {
        JSONObject j = unwrap(get("/api/rooms/" + roomId + "/messages?since=" + since + "&limit=" + limit));
        MessagePage p = new MessagePage();
        p.lastSeq = j.optLong("lastSeq", 0);
        p.total = j.optInt("total", 0);
        p.canPost = j.optBoolean("canPost", false);
        p.muted = j.optBoolean("muted", false);
        p.joined = j.optBoolean("joined", false);
        p.dissolved = j.optBoolean("dissolved", false);
        p.kind = j.optString("kind", "");
        p.roleName = j.optString("roleName", "");

        JSONArray arr = j.optJSONArray("messages");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null) p.messages.add(parseMessage(o));
            }
        }
        JSONArray purged = j.optJSONArray("purgedIds");
        if (purged != null) {
            for (int i = 0; i < purged.length(); i++) p.purgedIds.add(purged.optString(i, ""));
        }
        return p;
    }

    public Message sendText(String roomId, String text) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("kind", "text");
            req.put("content", text);
            JSONObject j = unwrap(postJson("/api/rooms/" + roomId + "/messages", req));
            JSONObject m = j.optJSONObject("message");
            return m == null ? new Message() : parseMessage(m);
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public Message sendFile(String roomId, String fileId, String caption) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("kind", "file");
            req.put("fileId", fileId);
            req.put("content", caption == null ? "" : caption);
            JSONObject j = unwrap(postJson("/api/rooms/" + roomId + "/messages", req));
            JSONObject m = j.optJSONObject("message");
            return m == null ? new Message() : parseMessage(m);
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public void recall(String msgId) throws ApiException {
        unwrap(postJson("/api/messages/" + msgId + "/recall", new JSONObject()));
    }

    public void deleteMessage(String msgId) throws ApiException {
        unwrap(postJson("/api/messages/" + msgId + "/delete", new JSONObject()));
    }

    /* ---------------- 文件 ---------------- */

    public interface Progress {
        void onProgress(long done, long total);
    }

    /**
     * 分块上传：init → 逐片 PUT → complete。
     * 服务端单片 4MB，这里按服务端返回的 chunkSize 走，不自己猜。
     */
    public String upload(String roomId, File file, Progress cb, Context ctx) throws ApiException {
        return uploadTo(file, roomId, cb);
    }

    /** roomId 为空/空串 = 网盘文件；返回 fileId */
    public String uploadTo(File file, String roomId, Progress cb) throws ApiException {
        long size = file.length();
        if (size <= 0) throw new ApiException("文件为空");
        if (size > 200L * 1024 * 1024) throw new ApiException("文件超过 200MB 上限");

        String fileId;
        long chunkSize;
        try {
            JSONObject req = new JSONObject();
            req.put("name", file.getName());
            req.put("size", size);
            if (roomId != null && roomId.length() > 0) req.put("roomId", roomId);
            req.put("mime", guessMime(file.getName()));
            JSONObject j = unwrap(postJson("/api/files/init", req));
            fileId = j.optString("fileId", "");
            chunkSize = j.optLong("chunkSize", 4 * 1024 * 1024);
            if (chunkSize <= 0) chunkSize = 4 * 1024 * 1024;
        } catch (JSONException e) {
            throw new ApiException("上传初始化失败");
        }
        if (fileId.length() == 0) throw new ApiException("上传初始化失败");

        FileInputStream fis = null;
        try {
            fis = new FileInputStream(file);
            byte[] buf = new byte[(int) chunkSize];
            long sent = 0;
            int index = 0;
            while (sent < size) {
                int want = (int) Math.min(chunkSize, size - sent);
                int read = 0;
                while (read < want) {
                    int n = fis.read(buf, read, want - read);
                    if (n < 0) break;
                    read += n;
                }
                if (read <= 0) throw new ApiException("读取文件时中断");

                byte[] chunk = buf;
                if (read != buf.length) {
                    chunk = new byte[read];
                    System.arraycopy(buf, 0, chunk, 0, read);
                }
                Resp r = request("PUT", "/api/files/" + fileId + "/chunk?i=" + index,
                        chunk, "application/octet-stream");
                unwrap(r);

                sent += read;
                index++;
                if (cb != null) cb.onProgress(sent, size);
            }
        } catch (IOException e) {
            throw new ApiException("读取文件失败：" + e.getMessage());
        } finally {
            if (fis != null) try { fis.close(); } catch (IOException ignored) {}
        }

        unwrap(postJson("/api/files/" + fileId + "/complete", new JSONObject()));
        return fileId;
    }

    /** 下载到本地文件，返回是否成功 */
    public void download(String urlPath, File outFile, Progress cb) throws ApiException {
        HttpURLConnection c = null;
        try {
            URL url = new URL(base + urlPath);
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(60000);
            if (token.length() > 0) c.setRequestProperty("x-token", token);
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new ApiException("文件不可用（HTTP " + code + "）");

            long total = c.getContentLength();
            InputStream is = c.getInputStream();
            FileOutputStream fos = new FileOutputStream(outFile);
            byte[] buf = new byte[64 * 1024];
            long done = 0;
            int n;
            while ((n = is.read(buf)) > 0) {
                fos.write(buf, 0, n);
                done += n;
                if (cb != null) cb.onProgress(done, total);
            }
            fos.flush();
            fos.close();
            is.close();
        } catch (IOException e) {
            throw new ApiException("下载失败：" + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /* ================================================================ */
    /* 网盘                                                              */
    /* ================================================================ */

    public static class DriveStorage {
        public long used, quota, remain;
        public String usedText = "", quotaText = "", remainText = "";
        public int percent, fileCount, trashCount;
    }

    public static class DriveFile {
        public String fileId = "", name = "", sizeText = "", mime = "", type = "", typeLabel = "";
        public String folder = "", roomName = "", downloadUrl = "", rawUrl = "", thumbUrl = "";
        public long size, createdAt, deletedAt;
        public boolean fromChat, isImage, isVideo;
        public ShareInfo share;
        public long expireAt;
        public int remainDays;
    }

    public static class ShareInfo {
        public String shareId = "", url = "", code = "", fileName = "", fileSizeText = "";
        public boolean encrypted, expired, revoked, needCode;
        public long expireAt, createdAt;
        public int downloads;
    }

    public static class DriveList {
        public List<DriveFile> items = new ArrayList<DriveFile>();
        public List<String> folders = new ArrayList<String>();
        public int total, page, pages;
        public boolean hasMore;
    }

    private static DriveFile parseDriveFile(JSONObject o) {
        DriveFile f = new DriveFile();
        f.fileId = o.optString("fileId", "");
        f.name = o.optString("name", "");
        f.size = o.optLong("size", 0);
        f.sizeText = o.optString("sizeText", "");
        f.mime = o.optString("mime", "");
        f.type = o.optString("type", "other");
        f.typeLabel = o.optString("typeLabel", "文件");
        f.folder = o.optString("folder", "");
        f.roomName = o.optString("roomName", "");
        f.fromChat = o.optBoolean("fromChat", false);
        f.rawUrl = o.optString("rawUrl", "");
        f.thumbUrl = o.optString("thumbUrl", "");
        f.downloadUrl = o.optString("downloadUrl", "");
        f.createdAt = o.optLong("createdAt", 0);
        f.deletedAt = o.optLong("deletedAt", 0);
        f.expireAt = o.optLong("expireAt", 0);
        f.remainDays = o.optInt("remainDays", 0);
        f.isImage = "image".equals(f.type);
        f.isVideo = "video".equals(f.type);
        JSONObject s = o.optJSONObject("share");
        if (s != null) f.share = parseShare(s);
        return f;
    }

    private static ShareInfo parseShare(JSONObject o) {
        ShareInfo s = new ShareInfo();
        s.shareId = o.optString("shareId", "");
        s.url = o.optString("url", "");
        s.code = o.optString("code", "");
        s.encrypted = o.optBoolean("encrypted", false);
        s.expired = o.optBoolean("expired", false);
        s.revoked = o.optBoolean("revoked", false);
        s.needCode = o.optBoolean("needCode", false);
        s.expireAt = o.optLong("expireAt", 0);
        s.createdAt = o.optLong("createdAt", 0);
        s.downloads = o.optInt("downloads", 0);
        s.fileName = o.optString("fileName", "");
        s.fileSizeText = o.optString("fileSizeText", "");
        return s;
    }

    public DriveStorage driveStorage() throws ApiException {
        JSONObject j = unwrap(get("/api/drive/storage"));
        DriveStorage d = new DriveStorage();
        d.used = j.optLong("used", 0);
        d.quota = j.optLong("quota", 0);
        d.remain = j.optLong("remain", 0);
        d.usedText = j.optString("usedText", "");
        d.quotaText = j.optString("quotaText", "");
        d.remainText = j.optString("remainText", "");
        d.percent = j.optInt("percent", 0);
        d.fileCount = j.optInt("fileCount", 0);
        d.trashCount = j.optInt("trashCount", 0);
        return d;
    }

    /** folder: null = 全部目录，"" = 根目录 */
    public DriveList driveFiles(String keyword, String type, String folder) throws ApiException {
        StringBuilder p = new StringBuilder("/api/drive/files?size=100");
        if (keyword != null && keyword.length() > 0) p.append("&keyword=").append(encode(keyword));
        if (type != null && type.length() > 0) p.append("&type=").append(encode(type));
        if (folder != null) p.append("&folder=").append(encode(folder));
        JSONObject j = unwrap(get(p.toString()));
        DriveList d = new DriveList();
        d.total = j.optInt("total", 0);
        d.page = j.optInt("page", 1);
        d.pages = j.optInt("pages", 1);
        d.hasMore = j.optBoolean("hasMore", false);
        JSONArray arr = j.optJSONArray("items");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null) d.items.add(parseDriveFile(o));
            }
        }
        JSONArray fs = j.optJSONArray("folders");
        if (fs != null) {
            for (int i = 0; i < fs.length(); i++) d.folders.add(fs.optString(i, ""));
        }
        return d;
    }

    public DriveList driveTrash() throws ApiException {
        JSONObject j = unwrap(get("/api/drive/trash?size=100"));
        DriveList d = new DriveList();
        d.total = j.optInt("total", 0);
        JSONArray arr = j.optJSONArray("items");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null) d.items.add(parseDriveFile(o));
            }
        }
        return d;
    }

    public List<ShareInfo> driveShares() throws ApiException {
        JSONObject j = unwrap(get("/api/drive/shares"));
        List<ShareInfo> out = new ArrayList<ShareInfo>();
        JSONArray arr = j.optJSONArray("items");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                ShareInfo s = parseShare(o);
                s.shareId = o.optString("shareId", s.shareId);
                s.fileName = o.optString("fileName", "");
                s.fileSizeText = o.optString("fileSizeText", "");
                out.add(s);
            }
        }
        return out;
    }

    public void createFolder(String name) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("name", name);
            unwrap(postJson("/api/drive/folders", req));
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public void deleteFolder(String name) throws ApiException {
        unwrap(request("DELETE", "/api/drive/folders/" + encode(name), null, null));
    }

    public void patchDriveFile(String fileId, String name, String folder) throws ApiException {
        JSONObject req = new JSONObject();
        try {
            if (name != null) req.put("name", name);
            if (folder != null) req.put("folder", folder);
        } catch (JSONException ignored) {
        }
        unwrap(request("PATCH", "/api/drive/files/" + fileId, utf8(req.toString()),
                "application/json; charset=utf-8"));
    }

    public void trashFile(String fileId) throws ApiException {
        unwrap(request("DELETE", "/api/drive/files/" + fileId, null, null));
    }

    public void restoreFile(String fileId) throws ApiException {
        unwrap(postJson("/api/drive/trash/" + fileId + "/restore", new JSONObject()));
    }

    public void purgeFile(String fileId) throws ApiException {
        unwrap(request("DELETE", "/api/drive/trash/" + fileId, null, null));
    }

    public ShareInfo shareFile(String fileId, int days, boolean encrypted, String code) throws ApiException {
        try {
            JSONObject req = new JSONObject();
            req.put("days", days);
            req.put("encrypted", encrypted);
            if (code != null && code.length() > 0) req.put("code", code);
            JSONObject j = unwrap(postJson("/api/drive/files/" + fileId + "/share", req));
            return parseShare(j);
        } catch (JSONException e) {
            throw new ApiException("请求构造失败");
        }
    }

    public void revokeShare(String shareId) throws ApiException {
        unwrap(request("DELETE", "/api/drive/shares/" + shareId, null, null));
    }

    /* ================================================================ */
    /* 皮肤                                                              */
    /* ================================================================ */

    public static class Skin {
        public String id = "", name = "", description = "", style = "", tone = "", author = "";
        public String preview = "", url = "";
        public boolean builtin, mine, isPublic;
    }

    public List<Skin> skins() throws ApiException {
        JSONObject j = unwrap(get("/api/skins"));
        List<Skin> out = new ArrayList<Skin>();
        JSONArray arr = j.optJSONArray("skins");
        if (arr == null) arr = j.optJSONArray("items");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Skin s = new Skin();
                s.id = o.optString("id", "");
                s.name = o.optString("name", s.id);
                s.description = o.optString("description", "");
                s.style = o.optString("style", "");
                s.tone = o.optString("tone", "");
                s.author = o.optString("author", "");
                s.preview = o.optString("preview", "");
                s.url = o.optString("url", "");
                s.builtin = o.optBoolean("builtin", false);
                s.mine = o.optBoolean("mine", false);
                s.isPublic = o.optBoolean("isPublic", false);
                if (s.id.length() > 0) out.add(s);
            }
        }
        return out;
    }

    /** 取皮肤入口 CSS（用于解析配色） */
    public String skinCss(String urlPath) throws ApiException {
        Resp r = get(urlPath);
        if (r.status < 200 || r.status >= 300) throw new ApiException("皮肤下载失败（HTTP " + r.status + "）");
        return r.body;
    }

    /* ================================================================ */
    /* 下载辅助                                                          */
    /* ================================================================ */

    /** 供系统下载器带上网关会话 Cookie（CookieManager 里已有） */
    public String cookieHeader() {
        try {
            CookieHandler h = CookieHandler.getDefault();
            if (!(h instanceof CookieManager)) return "";
            java.net.CookieStore st = ((CookieManager) h).getCookieStore();
            java.util.List<java.net.HttpCookie> cs = st.get(new java.net.URI(base));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < cs.size(); i++) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(cs.get(i).getName()).append('=').append(cs.get(i).getValue());
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] utf8(String s) {
        try {
            return s.getBytes("utf-8");
        } catch (Exception e) {
            return s.getBytes();
        }
    }

    /** 上传到网盘（roomId 为空即网盘文件），完成后落到指定目录 */
    public String uploadDrive(File file, String folder, Progress cb) throws ApiException {
        String id = uploadTo(file, "", cb);
        if (folder != null && folder.length() > 0) {
            patchDriveFile(id, null, folder);
        }
        return id;
    }

    /** 把输入流转成字符串（小工具） */
    public static String readAll(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "utf-8");
    }
}
