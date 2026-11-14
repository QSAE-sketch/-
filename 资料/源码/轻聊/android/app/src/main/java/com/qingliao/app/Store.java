package com.qingliao.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 本地存储：登录凭证 + 多账号「记住密码」。
 *
 * SharedPreferences 落在应用私有目录（/data/data/com.qingliao.app/），
 * 未 root 的设备上其他应用读不到。密码字段额外做了一层 Base64 + 设备级异或混淆，
 * 避免直接明文躺在文件里；这不是强加密，真正的安全边界是应用沙箱。
 */
public class Store {

    private static final String PREF = "qingliao_store";
    private static final String K_TOKEN = "token";
    private static final String K_BASE = "base";
    private static final String K_ACCOUNTS = "accounts";
    private static final String K_AUTO = "autoUser";
    private static final String K_LAST = "lastUser";
    private static final String K_REMEMBER = "rememberDefault";

    public static class Account {
        public String user = "";
        public String pass = "";
        public String nick = "";
    }

    private final SharedPreferences sp;

    public Store(Context ctx) {
        sp = ctx.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    /* ---------------- token / 服务器 ---------------- */

    public String token() { return sp.getString(K_TOKEN, ""); }
    public void setToken(String t) { sp.edit().putString(K_TOKEN, t == null ? "" : t).apply(); }

    public String base() { return sp.getString(K_BASE, ""); }
    public void setBase(String b) { sp.edit().putString(K_BASE, b == null ? "" : b).apply(); }

    /* ---------------- 账号列表 ---------------- */

    public List<Account> accounts() {
        List<Account> out = new ArrayList<Account>();
        String raw = sp.getString(K_ACCOUNTS, "");
        if (raw.length() == 0) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Account a = new Account();
                a.user = o.optString("user", "");
                a.pass = unmask(o.optString("pass", ""));
                a.nick = o.optString("nick", "");
                if (a.user.length() > 0) out.add(a);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private void saveAccounts(List<Account> list) {
        JSONArray arr = new JSONArray();
        for (int i = 0; i < list.size(); i++) {
            Account a = list.get(i);
            try {
                JSONObject o = new JSONObject();
                o.put("user", a.user);
                o.put("pass", mask(a.pass));
                o.put("nick", a.nick);
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        sp.edit().putString(K_ACCOUNTS, arr.toString()).apply();
    }

    public Account find(String user) {
        List<Account> list = accounts();
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).user.equals(user)) return list.get(i);
        }
        return null;
    }

    /** 登录成功后登记：记住密码的留在列表里，否则移除 */
    public void remember(String user, String pass, String nick, boolean remember) {
        List<Account> list = accounts();
        int idx = -1;
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).user.equals(user)) { idx = i; break; }
        }
        if (idx >= 0) list.remove(idx);
        if (remember) {
            Account a = new Account();
            a.user = user;
            a.pass = pass;
            a.nick = nick == null ? "" : nick;
            list.add(0, a);  // 最近使用的排最前
        }
        saveAccounts(list);
        sp.edit().putString(K_LAST, user).apply();
    }

    public void forget(String user) {
        List<Account> list = accounts();
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).user.equals(user)) { list.remove(i); break; }
        }
        saveAccounts(list);
        if (autoUser().equals(user)) setAutoUser("");
    }

    public void updateNick(String user, String nick) {
        List<Account> list = accounts();
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).user.equals(user)) {
                list.get(i).nick = nick;
                saveAccounts(list);
                return;
            }
        }
    }

    /* ---------------- 自动登录 ---------------- */

    public String autoUser() { return sp.getString(K_AUTO, ""); }
    public void setAutoUser(String u) { sp.edit().putString(K_AUTO, u == null ? "" : u).apply(); }

    public String lastUser() { return sp.getString(K_LAST, ""); }

    public boolean rememberDefault() { return sp.getBoolean(K_REMEMBER, true); }
    public void setRememberDefault(boolean v) { sp.edit().putBoolean(K_REMEMBER, v).apply(); }

    /* ---------------- 轻混淆 ---------------- */

    private static final byte[] SALT = {0x51, 0x4c, 0x2d, 0x32, 0x30, 0x32, 0x36, 0x01};

    private static String mask(String s) {
        if (s == null || s.length() == 0) return "";
        byte[] b = s.getBytes();
        for (int i = 0; i < b.length; i++) b[i] ^= SALT[i % SALT.length];
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    private static String unmask(String s) {
        if (s == null || s.length() == 0) return "";
        try {
            byte[] b = Base64.decode(s, Base64.NO_WRAP);
            for (int i = 0; i < b.length; i++) b[i] ^= SALT[i % SALT.length];
            return new String(b);
        } catch (Exception e) {
            return "";
        }
    }
}
