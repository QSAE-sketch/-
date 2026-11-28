package com.qingliao.app;

import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/**
 * 主页：公共聊天室入口、提示、皮肤入口、其他入口。
 * 对应网页版手机端的第一屏。
 */
public class HomePage extends Page {

    private Api.Room publicRoom;
    private int online = 0;
    private String anTitle = "", anContent = "";

    public HomePage(MainActivity a) {
        super(a);
    }

    @Override
    public void load() {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    List<Api.Room> rooms = act.api().rooms();
                    Api.Room pub = null;
                    for (int i = 0; i < rooms.size(); i++) {
                        if ("public".equals(rooms.get(i).kind)) { pub = rooms.get(i); break; }
                    }
                    if (pub == null && rooms.size() > 0) pub = rooms.get(0);
                    publicRoom = pub;
                    try {
                        online = act.api().onlineCount();
                    } catch (Exception ignored) {
                    }
                    try {
                        org.json.JSONObject v = act.api().version();
                        org.json.JSONObject an = v.optJSONObject("announcement");
                        if (an != null && an.optBoolean("enabled", false)) {
                            anTitle = an.optString("title", "公告");
                            anContent = an.optString("content", "");
                        }
                    } catch (Exception ignored) {
                    }
                    act.ui(new Runnable() {
                        public void run() { render(); }
                    });
                } catch (final Api.ApiException e) {
                    act.ui(new Runnable() {
                        public void run() { showError(e.getMessage()); }
                    });
                }
            }
        });
    }

    @Override
    public void onShow() {
        load();
    }

    private void render() {
        clear();

        /* ---- 公共聊天室 ---- */
        LinearLayout c1 = Ui.card(act);
        c1.setLayoutParams(Ui.cardLp());
        c1.setClickable(true);
        c1.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (publicRoom != null) act.openRoom(publicRoom.id, "公共聊天室");
            }
        });
        LinearLayout r1 = Ui.row(act);
        TextView name = Ui.bold(act, "公共聊天室", 15.5f, Ui.fg);
        r1.addView(name);
        r1.addView(Ui.gapW(act, 8));
        r1.addView(Ui.badge(act, "全员可发言"));
        r1.addView(Ui.gapW(act, 6));
        r1.addView(Ui.badge(act, online + " 人同时在线"));
        r1.addView(Ui.spacer(act));
        r1.addView(Ui.text(act, "›", 18, Ui.fg3));
        c1.addView(r1);
        c1.addView(Ui.gap(act, 7));
        int joined = publicRoom == null ? 0 : publicRoom.memberCount;
        c1.addView(Ui.text(act, joined + " 人已加入 · 所有登录用户均可发送文字/图片/视频/文件",
                12.5f, Ui.fg3));
        box.addView(c1);

        /* ---- 官方公告（有内容才显示） ---- */
        if (anContent != null && anContent.length() > 0) {
            LinearLayout ca = Ui.card(act);
            ca.setLayoutParams(Ui.cardLp());
            ca.addView(Ui.cardHead(act, (anTitle.length() > 0 ? anTitle : "公告")));
            ca.addView(Ui.gap(act, 8));
            ca.addView(Ui.text(act, anContent, 13, Ui.fg2));
            box.addView(ca);
        }

        /* ---- 提示 ---- */
        LinearLayout c2 = Ui.card(act);
        c2.setLayoutParams(Ui.cardLp());
        c2.addView(Ui.cardHead(act, "提示"));
        c2.addView(Ui.gap(act, 9));
        String[] tips = {
                "公共聊天室对所有登录用户开放，无需加入即可发言。",
                "单文件上限 200MB，支持分片上传与断点续传。",
                "消息发送后 2 分钟内可撤回；删除仅对自己隐藏，直接删除可随时彻底清除。"
        };
        for (int i = 0; i < tips.length; i++) {
            TextView t = Ui.text(act, tips[i], 13, Ui.fg2);
            c2.addView(t);
            if (i < tips.length - 1) c2.addView(Ui.gap(act, 5));
        }
        box.addView(c2);

        /* ---- 皮肤 ---- */
        LinearLayout c3 = Ui.card(act);
        c3.setLayoutParams(Ui.cardLp());
        c3.addView(Ui.cardHead(act, "皮肤"));
        c3.addView(Ui.gap(act, 9));
        LinearLayout sr = Ui.row(act);
        sr.setClickable(true);
        sr.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                act.startActivity(new android.content.Intent(act, SkinActivity.class));
            }
        });
        sr.addView(Ui.text(act, "皮肤中心 · 当前 " + Ui.skinName, 14.5f, Ui.fg));
        sr.addView(Ui.spacer(act));
        sr.addView(Ui.text(act, "›", 18, Ui.fg3));
        c3.addView(sr);
        box.addView(c3);

        /* ---- 其他入口 ---- */
        LinearLayout c4 = Ui.card(act);
        c4.setLayoutParams(Ui.cardLp());
        c4.addView(Ui.cardHead(act, "其他入口"));
        c4.addView(Ui.gap(act, 8));

        TextView e1 = Ui.text(act, "进入「我的房间」→ 创建或加入自定义房间", 14, Ui.accentText);
        e1.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
        e1.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                act.select(1);
            }
        });
        c4.addView(e1);
        c4.addView(Ui.hline(act));
        TextView e2 = Ui.text(act, "进入「好友」→ 添加好友并发起私聊", 14, Ui.accentText);
        e2.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
        e2.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                act.select(2);
            }
        });
        c4.addView(e2);
        box.addView(c4);

        /* 页脚版本 */
        TextView foot = Ui.text(act, "轻聊 · 原生客户端", 11.5f, Ui.fg3);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, Ui.dp(18), 0, 0);
        box.addView(foot);
    }
}
