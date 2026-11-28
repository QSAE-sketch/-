package com.qingliao.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.os.Build;

import java.util.Calendar;

/**
 * 本机偏好：主题模式、金色流光、皮肤、下载位置。
 *
 * 只存本机（和网页版一致：换设备不跟随），不改服务端数据。
 */
public class Prefs {

    private static final String P = "ql_native_prefs";
    private static final String K_THEME_MODE = "themeMode";   // 0 跟随系统 / 1 按时间 / 2 手动
    private static final String K_THEME_DARK = "themeDark";   // 手动模式下的选择
    private static final String K_GOLD_FX = "goldFx";         // 消息金色流光
    private static final String K_SKIN = "skinId";            // 皮肤 id，空=原版
    private static final String K_SKIN_STARS = "skinStars";   // 星标皮肤 id（逗号分隔），打开列表置顶
    private static final String K_FONT = "fontId";            // 界面字体 id，空=系统默认
    private static final String K_SKIN_CSS = "skinCss_";      // 皮肤 CSS 缓存
    private static final String K_DOWNLOAD_PUBLIC = "dlPublic";
    private static final String K_TIME_START = "timeDarkStart";
    private static final String K_TIME_END = "timeDarkEnd";

    private final SharedPreferences sp;
    private final Context ctx;

    public Prefs(Context c) {
        ctx = c.getApplicationContext();
        sp = ctx.getSharedPreferences(P, Context.MODE_PRIVATE);
    }

    public int themeMode() { return sp.getInt(K_THEME_MODE, 0); }

    /** 切换主题模式：0 跟随系统 / 1 按时间 / 2 手动 */
    public void setThemeMode(int v) { sp.edit().putInt(K_THEME_MODE, v).apply(); }

    public boolean manualDark() { return sp.getBoolean(K_THEME_DARK, true); }
    public void setManualDark(boolean v) { sp.edit().putBoolean(K_THEME_DARK, v).apply(); }

    public boolean goldFx() { return sp.getBoolean(K_GOLD_FX, true); }
    public void setGoldFx(boolean v) { sp.edit().putBoolean(K_GOLD_FX, v).apply(); }

    public String fontId() { return sp.getString(K_FONT, ""); }
    public void setFontId(String id) { sp.edit().putString(K_FONT, id == null ? "" : id).apply(); }

    public String skinId() { return sp.getString(K_SKIN, ""); }
    public void setSkinId(String id) { sp.edit().putString(K_SKIN, id == null ? "" : id).apply(); }

    /** 星标皮肤：用逗号分隔的 id 串存本机 */
    public boolean skinStarred(String id) {
        if (id == null || id.length() == 0) return false;
        String raw = sp.getString(K_SKIN_STARS, "");
        if (raw.length() == 0) return false;
        String[] parts = raw.split(",");
        for (String p : parts) if (p.equals(id)) return true;
        return false;
    }

    /** 切换星标，返回切换后是否为星标态 */
    public boolean toggleSkinStar(String id) {
        if (id == null || id.length() == 0) return false;
        java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<String>();
        String raw = sp.getString(K_SKIN_STARS, "");
        if (raw.length() > 0) {
            String[] parts = raw.split(",");
            for (String p : parts) if (p.length() > 0) set.add(p);
        }
        boolean on;
        if (set.contains(id)) { set.remove(id); on = false; }
        else { set.add(id); on = true; }
        StringBuilder sb = new StringBuilder();
        for (String s : set) { if (sb.length() > 0) sb.append(','); sb.append(s); }
        sp.edit().putString(K_SKIN_STARS, sb.toString()).apply();
        return on;
    }

    public String skinCss(String id) { return sp.getString(K_SKIN_CSS + id, ""); }
    public void setSkinCss(String id, String css) { sp.edit().putString(K_SKIN_CSS + id, css).apply(); }

    /** true = 系统「下载」目录；false = 应用私有目录（不需要任何权限） */
    public boolean downloadPublic() { return sp.getBoolean(K_DOWNLOAD_PUBLIC, true); }
    public void setDownloadPublic(boolean v) { sp.edit().putBoolean(K_DOWNLOAD_PUBLIC, v).apply(); }

    public int timeDarkStart() { return sp.getInt(K_TIME_START, 19); }
    public int timeDarkEnd() { return sp.getInt(K_TIME_END, 7); }

    /** 当前应该用深色还是浅色 */
    public boolean darkNow() {
        int mode = themeMode();
        if (mode == 2) return manualDark();
        if (mode == 1) {
            int h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
            int s = timeDarkStart(), e = timeDarkEnd();
            if (s <= e) return h >= s && h < e;
            return h >= s || h < e;
        }
        if (Build.VERSION.SDK_INT >= 8) {
            int night = ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return night == Configuration.UI_MODE_NIGHT_YES;
        }
        return true;
    }

    /** 主题模式的中文名 */
    public String modeName() {
        int mode = themeMode();
        if (mode == 1) return "按时间";
        if (mode == 2) return "手动";
        return "跟随系统";
    }

    /** 把当前皮肤配色套进 Ui；返回是否成功 */
    public boolean applySkinColors() {
        boolean darkNow = darkNow();
        Ui.setFont(fontId());   // 界面字体：每个 Activity 初始化时都同步一次
        Ui.palette(darkNow);
        String id = skinId();
        if (id.length() == 0) {
            Ui.skinName = "原版";
            return false;
        }
        String css = skinCss(id);
        if (css.length() == 0) {
            Ui.skinName = "原版";
            return false;
        }
        boolean okCss = Ui.applyCss(css, darkNow);
        Ui.skinName = sp.getString("skinName_" + id, id);
        if (!okCss) {
            Ui.palette(darkNow);
            return false;
        }
        // 皮肤自带底色，深浅模式由皮肤决定；这里只保证浅色皮肤在浅色模式下可用
        if (!darkNow && Ui.dark) {
            // 浅色模式下选了深色皮肤：尊重皮肤（网页也是皮肤优先）
        }
        return true;
    }

    public void setSkinName(String id, String name) {
        sp.edit().putString("skinName_" + id, name == null ? "" : name).apply();
    }
}
