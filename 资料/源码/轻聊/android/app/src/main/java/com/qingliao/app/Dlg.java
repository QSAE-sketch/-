package com.qingliao.app;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.drawable.ColorDrawable;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 应用内弹层。全部自绘，风格与页面一致（深蓝卡片 + 方角），
 * 不依赖系统 AlertDialog 的白底样式。
 */
public class Dlg {

    public interface OnOk {
        void run();
    }

    public interface OnText {
        void run(String text);
    }

    public static Dialog base(Activity a, String title, View body, String okText,
                              final OnOk onOk, String cancelText) {
        final Dialog d = new Dialog(a);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout box = Ui.col(a);
        box.setBackgroundDrawable(Ui.rect(Ui.surface, 6, Ui.border, 1));
        box.setPadding(Ui.dp(16), Ui.dp(15), Ui.dp(16), Ui.dp(13));

        if (title != null && title.length() > 0) {
            TextView t = Ui.bold(a, title, 16.5f, Ui.fg);
            t.setLetterSpacing(0.02f);
            box.addView(t);
            box.addView(Ui.gap(a, 10));
        }
        if (body != null) {
            ScrollView sv = new ScrollView(a);
            sv.setVerticalScrollBarEnabled(false);
            sv.addView(body, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            slp.bottomMargin = Ui.dp(12);
            box.addView(sv, slp);
        }

        LinearLayout btns = Ui.row(a);
        btns.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
        if (cancelText != null) {
            TextView c = Ui.button(a, cancelText, false);
            c.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { d.dismiss(); }
            });
            btns.addView(c);
            btns.addView(Ui.gapW(a, 8));
        }
        TextView ok = Ui.button(a, okText == null ? "确定" : okText, true);
        ok.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                d.dismiss();
                if (onOk != null) onOk.run();
            }
        });
        btns.addView(ok);
        box.addView(btns);

        d.setContentView(box);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(0x00000000));
            w.setLayout(WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.CENTER);
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.width = Math.min(a.getResources().getDisplayMetrics().widthPixels - Ui.dp(44), Ui.dp(420));
            w.setAttributes(lp);
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams at = w.getAttributes();
            at.dimAmount = 0.55f;
            w.setAttributes(at);
        }
        d.show();
        return d;
    }

    public static Dialog message(Activity a, String title, String msg, String ok) {
        TextView t = Ui.text(a, msg, 14, Ui.fg2);
        return base(a, title, t, ok, null, null);
    }

    public static Dialog confirm(Activity a, String title, String msg, String okText, final OnOk onOk) {
        TextView t = Ui.text(a, msg, 14, Ui.fg2);
        return base(a, title, t, okText, onOk, "取消");
    }

    public static Dialog input(Activity a, String title, String hint, String value,
                               final OnText cb, String okText) {
        final EditText e = Ui.input(a, hint);
        e.setText(value == null ? "" : value);
        return base(a, title, e, okText == null ? "确定" : okText,
                new OnOk() {
                    public void run() { cb.run(e.getText().toString()); }
                }, "取消");
    }

    /** 多行输入（分享说明之类） */
    public static Dialog inputMulti(Activity a, String title, String hint, String value,
                                    final OnText cb, String okText) {
        final EditText e = Ui.input(a, hint);
        e.setSingleLine(false);
        e.setMinLines(2);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        e.setText(value == null ? "" : value);
        return base(a, title, e, okText == null ? "确定" : okText,
                new OnOk() {
                    public void run() { cb.run(e.getText().toString()); }
                }, "取消");
    }

    /** 等待层：显示一句提示，调用方拿 dialog 自己 dismiss */
    public static Dialog busy(Activity a, String msg) {
        return progress(a, msg).dialog;
    }

    /** 可更新文字的进度层（上传下载用） */
    public static class Busy {
        public Dialog dialog;
        public TextView text;
        public void set(String s) { if (text != null) text.setText(s); }
        public void dismiss() { try { dialog.dismiss(); } catch (Exception ignored) { } }
    }

    public static Busy progress(Activity a, String msg) {
        final Busy b = new Busy();
        LinearLayout box = Ui.row(a);
        box.setBackgroundDrawable(Ui.rect(Ui.surface, 6, Ui.border, 1));
        box.setPadding(Ui.dp(18), Ui.dp(16), Ui.dp(18), Ui.dp(16));
        ProgressBar pb = new ProgressBar(a);
        pb.setIndeterminate(true);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22));
        plp.rightMargin = Ui.dp(12);
        box.addView(pb, plp);
        b.text = Ui.text(a, msg, 14, Ui.fg);
        box.addView(b.text);

        Dialog d = new Dialog(a);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setContentView(box);
        d.setCancelable(false);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(0x00000000));
            w.setGravity(Gravity.CENTER);
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
            w.setAttributes(lp);
        }
        d.show();
        b.dialog = d;
        return b;
    }
}
