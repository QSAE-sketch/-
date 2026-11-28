package com.qingliao.app;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 原生端设计系统。
 *
 * 与网页版 2.9.0 的观感对齐：深蓝底、方角（2–6dp）、细描边、克制的层次。
 * 所有页面只通过这里拿颜色和控件，换肤/换深浅色只改本类里的调色板。
 *
 * 皮肤：网页皮肤是 CSS 变量覆盖，这里直接把 CSS 里的变量解析成色板，
 * 所以 57 套皮肤在原生端也能真正换色（只取配色，不搬网页结构）。
 */
public class Ui {

    /* ---------------- 调色板 ---------------- */
    public static boolean dark = true;
    public static int bg, surface, surface2, surface3, border, borderStrong;
    public static int fg, fg2, fg3, accent, accentText, accentSoft, onAccent, danger, okColor, warn;
    public static int bubbleMe, bubbleMeFg, bubbleOther, bubbleOtherFg;
    public static int topbar, topbarFg, tabbar, overlay;
    public static String skinName = "原版";

    public static float density = 2f;

    public static void init(Context c) {
        density = c.getResources().getDisplayMetrics().density;
        palette(true);
    }

    public static int dp(float v) {
        return (int) (v * density + 0.5f);
    }

    /* ---------------- 两套基础配色 ---------------- */

    public static void palette(boolean isDark) {
        dark = isDark;
        if (isDark) {
            bg = 0xFF0C1522;
            surface = 0xFF16233A;
            surface2 = 0xFF1B2A45;
            surface3 = 0xFF22334F;
            border = 0xFF22314A;
            borderStrong = 0xFF314660;
            fg = 0xFFE8EFFA;
            fg2 = 0xFFA6B8D2;
            fg3 = 0xFF7C8FAC;
            accent = 0xFF3B82F6;
            accentText = 0xFF7DAEF9;
            accentSoft = 0xFF1B3157;
            onAccent = 0xFFFFFFFF;
            danger = 0xFFE2685C;
            okColor = 0xFF4CC38A;
            warn = 0xFFE0A33E;
            bubbleMe = 0xFF2A4E86;
            bubbleMeFg = 0xFFEDF4FF;
            bubbleOther = 0xFF1A2942;
            bubbleOtherFg = 0xFFE8EFFA;
            topbar = 0xFF0C1522;
            topbarFg = 0xFFE8EFFA;
            tabbar = 0xFF0A121E;
            overlay = 0xB3030A14;
        } else {
            bg = 0xFFF1F4F9;
            surface = 0xFFFFFFFF;
            surface2 = 0xFFF6F8FC;
            surface3 = 0xFFEBF0F8;
            border = 0xFFDFE6F1;
            borderStrong = 0xFFC9D4E4;
            fg = 0xFF14202F;
            fg2 = 0xFF5A6A80;
            fg3 = 0xFF8A99AD;
            accent = 0xFF2F6BDF;
            accentText = 0xFF2F6BDF;
            accentSoft = 0xFFE7EFFF;
            onAccent = 0xFFFFFFFF;
            danger = 0xFFD24B3E;
            okColor = 0xFF1F9D63;
            warn = 0xFFB97C12;
            bubbleMe = 0xFFD8E7FF;
            bubbleMeFg = 0xFF10233C;
            bubbleOther = 0xFFFFFFFF;
            bubbleOtherFg = 0xFF14202F;
            topbar = 0xFFFFFFFF;
            topbarFg = 0xFF14202F;
            tabbar = 0xFFFFFFFF;
            overlay = 0x73000000;
        }
    }

    /* ---------------- 皮肤：解析 CSS 变量 ---------------- */

    private static final Pattern VAR = Pattern.compile("--([a-zA-Z0-9\\-_]+)\\s*:\\s*([^;\\n\\r]+);");

    /** 把皮肤 CSS 的主配色套进来；解析不到关键变量时不生效 */
    public static boolean applyCss(String css) {
        return applyCss(css, dark);
    }

    /**
     * 皮肤 CSS 里浅色与深色是两套变量块（:root 与 :root[data-theme="dark"]）。
     * 必须整块取，不能把两套混着用，否则会出现「浅顶栏 + 深正文」这种花屏。
     */
    public static boolean applyCss(String css, boolean wantDark) {
        if (css == null || css.length() == 0) return false;
        String block = pickBlock(css, wantDark);
        Map<String, Integer> m = new HashMap<String, Integer>();
        Matcher mt = VAR.matcher(block);
        while (mt.find()) {
            Integer c = parseColor(mt.group(2));
            if (c != null) m.put(mt.group(1), c);
        }
        Integer cbg = m.get("bg");
        Integer csf = m.get("surface");
        Integer cfg = m.get("fg");
        if (cbg == null || csf == null || cfg == null) return false;

        bg = cbg;
        surface = csf;
        surface2 = pick(m.get("surface-2"), mix(csf, cfg, 0.05f));
        surface3 = pick(m.get("surface-3"), mix(csf, cfg, 0.10f));
        border = pick(m.get("border"), mix(csf, cfg, 0.16f));
        borderStrong = pick(m.get("border-3"), mix(csf, cfg, 0.28f));
        fg = cfg;
        fg2 = pick(m.get("fg-2"), mix(cfg, cbg, 0.35f));
        fg3 = pick(m.get("fg-3"), mix(cfg, cbg, 0.55f));
        accent = pick(m.get("accent"), 0xFF3B82F6);
        accentSoft = pick(m.get("accent-soft"), mix(accent, cbg, 0.82f));
        onAccent = pick(m.get("on-accent"), contrastOn(accent));
        danger = pick(m.get("danger"), 0xFFD24B3E);
        bubbleMe = pick(m.get("bubble-mine"), mix(accent, cbg, 0.55f));
        bubbleOther = pick(m.get("bubble"), surface);
        bubbleMeFg = pick(m.get("bubble-fg"), contrastOn(bubbleMe));
        bubbleOtherFg = pick(m.get("bubble-fg"), contrastOn(bubbleOther));
        topbar = pick(m.get("topbar-bg"), bg);
        topbarFg = pick(m.get("topbar-fg"), contrastOn(topbar));
        tabbar = pick(m.get("tabbar-bg"), surface);
        // 皮肤里的 accent 有时是给浅底用的深色，放到深底上会看不清，这里兜一下
        accent = ensureContrast(accent, bg, 3.2f);
        accentText = ensureContrast(accent, bg, 4.5f);
        dark = luminance(bg) < 0.42f;
        okColor = pick(m.get("ok"), 0xFF4CC38A);
        warn = pick(m.get("warn"), 0xFFE0A33E);
        overlay = dark ? 0xB3030A14 : 0x73000000;
        return true;
    }

    private static int pick(Integer v, int def) { return v == null ? def : v; }

    /** 只取这套 CSS 的四个代表色做色卡预览，不改动当前生效的调色板 */
    public static int[] previewColors(String css) {
        int sb = bg, ss = surface, sa = accent, sf = fg, sme = bubbleMe;
        boolean sd = dark;
        boolean ok = applyCss(css, true);
        int[] out = {bg, surface, accent, fg, bubbleMe};
        bg = sb; surface = ss; accent = sa; fg = sf; bubbleMe = sme; dark = sd;
        return ok ? out : null;
    }

    public static void toast0(android.app.Activity a, String msg) {
        if (msg == null || msg.length() == 0) return;
        android.widget.Toast.makeText(a, msg, android.widget.Toast.LENGTH_SHORT).show();
    }

    public static int mix(int a, int b, float t) {
        int ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
        int br = (b >> 16) & 0xFF, bgc = (b >> 8) & 0xFF, bb = b & 0xFF;
        int r = (int) (ar + (br - ar) * t);
        int g = (int) (ag + (bgc - ag) * t);
        int bl = (int) (ab + (bb - ab) * t);
        return 0xFF000000 | (r << 16) | (g << 8) | bl;
    }

    /** 选定一套变量块：深色模式优先 data-theme="dark"，否则取第一块 :root */
    private static String pickBlock(String css, boolean wantDark) {
        Matcher b = Pattern.compile("([^{}]+)\\{([^{}]*)\\}").matcher(css);
        String first = null;
        String darkBlock = null;
        while (b.find()) {
            String sel = b.group(1).toLowerCase();
            String body = b.group(2);
            if (body.indexOf("--bg") < 0) continue;
            if (darkBlock == null && (sel.indexOf("data-theme=\"dark\"") >= 0
                    || sel.indexOf("data-theme=dark") >= 0)) {
                darkBlock = body;
            }
            if (first == null) first = body;
        }
        if (wantDark && darkBlock != null) return darkBlock;
        return first == null ? css : first;
    }

    /** 往离背景更远的方向混，直到对比度够用 */
    public static int ensureContrast(int c, int onBg, float minRatio) {
        if (ratio(c, onBg) >= minRatio) return c;
        int target = luminance(onBg) > 0.42f ? 0xFF000000 : 0xFFFFFFFF;
        for (float t = 0.2f; t <= 0.9f; t += 0.2f) {
            int m = mix(c, target, t);
            if (ratio(m, onBg) >= minRatio) return m;
        }
        return target;
    }

    private static float ratio(int a, int b) {
        float la = luminance(a) + 0.05f;
        float lb = luminance(b) + 0.05f;
        return Math.max(la, lb) / Math.min(la, lb);
    }

    public static float luminance(int c) {
        double r = ((c >> 16) & 0xFF) / 255.0;
        double g = ((c >> 8) & 0xFF) / 255.0;
        double b = (c & 0xFF) / 255.0;
        r = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
        g = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
        b = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
        return (float) (0.2126 * r + 0.7152 * g + 0.0722 * b);
    }

    public static int contrastOn(int c) {
        return luminance(c) > 0.45f ? 0xFF101820 : 0xFFFFFFFF;
    }

    /** 支持 #rgb / #rrggbb / #aarrggbb；rgb()/rgba() 一律跳过（交给兜底色） */
    public static Integer parseColor(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.length() == 0) return null;
        if (s.startsWith("rgb")) return null;
        if (!s.startsWith("#")) return null;
        String h = s.substring(1);
        try {
            if (h.length() == 3) {
                int r = Integer.parseInt(h.substring(0, 1) + h.substring(0, 1), 16);
                int g = Integer.parseInt(h.substring(1, 2) + h.substring(1, 2), 16);
                int b = Integer.parseInt(h.substring(2, 3) + h.substring(2, 3), 16);
                return 0xFF000000 | (r << 16) | (g << 8) | b;
            }
            if (h.length() == 6) return (int) (0xFF000000L | Long.parseLong(h, 16));
            if (h.length() == 8) return (int) Long.parseLong(h, 16);
        } catch (Exception ignored) {
        }
        return null;
    }

    /* ---------------- 窗口 ---------------- */

    public static void themeWindow(Activity a) {
        Window w = a.getWindow();
        if (Build.VERSION.SDK_INT >= 23) {
            w.setStatusBarColor(dark ? bg : mix(bg, 0xFF000000, 0.05f));
            w.setNavigationBarColor(dark ? tabbar : 0xFF1B1F26);
            if (!dark) {
                View dv = w.getDecorView();
                // 浅色主题下把状态栏图标改成深色（API 23+ 才支持）
                dv.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            }
        } else if (Build.VERSION.SDK_INT >= 21) {
            // Android 5.x 不支持深色状态栏图标：浅色主题下把状态栏压深一点，
            // 保证白色图标看得见（否则白底白图标等于消失）
            w.setStatusBarColor(dark ? bg : mix(accent, 0xFF000000, 0.35f));
            w.setNavigationBarColor(dark ? tabbar : 0xFF10151C);
        }
    }

    /* ---------------- 背景 ---------------- */

    public static GradientDrawable rect(int color, float radiusDp, int strokeColor, float strokeDp) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) g.setStroke(Math.max(1, dp(strokeDp)), strokeColor);
        return g;
    }

    public static GradientDrawable gradient(int from, int to, float radiusDp) {
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{from, to});
        g.setCornerRadius(dp(radiusDp));
        return g;
    }

    public static Drawable pressed(int normal, float radiusDp, int pressedColor) {
        StateListDrawable d = new StateListDrawable();
        d.addState(new int[]{android.R.attr.state_pressed}, rect(pressedColor, radiusDp, 0, 0));
        d.addState(new int[]{}, rect(normal, radiusDp, 0, 0));
        return d;
    }

    public static GradientDrawable circle(int color, int strokeColor, float strokeDp) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(color);
        if (strokeDp > 0) g.setStroke(Math.max(1, dp(strokeDp)), strokeColor);
        return g;
    }

    /* ---------------- 基础控件 ---------------- */

    public static LinearLayout col(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    public static TextView text(Context c, CharSequence s, float sp, int color) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setLineSpacing(dp(3), 1f);
        return t;
    }

    public static TextView bold(Context c, CharSequence s, float sp, int color) {
        TextView t = text(c, s, sp, color);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    public static TextView title(Context c, CharSequence s) {
        TextView t = bold(c, s, 19, fg);
        t.setLetterSpacing(0.03f);
        return t;
    }

    public static TextView sub(Context c, CharSequence s) {
        return text(c, s, 12.5f, fg3);
    }

    /** 卡片：深色 surface + 1dp 描边 + 6dp 方角 */
    public static LinearLayout card(Context c) {
        LinearLayout l = col(c);
        l.setBackgroundDrawable(rect(surface, 6, border, 1));
        l.setPadding(dp(14), dp(13), dp(14), dp(13));
        return l;
    }

    public static LinearLayout.LayoutParams cardLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(12);
        lp.rightMargin = dp(12);
        lp.topMargin = dp(10);
        return lp;
    }

    /** 卡片小标题（截图里「存储空间」「提示」那一行） */
    public static TextView cardHead(Context c, CharSequence s) {
        TextView t = bold(c, s, 13, fg2);
        t.setLetterSpacing(0.05f);
        return t;
    }

    public static View gap(Context c, float h) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(h)));
        return v;
    }

    public static View gapW(Context c, float w) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(w), 1));
        return v;
    }

    public static View spacer(Context c) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(0, 1, 1f));
        return v;
    }

    public static View hline(Context c) {
        View v = new View(c);
        v.setBackgroundColor(border);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(0.7f)));
        v.setLayoutParams(lp);
        return v;
    }

    public static TextView badge(Context c, String s) {
        TextView t = text(c, s, 11, accentText);
        t.setBackgroundDrawable(rect(accentSoft, 3, 0, 0));
        t.setPadding(dp(7), dp(2), dp(7), dp(2));
        t.setGravity(Gravity.CENTER);
        return t;
    }

    public static TextView badgeGray(Context c, String s) {
        TextView t = text(c, s, 11, fg2);
        t.setBackgroundDrawable(rect(surface3, 3, 0, 0));
        t.setPadding(dp(7), dp(2), dp(7), dp(2));
        t.setGravity(Gravity.CENTER);
        return t;
    }

    public static TextView chip(Context c, String s, boolean on) {
        TextView t = text(c, s, 12.5f, on ? accentText : fg2);
        t.setBackgroundDrawable(rect(on ? accentSoft : surface, 3, on ? accent : border, 1));
        t.setPadding(dp(11), dp(6), dp(11), dp(6));
        t.setGravity(Gravity.CENTER);
        if (on) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    /** 主要按钮（截图里的「上传」「下载」） */
    public static TextView button(Context c, String s, boolean primary) {
        TextView t = text(c, s, 14, primary ? onAccent : fg);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(14), dp(9), dp(14), dp(9));
        t.setBackgroundDrawable(pressed(primary ? accent : surface2, 4,
                primary ? mix(accent, 0xFF000000, 0.18f) : surface3));
        t.setClickable(true);
        return t;
    }

    /** 小号次级按钮 */
    public static TextView miniBtn(Context c, String s) {
        TextView t = text(c, s, 12, accentText);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(10), dp(5), dp(10), dp(5));
        t.setBackgroundDrawable(rect(accentSoft, 3, accent, 1));
        t.setClickable(true);
        return t;
    }

    public static TextView miniBtnGray(Context c, String s) {
        TextView t = text(c, s, 12, fg2);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(10), dp(5), dp(10), dp(5));
        t.setBackgroundDrawable(rect(surface2, 3, border, 1));
        t.setClickable(true);
        return t;
    }

    public static TextView dangerBtn(Context c, String s) {
        TextView t = text(c, s, 12, danger);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(10), dp(5), dp(10), dp(5));
        t.setBackgroundDrawable(rect(0x00FFFFFF, 3, danger, 1));
        t.setClickable(true);
        return t;
    }

    /** 顶栏图标按钮（文字符号，避免引入图标资源） */
    public static TextView iconBtn(Context c, String glyph) {
        TextView t = text(c, glyph, 17, fg2);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(8), dp(4), dp(8), dp(4));
        t.setClickable(true);
        return t;
    }

    /**
     * 月亮按钮：Android 5.0 的系统字体里没有 ☾/🌙，直接画一个，
     * 免得在老设备上显示成方块。
     */
    public static View moonButton(final Context c, final boolean darkMode,
                                  final View.OnClickListener click) {
        View v = new View(c) {
            @Override
            protected void onDraw(android.graphics.Canvas canvas) {
                super.onDraw(canvas);
                float w = getWidth(), h = getHeight();
                float r = Math.min(w, h) * 0.30f;
                float cx = w / 2f, cy = h / 2f;
                android.graphics.Paint p = new android.graphics.Paint(
                        android.graphics.Paint.ANTI_ALIAS_FLAG);
                p.setColor(topbarFg);
                canvas.drawCircle(cx, cy, r, p);
                if (darkMode) {
                    // 深色模式：用顶栏底色挖掉一块，形成月牙
                    p.setColor(topbar);
                    canvas.drawCircle(cx + r * 0.55f, cy - r * 0.42f, r * 0.92f, p);
                } else {
                    // 浅色模式：实心圆 + 一圈短射线，画成太阳
                    p.setColor(topbarFg);
                    p.setStrokeWidth(dp(1.4f));
                    for (int i = 0; i < 8; i++) {
                        double a = Math.PI * i / 4;
                        float x1 = (float) (cx + Math.cos(a) * (r + dp(2)));
                        float y1 = (float) (cy + Math.sin(a) * (r + dp(2)));
                        float x2 = (float) (cx + Math.cos(a) * (r + dp(5)));
                        float y2 = (float) (cy + Math.sin(a) * (r + dp(5)));
                        canvas.drawLine(x1, y1, x2, y2, p);
                    }
                }
            }
        };
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(42), dp(42)));
        v.setClickable(true);
        v.setOnClickListener(click);
        return v;
    }

    /**
     * 自动换行的标签容器：窄屏上把筛选标签折成两行，
     * 比横向滚动更直观（不隐藏选项）。
     */
    public static class FlowRow extends android.view.ViewGroup {
        private int gapX = dp(6);
        private int gapY = dp(7);

        public FlowRow(Context c) {
            super(c);
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int width = MeasureSpec.getSize(widthSpec);
            int limit = width - getPaddingLeft() - getPaddingRight();
            int lineW = 0, lineH = 0, totalH = 0;
            int count = getChildCount();
            for (int i = 0; i < count; i++) {
                View ch = getChildAt(i);
                if (ch.getVisibility() == GONE) continue;
                measureChild(ch, MeasureSpec.makeMeasureSpec(limit, MeasureSpec.AT_MOST),
                        MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
                int cw = ch.getMeasuredWidth();
                int chh = ch.getMeasuredHeight();
                if (lineW > 0 && lineW + gapX + cw > limit) {
                    totalH += lineH + gapY;
                    lineW = cw;
                    lineH = chh;
                } else {
                    lineW += (lineW > 0 ? gapX : 0) + cw;
                    lineH = Math.max(lineH, chh);
                }
            }
            totalH += lineH;
            setMeasuredDimension(width,
                    totalH + getPaddingTop() + getPaddingBottom());
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            int limit = getWidth() - getPaddingLeft() - getPaddingRight();
            int x = getPaddingLeft(), y = getPaddingTop(), lineH = 0;
            for (int i = 0; i < getChildCount(); i++) {
                View ch = getChildAt(i);
                if (ch.getVisibility() == GONE) continue;
                int cw = ch.getMeasuredWidth(), chh = ch.getMeasuredHeight();
                if (x > getPaddingLeft() && x + cw > getPaddingLeft() + limit) {
                    x = getPaddingLeft();
                    y += lineH + gapY;
                    lineH = 0;
                }
                ch.layout(x, y, x + cw, y + chh);
                x += cw + gapX;
                lineH = Math.max(lineH, chh);
            }
        }
    }

    /** 勾选框统一用主题主色（系统默认是绿/青色，和整体不搭） */
    public static void tintCheck(android.widget.CompoundButton cb) {
        if (Build.VERSION.SDK_INT >= 21) {
            int[][] states = {{android.R.attr.state_checked}, {}};
            int[] colors = {accent, borderStrong};
            cb.setButtonTintList(new android.content.res.ColorStateList(states, colors));
        }
    }

    public static EditText input(Context c, String hint) {
        EditText e = new EditText(c);
        e.setHint(hint);
        e.setHintTextColor(fg3);
        e.setTextColor(fg);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        e.setBackgroundDrawable(rect(surface2, 4, border, 1));
        e.setPadding(dp(11), dp(8), dp(11), dp(8));
        e.setSingleLine(true);
        return e;
    }

    /** 头像：有图用图，没图用首字 + 纯色块 */
    public static FrameLayout avatar(Context c, String initial, String colorHex, int sizeDp) {
        FrameLayout f = new FrameLayout(c);
        int sz = dp(sizeDp);
        f.setLayoutParams(new LinearLayout.LayoutParams(sz, sz));
        TextView t = text(c, TextUtils.isEmpty(initial) ? "?" : initial, sizeDp * 0.4f, 0xFFFFFFFF);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        int col = 0xFF3F5A83;
        try {
            if (colorHex != null && colorHex.length() > 0) {
                Integer v = parseColor(colorHex.startsWith("#") ? colorHex : "#" + colorHex);
                if (v != null) col = v;
            }
        } catch (Exception ignored) {
        }
        f.setBackgroundDrawable(circle(col, 0, 0));
        f.addView(t, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return f;
    }

    /** 细进度条（存储空间） */
    public static LinearLayout bar(Context c, int percent) {
        int p = Math.max(0, Math.min(100, percent));
        LinearLayout wrap = row(c);
        wrap.setBackgroundDrawable(rect(surface3, 2, 0, 0));
        wrap.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(5)));
        if (p > 0) {
            View fill = new View(c);
            fill.setBackgroundDrawable(rect(accent, 2, 0, 0));
            wrap.addView(fill, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, p));
        }
        if (p < 100) {
            View rest = new View(c);
            wrap.addView(rest, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 100 - p));
        }
        return wrap;
    }

    public static void pad(View v, float l, float t, float r, float b) {
        v.setPadding(dp(l), dp(t), dp(r), dp(b));
    }

    public static LinearLayout.LayoutParams lp(int wDp, int hDp) {
        return new LinearLayout.LayoutParams(
                wDp < 0 ? wDp : dp(wDp), hDp < 0 ? hDp : dp(hDp));
    }

    public static LinearLayout.LayoutParams lpW(int wDp) {
        return new LinearLayout.LayoutParams(
                wDp < 0 ? wDp : dp(wDp), ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    public static LinearLayout.LayoutParams matchW() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }
}
