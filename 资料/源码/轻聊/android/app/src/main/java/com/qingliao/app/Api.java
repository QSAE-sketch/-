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
        public boolean founder, master;
    }

    public static class Room {
        public String id = "", kind = "", name = "", role = "", roleName = "";
        public int memberCount;
        public boolean joined, hasPassword, dissolved, muted;
        public long createdAt;
    }

    public static class MsgFile {
        public String id = "", name = "", mime = "", url = "", dlUrl = "";
        public long size;
        public boolean isImage, isVideo, deleted;
    }

    public static class Message {
        public String id = "", roomId = "", kind = "text", content = "";
        public String senderId = "", senderName = "";
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
        long size = file.length();
        if (size <= 0) throw new ApiException("文件为空");
        if (size > 200L * 1024 * 1024) throw new ApiException("文件超过 200MB 上限");

        String fileId;
        long chunkSize;
        try {
            JSONObject req = new JSONObject();
            req.put("name", file.getName());
            req.put("size", size);
            req.put("roomId", roomId);
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

    /** 把输入流转成字符串（小工具） */
    public static String readAll(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "utf-8");
    }
}
