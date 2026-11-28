package com.qingliao.app;

import android.content.Intent;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** 我的：账号信息、皮肤、设置、昵称头像、权限、关于、退出与注销。 */
public class MePage extends Page {

    private JSONObject version;

    public MePage(MainActivity a) {
        super(a);
    }

    @Override
    public void load() {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    act.api().me();
                } catch (Exception ignored) {
                }
                JSONObject v = null;
                try {
                    v = act.api().version();
                } catch (Exception ignored) {
                }
                final JSONObject vv = v;
                act.ui(new Runnable() {
                    public void run() {
                        version = vv;
                        render();
                    }
                });
            }
        });
    }

    private void render() {
        clear();
        Api.User u = act.api().user;

        /* ---- 账号卡 ---- */
        LinearLayout c = Ui.card(act);
        c.setLayoutParams(Ui.cardLp());
        LinearLayout r = Ui.row(act);
        final android.widget.FrameLayout av = Ui.avatar(act, first(u.nickname, u.username),
                u.avatarColor, 46);
        r.addView(av);
        r.addView(Ui.gapW(act, 12));
        LinearLayout left = Ui.col(act);
        LinearLayout nameRow = Ui.row(act);
        nameRow.addView(Ui.bold(act, u.nickname.length() > 0 ? u.nickname : u.username, 16.5f, Ui.fg));
        if (u.founder) {
            nameRow.addView(Ui.gapW(act, 6));
            nameRow.addView(Ui.badge(act, "站长"));
        } else if (u.master) {
            nameRow.addView(Ui.gapW(act, 6));
            nameRow.addView(Ui.badge(act, "最高权限"));
        }
        left.addView(nameRow);
        left.addView(Ui.text(act, "@" + u.username, 12, Ui.fg3));
        r.addView(left, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView edit = Ui.miniBtnGray(act, "换头像");
        edit.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { act.pickAvatar(); }
        });
        r.addView(edit);
        c.addView(r);
        loadAvatar(av, u.avatar);
        box.addView(c);

        /* ---- 功能入口 ---- */
        LinearLayout c2 = Ui.card(act);
        c2.setLayoutParams(Ui.cardLp());
        c2.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        entry(c2, "皮肤中心", "当前 " + Ui.skinName, new Runnable() {
            public void run() {
                act.startActivity(new Intent(act, SkinActivity.class));
            }
        }, true);
        c2.addView(Ui.hline(act));
        entry(c2, "设置", "外观 · 特效 · 存储 · 下载", new Runnable() {
            public void run() {
                act.startActivity(new Intent(act, SettingsActivity.class));
            }
        }, true);
        c2.addView(Ui.hline(act));
        entry(c2, "修改昵称", "账号名不可改", new Runnable() {
            public void run() { askNickname(); }
        }, true);
        c2.addView(Ui.hline(act));
        entry(c2, "最高权限", act.api().user.master || act.api().user.founder
                ? "已激活" : "输入密钥激活", new Runnable() {
            public void run() { askPerm(); }
        }, true);
        c2.addView(Ui.hline(act));
        entry(c2, "关于轻聊", "版本 " + versionName(), new Runnable() {
            public void run() { showAbout(); }
        }, false);
        box.addView(c2);

        /* ---- 退出 / 注销 ---- */
        LinearLayout c3 = Ui.card(act);
        c3.setLayoutParams(Ui.cardLp());
        TextView out = Ui.button(act, "退出登录", false);
        out.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { doLogout(); }
        });
        c3.addView(out);
        c3.addView(Ui.gap(act, 8));
        TextView del = Ui.dangerBtn(act, "注销账号（不可恢复）");
        del.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { doDelete(); }
        });
        c3.addView(del);
        box.addView(c3);

        TextView foot = Ui.text(act, "轻聊 · 原生客户端 · 不加载网页", 11.5f, Ui.fg3);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, Ui.dp(14), 0, 0);
        box.addView(foot);
    }

    private void entry(LinearLayout parent, String title, String sub, final Runnable onClick,
                       boolean arrow) {
        LinearLayout row = Ui.row(act);
        row.setPadding(Ui.dp(11), Ui.dp(11), Ui.dp(11), Ui.dp(11));
        row.setClickable(true);
        LinearLayout left = Ui.col(act);
        left.addView(Ui.text(act, title, 14.5f, Ui.fg));
        left.addView(Ui.text(act, sub, 11.5f, Ui.fg3));
        row.addView(left, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (arrow) row.addView(Ui.text(act, "›", 17, Ui.fg3));
        row.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { onClick.run(); }
        });
        parent.addView(row);
    }

    /* ---------------- 资料 ---------------- */

    private void askNickname() {
        Dlg.input(act, "修改昵称", "新昵称", act.api().user.nickname, new Dlg.OnText() {
            public void run(String s) {
                final String nick = s.trim();
                if (nick.length() == 0) { act.toast("昵称不能为空"); return; }
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().setNickname(nick);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("昵称已更新");
                                    act.store().updateNick(act.api().user.username, nick);
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
        }, "保存");
    }

    public void onAvatarPicked(final android.net.Uri uri) {
        final Dlg.Busy b = Dlg.progress(act, "上传头像…");
        act.runBg(new Runnable() {
            public void run() {
                try {
                    java.io.File f = FileUtil.copyToCache(act, uri, "avatar.jpg");
                    act.api().setAvatar(f, null);
                    try { f.delete(); } catch (Exception ignored) { }
                    act.ui(new Runnable() {
                        public void run() {
                            b.dismiss();
                            act.avatars().clear();
                            act.toast("头像已更新");
                            load();
                        }
                    });
                } catch (final Exception e) {
                    act.ui(new Runnable() {
                        public void run() {
                            b.dismiss();
                            act.toast(e.getMessage() == null ? "上传失败" : e.getMessage());
                        }
                    });
                }
            }
        });
    }

    private void askPerm() {
        Dlg.input(act, "最高权限", "输入权限密钥", "", new Dlg.OnText() {
            public void run(String key) {
                final String k = key.trim();
                if (k.length() == 0) return;
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().activatePerm(k);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("已激活最高权限");
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
        }, "激活");
    }

    private String versionName() {
        String local = apkVersion();
        if (local != null && local.length() > 0 && !"—".equals(local)) return local;
        if (version == null) return "3.0.0";
        JSONObject v = version.optJSONObject("version");
        if (v != null) return v.optString("name", v.optString("version", "—"));
        return version.optString("version", "—");
    }

    /** APK 自身的版本名（不依赖服务器，避免「客户端 3.0 显示 2.9」的错位） */
    private String apkVersion() {
        try {
            return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "—";
        }
    }


    private void showAbout() {
        LinearLayout body = Ui.col(act);
        body.addView(Ui.bold(act, "轻聊 " + versionName(), 15, Ui.fg));
        body.addView(Ui.text(act, "原生客户端 · Android 5.0.2+", 11.5f, Ui.fg3));
        body.addView(Ui.gap(act, 8));
        JSONObject v = version == null ? null : version.optJSONObject("version");
        if (v == null && version != null) v = version;
        JSONArray notes = v == null ? null : v.optJSONArray("notes");
        if (notes != null) {
            for (int i = 0; i < notes.length() && i < 8; i++) {
                TextView t = Ui.text(act, "· " + notes.optString(i, ""), 12.5f, Ui.fg2);
                t.setPadding(0, Ui.dp(3), 0, Ui.dp(3));
                body.addView(t);
            }
        }
        String contact = v == null ? "" : v.optString("contact", "");
        if (contact.length() > 0) {
            body.addView(Ui.gap(act, 8));
            body.addView(Ui.text(act, "联系：" + contact, 12, Ui.fg3));
        }
        Dlg.base(act, "关于", body, "关闭", null, null);
    }

    /* ---------------- 账号操作 ---------------- */

    private void doLogout() {
        Dlg.confirm(act, "退出登录", "退出后需要重新输入密码登录，本机记住的密码不会被清除。", "退出",
                new Dlg.OnOk() {
                    public void run() {
                        act.runBg(new Runnable() {
                            public void run() {
                                act.api().logout();
                                act.store().setToken("");
                                act.ui(new Runnable() {
                                    public void run() {
                                        act.startActivity(new Intent(act, LoginActivity.class));
                                        act.finish();
                                    }
                                });
                            }
                        });
                    }
                });
    }

    private void doDelete() {
        Dlg.confirm(act, "注销账号", "注销后账号、房间成员关系、消息与网盘文件都会清除，无法恢复。", "确认注销",
                new Dlg.OnOk() {
                    public void run() {
                        Dlg.input(act, "确认注销", "输入登录密码", "", new Dlg.OnText() {
                            public void run(String pass) {
                                final String p = pass;
                                act.runBg(new Runnable() {
                                    public void run() {
                                        try {
                                            act.api().deleteAccount();
                                            act.store().setToken("");
                                            act.store().setAutoUser("");
                                            act.ui(new Runnable() {
                                                public void run() {
                                                    act.toast("账号已注销");
                                                    act.startActivity(new Intent(act, LoginActivity.class));
                                                    act.finish();
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
                        }, "注销");
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

    private static String first(String a, String b) {
        String s = (a != null && a.length() > 0) ? a : b;
        if (s == null || s.length() == 0) return "?";
        return s.substring(0, 1);
    }
}
