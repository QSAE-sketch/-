package com.qingliao.app;

import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/** 好友页：收到的申请、加好友、好友列表（点开即私聊）。 */
public class FriendsPage extends Page {

    private Api.FriendData data;

    public FriendsPage(MainActivity a) {
        super(a);
    }

    @Override
    public void load() {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    final Api.FriendData d = act.api().friendData();
                    act.ui(new Runnable() {
                        public void run() {
                            data = d;
                            render();
                        }
                    });
                } catch (final Api.ApiException e) {
                    act.ui(new Runnable() {
                        public void run() { showError(e.getMessage()); }
                    });
                }
            }
        });
    }

    private void render() {
        clear();
        if (data == null) return;

        /* ---- 好友申请 ---- */
        if (!data.incoming.isEmpty()) {
            LinearLayout c = Ui.card(act);
            c.setLayoutParams(Ui.cardLp());
            c.addView(Ui.cardHead(act, "好友申请（" + data.incoming.size() + "）"));
            c.addView(Ui.gap(act, 6));
            for (int i = 0; i < data.incoming.size(); i++) {
                final Api.FriendReq r = data.incoming.get(i);
                LinearLayout row = Ui.row(act);
                row.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
                row.addView(Ui.avatar(act, first(r.nickname), null, 34));
                row.addView(Ui.gapW(act, 9));
                LinearLayout left = Ui.col(act);
                left.addView(Ui.text(act, r.nickname + "  @" + r.username, 14, Ui.fg));
                if (r.message.length() > 0) {
                    left.addView(Ui.text(act, r.message, 12, Ui.fg3));
                }
                row.addView(left, new LinearLayout.LayoutParams(0,
                        ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                TextView ok = Ui.miniBtn(act, "同意");
                ok.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) { handle(r, true); }
                });
                row.addView(ok);
                row.addView(Ui.gapW(act, 6));
                TextView no = Ui.miniBtnGray(act, "拒绝");
                no.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) { handle(r, false); }
                });
                row.addView(no);
                c.addView(row);
                if (i < data.incoming.size() - 1) c.addView(Ui.hline(act));
            }
            box.addView(c);
        }

        /* ---- 添加好友 ---- */
        LinearLayout c2 = Ui.card(act);
        c2.setLayoutParams(Ui.cardLp());
        c2.addView(Ui.cardHead(act, "添加好友"));
        c2.addView(Ui.gap(act, 8));
        LinearLayout sr = Ui.row(act);
        final EditText ed = Ui.input(act, "对方的账号名");
        sr.addView(ed, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        sr.addView(Ui.gapW(act, 8));
        TextView add = Ui.button(act, "添加", true);
        add.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                final String u = ed.getText().toString().trim();
                if (u.length() == 0) { act.toast("请输入账号名"); return; }
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().requestFriend(u, "");
                            act.ui(new Runnable() {
                                public void run() {
                                    ed.setText("");
                                    act.toast("申请已发送");
                                    load();
                                }
                            });
                        } catch (final Api.ApiException e) {
                            act.ui(new Runnable() {
                                public void run() { act.toast(e.getMessage()); }
                            });
                        }
                    }
                });
            }
        });
        sr.addView(add);
        c2.addView(sr);
        c2.addView(Ui.gap(act, 6));
        c2.addView(Ui.text(act, "对方同意后，就能在这里点开私聊（私聊不会出现在房间列表里）。",
                11.5f, Ui.fg3));
        box.addView(c2);

        /* ---- 好友列表 ---- */
        LinearLayout c3 = Ui.card(act);
        c3.setLayoutParams(Ui.cardLp());
        c3.addView(Ui.cardHead(act, "好友（" + data.friends.size() + "）"));
        c3.addView(Ui.gap(act, 4));
        if (data.friends.isEmpty()) {
            TextView t = Ui.text(act, "还没有好友。填上对方账号名申请添加，对方同意后会出现在这里。",
                    13, Ui.fg3);
            t.setPadding(0, Ui.dp(10), 0, Ui.dp(6));
            c3.addView(t);
        }
        for (int i = 0; i < data.friends.size(); i++) {
            final Api.Friend f = data.friends.get(i);
            LinearLayout row = Ui.row(act);
            row.setPadding(0, Ui.dp(9), 0, Ui.dp(9));
            row.setClickable(true);
            final android.widget.FrameLayout av = Ui.avatar(act, first(f.nickname), f.avatarColor, 36);
            row.addView(av);
            row.addView(Ui.gapW(act, 9));
            LinearLayout left = Ui.col(act);
            left.addView(Ui.text(act, f.nickname, 14.5f, Ui.fg));
            left.addView(Ui.text(act, "@" + f.username, 11.5f, Ui.fg3));
            row.addView(left, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(Ui.miniBtn(act, "私聊"));
            final String uid = f.id;
            final String nm = f.nickname;
            row.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { act.openDm(uid, nm); }
            });
            loadAvatar(av, f.avatar);
            c3.addView(row);
            if (i < data.friends.size() - 1) c3.addView(Ui.hline(act));
        }
        box.addView(c3);

        /* ---- 发出的申请 ---- */
        if (!data.outgoing.isEmpty()) {
            LinearLayout c4 = Ui.card(act);
            c4.setLayoutParams(Ui.cardLp());
            c4.addView(Ui.cardHead(act, "等待对方同意"));
            c4.addView(Ui.gap(act, 6));
            for (int i = 0; i < data.outgoing.size(); i++) {
                Api.FriendReq r = data.outgoing.get(i);
                TextView t = Ui.text(act, r.nickname + "  @" + r.username, 13.5f, Ui.fg2);
                t.setPadding(0, Ui.dp(5), 0, Ui.dp(5));
                c4.addView(t);
            }
            box.addView(c4);
        }
    }

    private void handle(final Api.FriendReq r, final boolean accept) {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    if (accept) act.api().acceptFriend(r.id);
                    else act.api().rejectFriend(r.id);
                    act.ui(new Runnable() {
                        public void run() {
                            act.toast(accept ? "已添加好友" : "已拒绝");
                            load();
                        }
                    });
                } catch (final Api.ApiException e) {
                    act.ui(new Runnable() {
                        public void run() { act.toast(e.getMessage()); }
                    });
                }
            }
        });
    }

    private void loadAvatar(final android.widget.FrameLayout holder, String path) {
        if (path == null || path.length() == 0) return;
        act.avatars().load(path, new AvatarLoader.Callback() {
            public void onLoaded(String p, final android.graphics.Bitmap bmp) {
                if (bmp == null) return;
                android.widget.ImageView iv = new android.widget.ImageView(act);
                iv.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
                iv.setImageBitmap(bmp);
                holder.removeAllViews();
                holder.addView(iv, new android.widget.FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
        });
    }

    private static String first(String s) {
        if (s == null || s.length() == 0) return "?";
        return s.substring(0, 1);
    }
}
