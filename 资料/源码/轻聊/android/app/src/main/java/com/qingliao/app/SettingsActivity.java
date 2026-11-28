package com.qingliao.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;

/**
 * 设置：外观·主题（跟随系统/按时间/手动）、外观·特效（消息金色流光）、
 * 存储（清缓存/清聊天记录）、下载位置、关于。
 */
public class SettingsActivity extends Activity {

    private Prefs prefs;
    private Store store;
    private Api api;
    private LinearLayout box;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        store = new Store(this);
        Ui.init(this);
        prefs.applySkinColors();
        Ui.themeWindow(this);

        api = new Api(store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE);
        api.setToken(store.token());

        LinearLayout root = Ui.col(this);
        root.setBackgroundColor(Ui.bg);
        root.addView(topbar());

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        box = Ui.col(this);
        box.setPadding(0, Ui.dp(2), 0, Ui.dp(24));
        sv.addView(box, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        render();
    }

    private View topbar() {
        LinearLayout wrap = Ui.col(this);
        wrap.setBackgroundColor(Ui.topbar);
        LinearLayout row = Ui.row(this);
        row.setPadding(Ui.dp(6), 0, Ui.dp(12), 0);
        TextView back = Ui.iconBtn(this, "‹");
        back.setTextSize(26);
        back.setTextColor(Ui.topbarFg);
        back.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { finish(); }
        });
        row.addView(back);
        TextView t = Ui.bold(this, "设置", 16.5f, Ui.topbarFg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.leftMargin = Ui.dp(2);
        row.addView(t, lp);
        wrap.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(54)));
        View line = new View(this);
        line.setBackgroundColor(Ui.border);
        wrap.addView(line, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.7f))));
        return wrap;
    }

    private void render() {
        box.removeAllViews();
        renderTheme();
        renderFont();
        renderFx();
        renderStorage();
        renderDownload();
        renderAbout();
    }

    /* ---------------- 外观·主题 ---------------- */

    private void renderTheme() {
        LinearLayout c = Ui.card(this);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(this, "外观 · 主题"));
        c.addView(Ui.gap(this, 10));

        LinearLayout seg = Ui.row(this);
        seg.setBackgroundDrawable(Ui.rect(Ui.surface2, 4, Ui.border, 1));
        seg.setPadding(Ui.dp(3), Ui.dp(3), Ui.dp(3), Ui.dp(3));
        String[] names = {"跟随系统", "按时间", "手动"};
        final int cur = prefs.themeMode();
        for (int i = 0; i < names.length; i++) {
            final int mode = i;
            boolean on = mode == cur;
            TextView t = Ui.text(this, names[i], 13, on ? Ui.onAccent : Ui.fg2);
            if (on) t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
            t.setBackgroundDrawable(on ? Ui.rect(Ui.accent, 3, 0, 0) : null);
            t.setClickable(true);
            t.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    if (prefs.themeMode() == mode) return;
                    prefs.setThemeMode(mode);
                    recreate();
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i > 0) lp.leftMargin = Ui.dp(3);
            seg.addView(t, lp);
        }
        c.addView(seg);

        c.addView(Ui.gap(this, 10));
        LinearLayout curRow = Ui.row(this);
        TextView dot = Ui.text(this, "●", 10, Ui.dark ? Ui.fg2 : Ui.accent);
        curRow.addView(dot);
        curRow.addView(Ui.gapW(this, 6));
        curRow.addView(Ui.bold(this,
                "当前生效：" + (Ui.dark ? "深色" : "浅色") + " · 模式：" + prefs.modeName(), 13, Ui.fg));
        c.addView(curRow);

        if (prefs.themeMode() == 2) {
            c.addView(Ui.gap(this, 10));
            TextView sw = Ui.text(this, Ui.dark ? "切到浅色" : "切到深色", 13.5f, Ui.accentText);
            sw.setPadding(0, Ui.dp(4), 0, Ui.dp(4));
            sw.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    prefs.setManualDark(!prefs.manualDark());
                    recreate();
                }
            });
            c.addView(sw);
        }

        c.addView(Ui.gap(this, 8));
        c.addView(Ui.text(this,
                "「跟随系统」读取设备的深色 / 浅色设置，系统改动会实时同步；「按时间」按本机时间在日间与夜间之间"
                        + "自动切换（当前 19:00 后转深色、07:00 后转浅色）；「手动」由你自己指定深浅。"
                        + "选择会保存在本机。", 11.5f, Ui.fg3));
        box.addView(c);
    }

    /* ---------------- 外观·字体 ---------------- */

    private void renderFont() {
        LinearLayout c = Ui.card(this);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(this, "外观 · 字体"));
        c.addView(Ui.gap(this, 10));

        final String[][] FONTS = {
            {"", "系统默认"}, {"hei", "黑体"}, {"song", "宋体"},
            {"kai", "楷体"}, {"yuan", "圆体"}, {"mono", "等宽"}
        };
        final String cur = prefs.fontId();
        // 每行 3 个按钮，两行铺开
        LinearLine row = null;
        for (int i = 0; i < FONTS.length; i++) {
            if (i % 3 == 0) {
                row = new LinearLine();
                row.line = Ui.row(this);
                c.addView(row.line);
            }
            final String fid = FONTS[i][0];
            final String fname = FONTS[i][1];
            boolean on = fid.equals(cur);
            TextView t = Ui.text(this, fname, 13, on ? Ui.onAccent : Ui.fg2);
            if (on) t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(7), 0, Ui.dp(7));
            t.setBackgroundDrawable(on ? Ui.rect(Ui.accent, 4, 0, 0) : Ui.rect(Ui.surface2, 4, Ui.border, 1));
            t.setClickable(true);
            t.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    if (fid.equals(prefs.fontId())) return;
                    prefs.setFontId(fid);
                    Ui.setFont(fid);
                    Ui.toast0(SettingsActivity.this, "已切换字体：" + fname);
                    recreate();
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i % 3 > 0) lp.leftMargin = Ui.dp(5);
            row.line.addView(t, lp);
        }
        c.addView(Ui.gap(this, 8));
        c.addView(Ui.text(this,
                "选择后全站立即生效；系统未装所选字体时会自动退回同类字体显示。", 11.5f, Ui.fg3));
        box.addView(c);
    }

    /** 字体按钮的每行容器（仅用于循环内临时持有行引用） */
    private static class LinearLine { LinearLayout line; }

    /* ---------------- 外观·特效 ---------------- */

    private void renderFx() {
        LinearLayout c = Ui.card(this);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(this, "外观 · 特效"));
        c.addView(Ui.gap(this, 10));

        LinearLayout row = Ui.row(this);
        LinearLayout left = Ui.col(this);
        left.addView(Ui.text(this, "最高权限账号金色特效", 15, Ui.fg));
        final boolean on = prefs.goldFx();
        TextView sub = Ui.text(this, on
                ? "最高权限账号的名字与气泡带金色装饰。"
                : "已彻底关闭全部金色装饰，名字与气泡恢复普通样式。", 11.5f, Ui.fg3);
        sub.setPadding(0, Ui.dp(3), 0, 0);
        left.addView(sub);
        row.addView(left, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(Ui.gapW(this, 10));
        TextView btn = Ui.button(this, on ? "已开启" : "已关闭", on);
        btn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                prefs.setGoldFx(!prefs.goldFx());
                render();
            }
        });
        row.addView(btn);
        c.addView(row);

        c.addView(Ui.gap(this, 9));
        c.addView(Ui.text(this, "只影响本机显示，不改变任何人发出的消息内容；看久了晃眼可以随时关掉。",
                11.5f, Ui.fg3));
        box.addView(c);
    }

    /* ---------------- 存储 ---------------- */

    private void renderStorage() {
        LinearLayout c = Ui.card(this);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(this, "存储"));
        c.addView(Ui.gap(this, 6));

        LinearLayout r1 = Ui.row(this);
        r1.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
        LinearLayout l1 = Ui.col(this);
        l1.addView(Ui.text(this, "清除缓存", 15, Ui.fg));
        l1.addView(Ui.text(this, "图片与上传临时文件，当前约 " + sizeText(dirSize(getCacheDir())),
                11.5f, Ui.fg3));
        r1.addView(l1, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView b1 = Ui.button(this, "清除", false);
        b1.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                deleteChildren(getCacheDir());
                toast("缓存已清除");
                render();
            }
        });
        r1.addView(b1);
        c.addView(r1);
        c.addView(Ui.hline(this));

        LinearLayout r2 = Ui.row(this);
        r2.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
        LinearLayout l2 = Ui.col(this);
        l2.addView(Ui.text(this, "清除聊天记录", 15, Ui.fg));
        l2.addView(Ui.text(this, "仅清除本机缓存的聊天记录，当前约 " + sizeText(dirSize(chatCacheDir())),
                11.5f, Ui.fg3));
        r2.addView(l2, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView b2 = Ui.button(this, "清除", false);
        b2.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Dlg.confirm(SettingsActivity.this, "清除聊天记录",
                        "只清本机缓存，服务器端数据保持不变；其他设备仍能看到这些记录。", "清除",
                        new Dlg.OnOk() {
                            public void run() {
                                deleteChildren(chatCacheDir());
                                toast("本机聊天记录已清除");
                                render();
                            }
                        });
            }
        });
        r2.addView(b2);
        c.addView(r2);

        c.addView(Ui.gap(this, 6));
        c.addView(Ui.text(this, "「清除聊天记录」只作用于本机：清掉本机缓存的聊天数据，并让这些记录在本机不再显示。"
                + "服务器端数据不会被删除，其它设备 / 其它用户仍能看到这些记录。", 11.5f, Ui.fg3));
        box.addView(c);
    }

    /* ---------------- 下载 ---------------- */

    private void renderDownload() {
        LinearLayout c = Ui.card(this);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(this, "下载"));
        c.addView(Ui.gap(this, 8));

        LinearLayout row = Ui.row(this);
        LinearLayout left = Ui.col(this);
        left.addView(Ui.text(this, "下载保存位置", 15, Ui.fg));
        left.addView(Ui.text(this, prefs.downloadPublic()
                ? "系统「下载」目录（Download/轻聊）" : "应用私有目录（不占相册、无需权限）", 11.5f, Ui.fg3));
        row.addView(left, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView btn = Ui.button(this, "更改", false);
        btn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                prefs.setDownloadPublic(!prefs.downloadPublic());
                render();
            }
        });
        row.addView(btn);
        c.addView(row);
        box.addView(c);
    }

    /* ---------------- 关于 ---------------- */

    private void renderAbout() {
        LinearLayout c = Ui.card(this);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(this, "关于"));
        c.addView(Ui.gap(this, 6));

        LinearLayout row = Ui.row(this);
        row.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
        row.addView(Ui.text(this, "版本", 15, Ui.fg));
        row.addView(Ui.spacer(this));
        row.addView(Ui.text(this, "v" + versionName(), 13, Ui.fg2));
        row.setClickable(true);
        row.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showNotes(); }
        });
        c.addView(row);
        c.addView(Ui.hline(this));

        LinearLayout srv = Ui.row(this);
        srv.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
        srv.addView(Ui.text(this, "服务器", 15, Ui.fg));
        srv.addView(Ui.spacer(this));
        String b = store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE;
        srv.addView(Ui.text(this, b.replace("https://", ""), 11.5f, Ui.fg3));
        srv.setClickable(true);
        srv.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Dlg.input(SettingsActivity.this, "服务器地址", "https://…", 
                        store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE,
                        new Dlg.OnText() {
                            public void run(String s) {
                                String b = s.trim();
                                if (b.length() == 0) b = Api.DEFAULT_BASE;
                                if (!b.startsWith("http")) b = "https://" + b;
                                store.setBase(b);
                                store.setToken("");
                                toast("地址已保存，请重新登录");
                                startActivity(new Intent(SettingsActivity.this, LoginActivity.class));
                                SettingsActivity.this.finish();
                            }
                        }, "保存");
            }
        });
        c.addView(srv);
        box.addView(c);

        TextView foot = Ui.text(this, "轻聊 · 原生客户端 · minSdk 21（Android 5.0.2+）", 11.5f, Ui.fg3);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, Ui.dp(16), 0, 0);
        box.addView(foot);
    }

    private String versionName() {
        try {
            String local = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            if (local != null && local.length() > 0) return local;
        } catch (Exception ignored) {
        }
        try {
            JSONObject j = api.version();
            JSONObject v = j.optJSONObject("version");
            if (v != null) return v.optString("name", v.optString("version", "—"));
            return j.optString("version", "—");
        } catch (Exception e) {
            return "—";
        }
    }

    private void showNotes() {
        try {
            JSONObject j = api.version();
            JSONObject v = j.optJSONObject("version");
            if (v == null) v = j;
            JSONArray notes = v.optJSONArray("notes");
            LinearLayout body = Ui.col(this);
            body.addView(Ui.bold(this, "轻聊 " + v.optString("name", ""), 15, Ui.fg));
            body.addView(Ui.gap(this, 8));
            if (notes != null) {
                for (int i = 0; i < notes.length(); i++) {
                    TextView t = Ui.text(this, "· " + notes.optString(i, ""), 12.5f, Ui.fg2);
                    t.setPadding(0, Ui.dp(3), 0, Ui.dp(3));
                    body.addView(t);
                }
            }
            String contact = v.optString("contact", "");
            if (contact.length() > 0) {
                body.addView(Ui.gap(this, 8));
                body.addView(Ui.text(this, "联系：" + contact, 12, Ui.fg3));
            }
            Dlg.base(this, "更新记录", body, "关闭", null, null);
        } catch (Exception e) {
            toast("更新记录获取失败");
        }
    }

    /* ---------------- 工具 ---------------- */

    private File chatCacheDir() {
        File f = new File(getFilesDir(), "chat_cache");
        if (!f.exists()) f.mkdirs();
        return f;
    }

    private static long dirSize(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long s = 0;
        File[] files = f.listFiles();
        if (files == null) return 0;
        for (int i = 0; i < files.length; i++) s += dirSize(files[i]);
        return s;
    }

    private void deleteChildren(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (int i = 0; i < files.length; i++) {
            if (files[i].isDirectory()) {
                deleteChildren(files[i]);
            }
            files[i].delete();
        }
    }

    private static String sizeText(long b) {
        if (b < 1024) return b + " B";
        if (b < 1024 * 1024) return String.format("%.1f KB", b / 1024.0);
        return String.format("%.1f MB", b / (1024.0 * 1024));
    }

    private void toast(String s) {
        Ui.toast0(this, s);
    }
}
