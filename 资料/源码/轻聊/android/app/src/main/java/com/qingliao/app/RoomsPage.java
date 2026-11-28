package com.qingliao.app;

import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/** 房间页：我加入的房间 + 新建 + 搜索加入 + 成员面板。 */
public class RoomsPage extends Page {

    private List<Api.Room> rooms;

    public RoomsPage(MainActivity a) {
        super(a);
    }

    @Override
    public void load() {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    final List<Api.Room> list = act.api().rooms();
                    act.ui(new Runnable() {
                        public void run() {
                            rooms = list;
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

        LinearLayout actions = Ui.row(act);
        actions.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), 0);
        TextView create = Ui.button(act, "＋ 新建房间", true);
        create.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askCreate(); }
        });
        actions.addView(create);
        actions.addView(Ui.gapW(act, 8));
        TextView search = Ui.button(act, "搜索房间", false);
        search.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askSearch(); }
        });
        actions.addView(search);
        box.addView(actions);

        if (rooms == null || rooms.isEmpty()) {
            empty("还没有房间，点「新建房间」创建，或搜索加入别人的房间。");
            return;
        }

        LinearLayout c = Ui.card(act);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(act, "我的房间"));
        c.addView(Ui.gap(act, 6));
        for (int i = 0; i < rooms.size(); i++) {
            final Api.Room r = rooms.get(i);
            LinearLayout row = Ui.row(act);
            row.setPadding(0, Ui.dp(9), 0, Ui.dp(9));
            row.setClickable(true);

            LinearLayout left = Ui.col(act);
            LinearLayout nameRow = Ui.row(act);
            String label = "public".equals(r.kind) ? "公共聊天室" : r.name;
            TextView nm = Ui.text(act, label, 15, Ui.fg);
            nameRow.addView(nm);
            if (r.hasPassword) {
                nameRow.addView(Ui.gapW(act, 6));
                nameRow.addView(Ui.badgeGray(act, "有密码"));
            }
            if (r.memberCount > 0) {
                nameRow.addView(Ui.gapW(act, 6));
                nameRow.addView(Ui.badgeGray(act, r.memberCount + " 人"));
            }
            left.addView(nameRow);
            String sub;
            if ("public".equals(r.kind)) {
                sub = "全员开放 · 点开即可发言";
            } else if (r.roleName != null && r.roleName.length() > 0) {
                sub = "我的身份：" + r.roleName + (r.ownerName.length() > 0 ? " · 房主 " + r.ownerName : "");
            } else {
                sub = r.ownerName.length() > 0 ? "房主 " + r.ownerName : "群聊";
            }
            TextView s = Ui.text(act, sub, 12, Ui.fg3);
            s.setPadding(0, Ui.dp(2), 0, 0);
            left.addView(s);
            row.addView(left, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(Ui.text(act, "›", 18, Ui.fg3));

            row.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    act.openRoom(r.id, "public".equals(r.kind) ? "公共聊天室" : r.name);
                }
            });
            row.setOnLongClickListener(new View.OnLongClickListener() {
                public boolean onLongClick(View v) {
                    roomMenu(r);
                    return true;
                }
            });
            c.addView(row);
            if (i < rooms.size() - 1) c.addView(Ui.hline(act));
        }
        box.addView(c);

        TextView hint = Ui.text(act, "长按房间可查看成员、设置或离开", 11.5f, Ui.fg3);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, Ui.dp(12), 0, 0);
        box.addView(hint);
    }

    /* ---------------- 新建 ---------------- */

    private void askCreate() {
        final android.widget.EditText name = Ui.input(act, "房间名（最多 24 字）");
        final android.widget.EditText pass = Ui.input(act, "房间密码（可留空）");
        LinearLayout body = Ui.col(act);
        body.addView(name);
        body.addView(Ui.gap(act, 8));
        body.addView(pass);
        Dlg.base(act, "新建房间", body, "创建", new Dlg.OnOk() {
            public void run() {
                final String n = name.getText().toString().trim();
                final String p = pass.getText().toString().trim();
                if (n.length() == 0) { act.toast("房间名不能为空"); return; }
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            final Api.Room r = act.api().createRoom(n, p);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("房间已创建");
                                    load();
                                    act.openRoom(r.id, r.name);
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
        }, "取消");
    }

    /* ---------------- 搜索 ---------------- */

    private void askSearch() {
        Dlg.input(act, "搜索房间", "输入房间名关键词", "", new Dlg.OnText() {
            public void run(String q) {
                final String kw = q.trim();
                if (kw.length() == 0) return;
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            final List<Api.SearchRoom> list = act.api().searchRooms(kw);
                            act.ui(new Runnable() {
                                public void run() { showSearchResult(kw, list); }
                            });
                        } catch (final Api.ApiException e) {
                            act.ui(new Runnable() {
                                public void run() { act.toast(e.getMessage()); }
                            });
                        }
                    }
                });
            }
        }, "搜索");
    }

    private void showSearchResult(String kw, List<Api.SearchRoom> list) {
        LinearLayout body = Ui.col(act);
        if (list.isEmpty()) {
            body.addView(Ui.text(act, "没有找到「" + kw + "」相关的房间", 13.5f, Ui.fg2));
        }
        for (int i = 0; i < list.size(); i++) {
            final Api.SearchRoom s = list.get(i);
            LinearLayout row = Ui.row(act);
            row.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
            LinearLayout left = Ui.col(act);
            LinearLayout nr = Ui.row(act);
            nr.addView(Ui.text(act, s.name, 14.5f, Ui.fg));
            if (s.hasPassword) {
                nr.addView(Ui.gapW(act, 6));
                nr.addView(Ui.badgeGray(act, "有密码"));
            }
            left.addView(nr);
            left.addView(Ui.text(act, s.memberCount + " 人"
                    + (s.ownerName.length() > 0 ? " · 房主 " + s.ownerName : ""), 12, Ui.fg3));
            row.addView(left, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView go = Ui.miniBtn(act, s.joined ? "进入" : "加入");
            go.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    if (s.joined) {
                        act.openRoom(s.id, s.name);
                    } else if (s.hasPassword) {
                        askJoinWithPassword(s);
                    } else {
                        join(s.id, s.name, null);
                    }
                }
            });
            row.addView(go);
            body.addView(row);
            if (i < list.size() - 1) body.addView(Ui.hline(act));
        }
        Dlg.base(act, "搜索结果", body, "关闭", null, null);
    }

    private void askJoinWithPassword(final Api.SearchRoom s) {
        Dlg.input(act, "加入「" + s.name + "」", "请输入房间密码", "", new Dlg.OnText() {
            public void run(String pwd) {
                join(s.id, s.name, pwd);
            }
        }, "加入");
    }

    private void join(final String id, final String name, final String pwd) {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    if (pwd != null && pwd.length() > 0) act.api().verifyRoom(id, pwd);
                    act.api().joinRoom(id);
                    act.ui(new Runnable() {
                        public void run() {
                            act.toast("已加入");
                            load();
                            act.openRoom(id, name);
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

    /* ---------------- 房间菜单 / 成员 ---------------- */

    private void roomMenu(final Api.Room r) {
        LinearLayout body = Ui.col(act);
        TextView m1 = Ui.button(act, "成员面板", false);
        m1.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                members(r);
            }
        });
        body.addView(m1);
        body.addView(Ui.gap(act, 8));
        TextView m2 = Ui.button(act, "我在本房间的昵称", false);
        m2.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Dlg.input(act, "房间昵称", "留空则使用账号昵称", "", new Dlg.OnText() {
                    public void run(String s) {
                        final String nick = s.trim();
                        act.runBg(new Runnable() {
                            public void run() {
                                try {
                                    act.api().setRoomNickname(r.id, nick);
                                    act.ui(new Runnable() {
                                        public void run() { act.toast("已更新"); }
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
        });
        body.addView(m2);
        if (!"public".equals(r.kind)) {
            body.addView(Ui.gap(act, 8));
            TextView m3 = Ui.dangerBtn(act, "离开该房间");
            m3.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    leave(r);
                }
            });
            body.addView(m3);
        }
        Dlg.base(act, r.name, body, "关闭", null, null);
    }

    private void leave(final Api.Room r) {
        Dlg.confirm(act, "离开房间", "退出「" + r.name + "」后将不再接收该房间消息。", "离开",
                new Dlg.OnOk() {
                    public void run() {
                        act.runBg(new Runnable() {
                            public void run() {
                                try {
                                    act.api().leaveRoom(r.id);
                                    act.ui(new Runnable() {
                                        public void run() {
                                            act.toast("已离开");
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
    }

    private void members(final Api.Room r) {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    final Api.MemberPage p = act.api().members(r.id);
                    act.ui(new Runnable() {
                        public void run() { showMembers(r, p); }
                    });
                } catch (final Api.ApiException e) {
                    act.ui(new Runnable() {
                        public void run() { act.toast(e.getMessage()); }
                    });
                }
            }
        });
    }

    private void showMembers(final Api.Room room, final Api.MemberPage p) {
        LinearLayout body = Ui.col(act);
        for (int i = 0; i < p.members.size(); i++) {
            final Api.Member m = p.members.get(i);
            LinearLayout row = Ui.row(act);
            row.setPadding(0, Ui.dp(7), 0, Ui.dp(7));
            row.addView(Ui.avatar(act, m.initial, m.avatarColor, 32));
            body_gap(act, row);
            LinearLayout left = Ui.col(act);
            LinearLayout nr = Ui.row(act);
            nr.addView(Ui.text(act, m.displayName, 14, Ui.fg));
            if (m.founder) {
                nr.addView(Ui.gapW(act, 5));
                nr.addView(Ui.badge(act, "站长"));
            }
            left.addView(nr);
            left.addView(Ui.text(act, m.roleName.length() > 0 ? m.roleName : "成员", 11.5f, Ui.fg3));
            row.addView(left, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            if (p.canManage && !m.userId.equals(act.api().user.id)) {
                TextView op = Ui.miniBtnGray(act, "管理");
                op.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) { memberActions(room, m); }
                });
                row.addView(op);
            }
            body.addView(row);
            if (i < p.members.size() - 1) body.addView(Ui.hline(act));
        }
        if (p.members.isEmpty()) body.addView(Ui.text(act, "还没有成员", 13, Ui.fg3));
        Dlg.base(act, "成员（" + p.members.size() + "）", body, "关闭", null, null);
    }

    private void body_gap(MainActivity a, LinearLayout row) {
        View v = new View(a);
        row.addView(v, new LinearLayout.LayoutParams(Ui.dp(9), 1));
    }

    private void memberActions(final Api.Room room, final Api.Member m) {
        LinearLayout body = Ui.col(act);
        TextView mute = Ui.button(act, "禁言 10 分钟", false);
        mute.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().setMute(room.id, m.userId, 10);
                            act.ui(new Runnable() {
                                public void run() { act.toast("已禁言 10 分钟"); }
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
        body.addView(mute);
        body.addView(Ui.gap(act, 8));
        TextView kick = Ui.dangerBtn(act, "移出房间");
        kick.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().kickMember(room.id, m.userId);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("已移出");
                                    members(room);
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
        body.addView(kick);
        Dlg.base(act, m.displayName, body, "取消", null, null);
    }
}
