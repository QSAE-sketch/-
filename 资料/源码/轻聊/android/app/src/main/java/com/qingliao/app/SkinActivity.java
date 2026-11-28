package com.qingliao.app;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 皮肤中心。
 *
 * 网页皮肤是「CSS 变量覆盖」，原生端不加载 CSS，但可以直接解析 CSS 里的配色变量，
 * 所以 57 套内置皮肤在这里都能真正换色（只取配色，不搬网页排版）。
 */
public class SkinActivity extends Activity {

    private Api api;
    private Prefs prefs;
    private LinearLayout listBox;
    private EditText search;

    private final List<Api.Skin> all = new ArrayList<Api.Skin>();
    private final Map<String, int[]> colors = new HashMap<String, int[]>();   // bg, surface, accent, fg
    private final Map<String, LinearLayout[]> swatches = new HashMap<String, LinearLayout[]>();
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private String keyword = "";
    private boolean loaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        Ui.init(this);
        prefs.applySkinColors();
        Ui.themeWindow(this);

        Store store = new Store(this);
        api = new Api(store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE);
        api.setToken(store.token());

        LinearLayout root = Ui.col(this);
        root.setBackgroundColor(Ui.bg);
        root.addView(topbar());

        LinearLayout head = Ui.col(this);
        head.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), Ui.dp(4));
        search = Ui.input(this, "搜索皮肤（名称 / 风格 / 关键词）");
        search.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            public void onTextChanged(CharSequence s, int a, int b, int c) { }
            public void afterTextChanged(Editable s) {
                keyword = s.toString().trim().toLowerCase();
                renderList();
            }
        });
        head.addView(search);
        root.addView(head);

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        listBox = Ui.col(this);
        listBox.setPadding(0, Ui.dp(4), 0, Ui.dp(24));
        sv.addView(listBox, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        // 搜索框不要一进来就抢焦点（否则键盘会自己弹出来遮住列表）
        getWindow().setSoftInputMode(
                android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN);
        search.clearFocus();

        renderList();
        loadSkins();
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
        LinearLayout mid = Ui.col(this);
        TextView t = Ui.bold(this, "皮肤中心", 16.5f, Ui.topbarFg);
        mid.addView(t);
        mid.addView(Ui.text(this, "当前：" + Ui.skinName, 11, Ui.topbarFg));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.leftMargin = Ui.dp(2);
        row.addView(mid, lp);
        wrap.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(54)));
        View line = new View(this);
        line.setBackgroundColor(Ui.border);
        wrap.addView(line, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.7f))));
        return wrap;
    }

    /* ---------------- 数据 ---------------- */

    private void loadSkins() {
        new Thread(new Runnable() {
            public void run() {
                try {
                    final List<Api.Skin> list = api.skins();
                    runOnUiThread(new Runnable() {
                        public void run() {
                            all.clear();
                            all.addAll(list);
                            loaded = true;
                            renderList();
                            prefetch();
                        }
                    });
                } catch (final Api.ApiException e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            Ui.toast0(SkinActivity.this, "皮肤列表加载失败：" + e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    /** 并发把没缓存过的皮肤 CSS 抓下来，解析成色卡 */
    private void prefetch() {
        for (int i = 0; i < all.size(); i++) {
            final Api.Skin s = all.get(i);
            final String cached = prefs.skinCss(s.id);
            if (cached.length() > 0) {
                int[] c = Ui.previewColors(cached);
                if (c != null) {
                    colors.put(s.id, c);
                    updateSwatch(s.id);
                    continue;
                }
            }
            pool.execute(new Runnable() {
                public void run() {
                    try {
                        final String css = api.skinCss(s.url);
                        prefs.setSkinCss(s.id, css);
                        prefs.setSkinName(s.id, s.name);
                        final int[] c = Ui.previewColors(css);
                        if (c != null) {
                            runOnUiThread(new Runnable() {
                                public void run() {
                                    colors.put(s.id, c);
                                    updateSwatch(s.id);
                                }
                            });
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
        }
    }

    private void updateSwatch(String id) {
        LinearLayout[] sw = swatches.get(id);
        int[] c = colors.get(id);
        if (sw == null || c == null) return;
        // 大块用主色、底部条用底色、右边小块用文字色：远看就能区分风格
        sw[0].setBackgroundColor(c[2]);
        sw[1].setBackgroundColor(c[0]);
        sw[2].setBackgroundColor(c[3]);
    }

    /* ---------------- 列表 ---------------- */

    private void renderList() {
        listBox.removeAllViews();
        swatches.clear();

        LinearLayout first = Ui.card(this);
        first.setLayoutParams(Ui.cardLp());
        first.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        first.addView(row("默认外观", "原版深蓝 · 跟随深浅色模式", null, ""));
        listBox.addView(first);

        if (!loaded) {
            TextView t = Ui.text(this, "正在加载皮肤…", 13, Ui.fg3);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(24), 0, 0);
            listBox.addView(t);
            return;
        }

        LinearLayout card = Ui.card(this);
        card.setLayoutParams(Ui.cardLp());
        card.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        // 星标置顶：星标皮肤排前面，组内保持服务器原顺序
        final List<Api.Skin> ordered = new ArrayList<Api.Skin>(all);
        Collections.sort(ordered, new Comparator<Api.Skin>() {
            public int compare(Api.Skin a, Api.Skin b) {
                boolean sa = prefs.skinStarred(a.id);
                boolean sb = prefs.skinStarred(b.id);
                if (sa == sb) return 0;
                return sa ? -1 : 1;
            }
        });
        int shown = 0;
        for (int i = 0; i < ordered.size(); i++) {
            Api.Skin s = ordered.get(i);
            if (keyword.length() > 0 && !match(s, keyword)) continue;
            String right = s.id.equals(prefs.skinId()) ? "当前" : "";
            if (shown > 0) card.addView(Ui.hline(this));
            card.addView(row(s.name, desc(s), s, right));
            shown++;
        }
        if (shown == 0) {
            TextView t = Ui.text(this, "没有匹配的皮肤", 13, Ui.fg3);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(20), 0, Ui.dp(20));
            card.addView(t);
        }
        listBox.addView(card);

        TextView hint = Ui.text(this, "共 " + all.size() + " 套内置皮肤 · 只取配色，不加载网页样式", 11.5f, Ui.fg3);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, Ui.dp(12), 0, 0);
        listBox.addView(hint);
    }

    private boolean match(Api.Skin s, String kw) {
        return (s.name + " " + s.description + " " + s.style + " " + s.tone + " " + s.id)
                .toLowerCase().indexOf(kw) >= 0;
    }

    private String desc(Api.Skin s) {
        StringBuilder sb = new StringBuilder();
        if (s.description != null && s.description.length() > 0) sb.append(s.description);
        if (s.style != null && s.style.length() > 0) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(s.style);
        }
        return sb.toString();
    }

    private View row(final String name, String desc, final Api.Skin skin, String tag) {
        LinearLayout r = Ui.row(this);
        r.setPadding(Ui.dp(11), Ui.dp(10), Ui.dp(11), Ui.dp(10));
        r.setClickable(true);

        // 色卡：上主底 / 下强调条 / 右侧小块
        LinearLayout sw = Ui.col(this);
        sw.setBackgroundDrawable(Ui.rect(Ui.surface3, 4, Ui.border, 1));
        sw.setClipToOutline(false);
        LinearLayout top = new LinearLayout(this);
        LinearLayout bottom = new LinearLayout(this);
        LinearLayout side = new LinearLayout(this);
        int base = skin == null ? Ui.bg : Ui.surface3;
        top.setBackgroundColor(base);
        bottom.setBackgroundColor(skin == null ? Ui.accent : Ui.surface2);
        side.setBackgroundColor(skin == null ? Ui.accent : Ui.surface2);
        sw.addView(top, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        LinearLayout lower = Ui.row(this);
        lower.addView(bottom, new LinearLayout.LayoutParams(0, Ui.dp(9), 2f));
        lower.addView(side, new LinearLayout.LayoutParams(0, Ui.dp(9), 1f));
        sw.addView(lower, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(9)));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(Ui.dp(46), Ui.dp(46));
        slp.rightMargin = Ui.dp(11);
        r.addView(sw, slp);
        if (skin != null) {
            swatches.put(skin.id, new LinearLayout[]{top, bottom, side});
            int[] c = colors.get(skin.id);
            if (c != null) {
                top.setBackgroundColor(c[2]);
                bottom.setBackgroundColor(c[0]);
                side.setBackgroundColor(c[3]);
            }
        }

        LinearLayout mid = Ui.col(this);
        mid.addView(Ui.text(this, name, 14.5f, Ui.fg));
        if (desc.length() > 0) {
            TextView d = Ui.text(this, desc, 11.5f, Ui.fg3);
            d.setMaxLines(2);
            mid.addView(d);
        }
        r.addView(mid, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (tag.length() > 0) r.addView(Ui.badge(this, tag));

        // 星标按钮：打星后置顶；独立点击，不触发整行「应用皮肤」
        if (skin != null) {
            final Api.Skin target = skin;
            final TextView star = Ui.text(this, prefs.skinStarred(target.id) ? "★" : "☆",
                    20f, prefs.skinStarred(target.id) ? 0xFFB8862E : Ui.fg3);
            star.setPadding(Ui.dp(8), Ui.dp(4), Ui.dp(2), Ui.dp(4));
            star.setClickable(true);
            star.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    boolean on = prefs.toggleSkinStar(target.id);
                    Ui.toast0(SkinActivity.this, on ? "已加星标，下次置顶" : "已取消星标");
                    renderList();
                }
            });
            r.addView(star, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }

        r.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (skin == null) applyDefault();
                else applySkin(skin);
            }
        });
        return r;
    }

    /* ---------------- 应用 ---------------- */

    private void applyDefault() {
        prefs.setSkinId("");
        Ui.skinName = "原版";
        Ui.toast0(this, "已恢复默认外观");
        finish();
    }

    private void applySkin(final Api.Skin s) {
        if (s.id.equals(prefs.skinId())) {
            finish();
            return;
        }
        String css = prefs.skinCss(s.id);
        if (css.length() > 0) {
            commit(s, css);
            return;
        }
        final Dlg.Busy b = Dlg.progress(this, "正在获取「" + s.name + "」…");
        new Thread(new Runnable() {
            public void run() {
                try {
                    final String css = api.skinCss(s.url);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            b.dismiss();
                            commit(s, css);
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            b.dismiss();
                            Ui.toast0(SkinActivity.this,
                                    e.getMessage() == null ? "皮肤获取失败" : e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    private void commit(Api.Skin s, String css) {
        if (!Ui.applyCss(css)) {
            Ui.toast0(this, "这套皮肤的配色解析失败，已保持原样");
            return;
        }
        prefs.setSkinCss(s.id, css);
        prefs.setSkinName(s.id, s.name);
        prefs.setSkinId(s.id);
        Ui.skinName = s.name;
        Ui.toast0(this, "已切换到「" + s.name + "」");
        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        pool.shutdownNow();
    }
}
