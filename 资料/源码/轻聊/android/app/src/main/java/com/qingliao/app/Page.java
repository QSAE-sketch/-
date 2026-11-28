package com.qingliao.app;

import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 页面基类：一个可滚动的纵向容器，五个主页签都继承它。
 *
 * 约定：load() 负责起后台请求，拿到数据后在主线程重建内容；
 * 内容每次整块重建（简单可靠，页面元素量很小，不卡）。
 */
public abstract class Page {

    protected final MainActivity act;
    protected final LinearLayout box;

    public Page(MainActivity a) {
        act = a;
        box = Ui.col(a);
        box.setPadding(0, Ui.dp(2), 0, Ui.dp(20));
    }

    public View view() {
        ScrollView sv = new ScrollView(act);
        sv.setVerticalScrollBarEnabled(false);
        sv.setClipToPadding(false);
        sv.addView(box, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return sv;
    }

    protected void clear() {
        box.removeAllViews();
    }

    public abstract void load();

    /** 切回本页时调用（默认重新拉数据） */
    public void onShow() {
        load();
    }

    protected void showError(String msg) {
        clear();
        LinearLayout c = Ui.card(act);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.bold(act, "加载失败", 15, Ui.fg));
        c.addView(Ui.gap(act, 6));
        c.addView(Ui.text(act, msg == null ? "网络不可用" : msg, 13, Ui.fg2));
        c.addView(Ui.gap(act, 10));
        TextView retry = Ui.button(act, "重试", false);
        retry.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { load(); }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        c.addView(retry, lp);
        box.addView(c);
    }

    protected void empty(String msg) {
        TextView t = Ui.text(act, msg, 14, Ui.fg3);
        t.setGravity(android.view.Gravity.CENTER);
        t.setPadding(Ui.dp(24), Ui.dp(40), Ui.dp(24), Ui.dp(40));
        box.addView(t);
    }
}
