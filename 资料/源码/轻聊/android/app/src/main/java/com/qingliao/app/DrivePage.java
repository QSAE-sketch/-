package com.qingliao.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.net.Uri;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * 网盘页：存储空间、我的文件 / 回收站 / 我的分享、类型与目录筛选、上传、新建目录、
 * 移动、重命名、分享复用与随时下线。
 */
public class DrivePage extends Page {

    private static final String[] TYPES = {"", "image", "video", "audio", "doc", "archive", "other"};
    private static final String[] TYPE_NAMES = {"全部", "图片", "视频", "音频", "文档", "压缩包", "其他"};

    private int mode = 0;                 // 0 我的文件 / 1 回收站 / 2 我的分享
    private String type = "";
    private String folder = null;         // null = 全部目录；"" = 根目录
    private String keyword = "";

    private Api.DriveStorage storage;
    private Api.DriveList list;
    private Api.DriveList trash;
    private List<Api.ShareInfo> shares;

    private EditText searchBox;           // 重建时保留输入

    public DrivePage(MainActivity a) {
        super(a);
    }

    @Override
    public void load() {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    final Api.DriveStorage st = act.api().driveStorage();
                    storage = st;
                    if (mode == 0) {
                        final Api.DriveList l = act.api().driveFiles(keyword, type, folder);
                        act.ui(new Runnable() {
                            public void run() {
                                list = l;
                                render();
                            }
                        });
                    } else if (mode == 1) {
                        final Api.DriveList l = act.api().driveTrash();
                        act.ui(new Runnable() {
                            public void run() {
                                trash = l;
                                render();
                            }
                        });
                    } else {
                        final List<Api.ShareInfo> s = act.api().driveShares();
                        act.ui(new Runnable() {
                            public void run() {
                                shares = s;
                                render();
                            }
                        });
                    }
                } catch (final Api.ApiException e) {
                    act.ui(new Runnable() {
                        public void run() { showError(e.getMessage()); }
                    });
                }
            }
        });
    }

    /* ================================================================ */
    /* 渲染                                                              */
    /* ================================================================ */

    private void render() {
        clear();
        renderStorage();
        renderSegments();
        if (mode == 0) {
            renderToolbar();
        }
        renderCount();
        if (mode == 0) renderFiles();
        else if (mode == 1) renderTrash();
        else renderShares();
    }

    private void renderStorage() {
        LinearLayout c = Ui.card(act);
        c.setLayoutParams(Ui.cardLp());
        c.addView(Ui.cardHead(act, "存储空间"));
        c.addView(Ui.gap(act, 9));
        LinearLayout r = Ui.row(act);
        String used = storage == null ? "—" : storage.usedText;
        String quota = storage == null ? "—" : storage.quotaText;
        TextView big = Ui.bold(act, used + " / " + quota, 15, Ui.fg);
        r.addView(big);
        r.addView(Ui.spacer(act));
        r.addView(Ui.text(act, "剩余 " + (storage == null ? "—" : storage.remainText), 12.5f, Ui.fg2));
        c.addView(r);
        c.addView(Ui.gap(act, 8));
        c.addView(Ui.bar(act, storage == null ? 0 : storage.percent));
        c.addView(Ui.gap(act, 8));
        c.addView(Ui.text(act, "每人 " + (storage == null ? "2 GB" : storage.quotaText)
                + " 总额度，聊天与网盘共用；回收站内的文件在清除前仍占用额度。", 11.5f, Ui.fg3));
        box.addView(c);
    }

    private void renderSegments() {
        LinearLayout wrap = Ui.row(act);
        wrap.setBackgroundDrawable(Ui.rect(Ui.surface2, 4, Ui.border, 1));
        wrap.setPadding(Ui.dp(3), Ui.dp(3), Ui.dp(3), Ui.dp(3));
        String[] names = {"我的文件", "回收站", "我的分享"};
        for (int i = 0; i < names.length; i++) {
            final int idx = i;
            boolean on = i == mode;
            TextView t = Ui.text(act, names[i], 13.5f, on ? Ui.onAccent : Ui.fg2);
            if (on) t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
            t.setBackgroundDrawable(on ? Ui.rect(Ui.accent, 3, 0, 0) : null);
            t.setClickable(true);
            t.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    if (mode == idx) return;
                    mode = idx;
                    load();
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i > 0) lp.leftMargin = Ui.dp(3);
            wrap.addView(t, lp);
        }
        LinearLayout holder = Ui.col(act);
        holder.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), 0);
        holder.addView(wrap);
        box.addView(holder);
    }

    private void renderToolbar() {
        LinearLayout holder = Ui.col(act);
        holder.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), 0);

        LinearLayout sr = Ui.row(act);
        searchBox = Ui.input(act, "搜索文件名…");
        searchBox.setText(keyword);
        searchBox.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            public boolean onEditorAction(TextView v, int actionId, android.view.KeyEvent event) {
                keyword = v.getText().toString().trim();
                load();
                return true;
            }
        });
        sr.addView(searchBox, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        sr.addView(Ui.gapW(act, 8));
        TextView up = Ui.button(act, "上传", true);
        up.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { act.pickFileForDrive(); }
        });
        sr.addView(up);
        holder.addView(sr);
        holder.addView(Ui.gap(act, 9));

        // 类型
        holder.addView(chipScroll(TYPES.length, new ChipName() {
            public String name(int i) { return TYPE_NAMES[i]; }
            public boolean on(int i) { return TYPES[i].equals(type); }
            public void click(int i) {
                type = TYPES[i];
                load();
            }
        }));

        holder.addView(Ui.gap(act, 7));

        // 目录
        final List<String> folders = new ArrayList<String>();
        if (list != null) folders.addAll(list.folders);
        int extra = 2; // 全部目录 + 根目录
        holder.addView(chipScroll(folders.size() + extra, new ChipName() {
            public String name(int i) {
                if (i == 0) return "全部目录";
                if (i == 1) return "根目录";
                return folders.get(i - 2);
            }
            public boolean on(int i) {
                if (i == 0) return folder == null;
                if (i == 1) return "".equals(folder);
                return folder != null && folder.equals(folders.get(i - 2));
            }
            public void click(int i) {
                if (i == 0) folder = null;
                else if (i == 1) folder = "";
                else folder = folders.get(i - 2);
                load();
            }
        }));

        holder.addView(Ui.gap(act, 7));

        LinearLayout ops = Ui.row(act);
        TextView nf = Ui.miniBtn(act, "＋ 新建目录");
        nf.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askNewFolder(); }
        });
        ops.addView(nf);
        if (folder != null && folder.length() > 0) {
            ops.addView(Ui.gapW(act, 8));
            TextView df = Ui.dangerBtn(act, "删除当前目录");
            df.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { askDeleteFolder(); }
            });
            ops.addView(df);
        }
        holder.addView(ops);
        box.addView(holder);
    }

    private interface ChipName {
        String name(int i);
        boolean on(int i);
        void click(int i);
    }

    private View chipScroll(int count, ChipName spec) {
        Ui.FlowRow flow = new Ui.FlowRow(act);
        for (int i = 0; i < count; i++) {
            final int idx = i;
            TextView chip = Ui.chip(act, spec.name(i), spec.on(i));
            chip.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { spec.click(idx); }
            });
            flow.addView(chip);
        }
        return flow;
    }

    private void renderCount() {
        int n;
        String tail = " · 按时间";
        if (mode == 0) n = list == null ? 0 : list.total;
        else if (mode == 1) n = trash == null ? 0 : trash.total;
        else n = shares == null ? 0 : shares.size();
        String label;
        if (mode == 0) label = "共 " + n + " 个文件" + tail;
        else if (mode == 1) label = "回收站 " + n + " 个文件";
        else label = "共 " + n + " 条分享";
        TextView t = Ui.text(act, label, 12, Ui.fg3);
        t.setPadding(Ui.dp(14), Ui.dp(12), Ui.dp(14), Ui.dp(6));
        box.addView(t);
    }

    private void renderFiles() {
        if (list == null || list.items.isEmpty()) {
            empty("还没有文件。点右上「上传」，或在聊天里发一个文件——它也会出现在这里。");
            return;
        }
        LinearLayout c = Ui.card(act);
        c.setLayoutParams(Ui.cardLp());
        c.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        for (int i = 0; i < list.items.size(); i++) {
            final Api.DriveFile f = list.items.get(i);
            c.addView(fileRow(f, false));
            if (i < list.items.size() - 1) c.addView(Ui.hline(act));
        }
        box.addView(c);
    }

    private void renderTrash() {
        if (trash == null || trash.items.isEmpty()) {
            empty("回收站是空的。删掉的文件会在这里保留 30 天，期间可以随时恢复。");
            return;
        }
        LinearLayout c = Ui.card(act);
        c.setLayoutParams(Ui.cardLp());
        c.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        for (int i = 0; i < trash.items.size(); i++) {
            final Api.DriveFile f = trash.items.get(i);
            c.addView(fileRow(f, true));
            if (i < trash.items.size() - 1) c.addView(Ui.hline(act));
        }
        box.addView(c);
    }

    private void renderShares() {
        if (shares == null || shares.isEmpty()) {
            empty("还没有分享过东西。在「我的文件」里点任意文件，就能创建分享链接。");
            return;
        }
        LinearLayout c = Ui.card(act);
        c.setLayoutParams(Ui.cardLp());
        c.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4));
        for (int i = 0; i < shares.size(); i++) {
            final Api.ShareInfo s = shares.get(i);
            LinearLayout row = Ui.row(act);
            row.setPadding(Ui.dp(10), Ui.dp(10), Ui.dp(10), Ui.dp(10));
            LinearLayout left = Ui.col(act);
            left.addView(Ui.text(act, s.fileName.length() > 0 ? s.fileName : "（文件已删除）", 14.5f, Ui.fg));
            String sub = (s.fileSizeText.length() > 0 ? s.fileSizeText + " · " : "")
                    + (s.expired ? "已过期" : "有效至 " + date(s.expireAt))
                    + " · 下载 " + s.downloads + " 次";
            left.addView(Ui.text(act, sub, 11.5f, s.expired ? Ui.danger : Ui.fg3));
            if (s.encrypted) {
                TextView code = Ui.text(act, "提取码 " + s.code, 11.5f, Ui.fg2);
                code.setPadding(0, Ui.dp(2), 0, 0);
                left.addView(code);
            }
            row.addView(left, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            if (!s.expired && !s.revoked) {
                TextView copy = Ui.miniBtn(act, "复制");
                copy.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) { copyShare(s); }
                });
                row.addView(copy);
                row.addView(Ui.gapW(act, 6));
                TextView off = Ui.dangerBtn(act, "下线");
                off.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) { revoke(s); }
                });
                row.addView(off);
            } else {
                TextView st = Ui.badgeGray(act, s.revoked ? "已下线" : "已过期");
                row.addView(st);
            }
            c.addView(row);
            if (i < shares.size() - 1) c.addView(Ui.hline(act));
        }
        box.addView(c);
    }

    private View fileRow(final Api.DriveFile f, final boolean inTrash) {
        LinearLayout row = Ui.row(act);
        row.setPadding(Ui.dp(10), Ui.dp(10), Ui.dp(10), Ui.dp(10));
        row.setClickable(true);
        row.addView(typeIcon(f));
        row.addView(Ui.gapW(act, 10));
        LinearLayout left = Ui.col(act);
        left.addView(Ui.text(act, f.name, 14.5f, Ui.fg));
        StringBuilder sub = new StringBuilder();
        sub.append(f.sizeText);
        if (inTrash) {
            sub.append(" · 还剩 ").append(f.remainDays).append(" 天");
        } else {
            if (f.folder.length() > 0) sub.append(" · ").append(f.folder);
            if (f.roomName.length() > 0) sub.append(" · ").append(f.roomName);
        }
        left.addView(Ui.text(act, sub.toString(), 11.5f, Ui.fg3));
        row.addView(left, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (!inTrash && f.share != null && !f.share.expired) {
            row.addView(Ui.badge(act, "已分享"));
        }
        row.addView(Ui.text(act, "›", 17, Ui.fg3));

        row.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (inTrash) trashActions(f);
                else fileActions(f);
            }
        });
        return row;
    }

    private View typeIcon(Api.DriveFile f) {
        String label;
        int color;
        if ("image".equals(f.type)) { label = "图"; color = 0xFF3B7DD8; }
        else if ("video".equals(f.type)) { label = "视"; color = 0xFF7A5AD8; }
        else if ("audio".equals(f.type)) { label = "音"; color = 0xFF2F8F83; }
        else if ("doc".equals(f.type)) { label = "文"; color = 0xFF4A6FA5; }
        else if ("archive".equals(f.type)) { label = "压"; color = 0xFF9A6B3F; }
        else { label = "件"; color = 0xFF5B6B82; }
        TextView t = Ui.text(act, label, 13, 0xFFFFFFFF);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        t.setBackgroundDrawable(Ui.rect(color, 4, 0, 0));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(Ui.dp(38), Ui.dp(38));
        t.setLayoutParams(lp);
        return t;
    }

    private String date(long ms) {
        if (ms <= 0) return "长期有效";
        return new SimpleDateFormat("yyyy-MM-dd").format(new Date(ms));
    }

    /* ================================================================ */
    /* 文件操作                                                          */
    /* ================================================================ */

    private void fileActions(final Api.DriveFile f) {
        LinearLayout body = Ui.col(act);
        TextView dl = Ui.button(act, "下载", true);
        dl.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Downloads.save(act, act.api(), act.prefs(), f.downloadUrl, f.name);
            }
        });
        body.addView(dl);

        body.addView(Ui.gap(act, 8));
        TextView sh = Ui.button(act, (f.share != null && !f.share.expired) ? "查看分享链接" : "分享",
                false);
        sh.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { doShare(f); }
        });
        body.addView(sh);

        body.addView(Ui.gap(act, 8));
        LinearLayout two = Ui.row(act);
        TextView mv = Ui.button(act, "移动", false);
        mv.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askMove(f); }
        });
        two.addView(mv, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        two.addView(Ui.gapW(act, 8));
        TextView rn = Ui.button(act, "重命名", false);
        rn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askRename(f); }
        });
        two.addView(rn, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        body.addView(two);

        body.addView(Ui.gap(act, 8));
        TextView del = Ui.dangerBtn(act, "放入回收站");
        del.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().trashFile(f.fileId);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("已放入回收站（保留 30 天）");
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
        body.addView(del);
        Dlg.base(act, f.name, body, "关闭", null, null);
    }

    private void trashActions(final Api.DriveFile f) {
        LinearLayout body = Ui.col(act);
        TextView rs = Ui.button(act, "恢复", true);
        rs.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().restoreFile(f.fileId);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("已恢复");
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
        body.addView(rs);
        body.addView(Ui.gap(act, 8));
        TextView pg = Ui.dangerBtn(act, "彻底删除（不可恢复）");
        pg.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Dlg.confirm(act, "彻底删除", "删除后文件与分享链接都会永久消失，无法恢复。", "删除",
                        new Dlg.OnOk() {
                            public void run() {
                                act.runBg(new Runnable() {
                                    public void run() {
                                        try {
                                            act.api().purgeFile(f.fileId);
                                            act.ui(new Runnable() {
                                                public void run() {
                                                    act.toast("已彻底删除");
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
        });
        body.addView(pg);
        Dlg.base(act, f.name, body, "关闭", null, null);
    }

    private void askMove(final Api.DriveFile f) {
        LinearLayout body = Ui.col(act);
        List<String> folders = list == null ? new ArrayList<String>() : list.folders;
        TextView root = Ui.button(act, "根目录", false);
        root.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { move(f, ""); }
        });
        body.addView(root);
        for (int i = 0; i < folders.size(); i++) {
            final String name = folders.get(i);
            body.addView(Ui.gap(act, 7));
            TextView b = Ui.button(act, "目录 · " + name, false);
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { move(f, name); }
            });
            body.addView(b);
        }
        body.addView(Ui.gap(act, 9));
        TextView nf = Ui.miniBtn(act, "＋ 新建目录并移入");
        nf.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Dlg.input(act, "新建目录", "目录名", "", new Dlg.OnText() {
                    public void run(String s) {
                        final String name = s.trim();
                        if (name.length() == 0) return;
                        act.runBg(new Runnable() {
                            public void run() {
                                try {
                                    act.api().createFolder(name);
                                    act.api().patchDriveFile(f.fileId, null, name);
                                    act.ui(new Runnable() {
                                        public void run() {
                                            act.toast("已移入「" + name + "」");
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
                }, "创建");
            }
        });
        body.addView(nf);
        Dlg.base(act, "移动到…", body, "取消", null, null);
    }

    private void move(final Api.DriveFile f, final String folderName) {
        act.runBg(new Runnable() {
            public void run() {
                try {
                    act.api().patchDriveFile(f.fileId, null, folderName);
                    act.ui(new Runnable() {
                        public void run() {
                            act.toast(folderName.length() == 0 ? "已移到根目录" : "已移入「" + folderName + "」");
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

    private void askRename(final Api.DriveFile f) {
        Dlg.input(act, "重命名", "新文件名", f.name, new Dlg.OnText() {
            public void run(String s) {
                final String name = s.trim();
                if (name.length() == 0) return;
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().patchDriveFile(f.fileId, name, null);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("已重命名");
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

    /* ================================================================ */
    /* 分享                                                              */
    /* ================================================================ */

    private void doShare(final Api.DriveFile f) {
        if (f.share != null && !f.share.expired) {
            showShare(f.share);
            return;
        }
        LinearLayout body = Ui.col(act);
        body.addView(Ui.text(act, "有效期（天）", 12.5f, Ui.fg2));
        final EditText days = Ui.input(act, "7");
        days.setText("7");
        body.addView(days);
        body.addView(Ui.gap(act, 9));
        final CheckBox enc = new CheckBox(act);
        enc.setText("需要提取码");
        enc.setTextColor(Ui.fg2);
        enc.setTextSize(13.5f);
        Ui.tintCheck(enc);
        body.addView(enc);
        final EditText code = Ui.input(act, "提取码（留空自动生成）");
        body.addView(code);
        Dlg.base(act, "创建分享", body, "创建", new Dlg.OnOk() {
            public void run() {
                int d = 7;
                try { d = Integer.parseInt(days.getText().toString().trim()); } catch (Exception ignored) { }
                if (d <= 0) d = 7;
                if (d > 365) d = 365;
                final int dd = d;
                final boolean en = enc.isChecked();
                final String c = code.getText().toString().trim();
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            final Api.ShareInfo s = act.api().shareFile(f.fileId, dd, en, c);
                            act.ui(new Runnable() {
                                public void run() {
                                    showShare(s);
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
        }, "取消");
    }

    /** 文件列表里的 share 对象没有 url 字段（只有 shareId），这里统一补出来 */
    private String shareUrl(Api.ShareInfo s) {
        String path = (s.url != null && s.url.length() > 0) ? s.url : ("/s/" + s.shareId);
        return act.api().base() + path;
    }

    private void showShare(final Api.ShareInfo s) {
        final String url = shareUrl(s);
        String text = url + (s.encrypted ? ("\n提取码：" + s.code) : "");
        LinearLayout body = Ui.col(act);
        body.addView(Ui.text(act, text, 13, Ui.fg));
        body.addView(Ui.gap(act, 8));
        String line = (s.encrypted ? "提取码 " + s.code : "公开链接")
                + " · 有效至 " + date(s.expireAt) + " · 下载 " + s.downloads + " 次";
        body.addView(Ui.text(act, line, 11.5f, Ui.fg3));
        body.addView(Ui.gap(act, 12));
        LinearLayout btns = Ui.row(act);
        TextView copy = Ui.button(act, "复制链接", true);
        copy.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                copyText(url + (s.encrypted ? ("\n提取码：" + s.code) : ""));
            }
        });
        btns.addView(copy, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        btns.addView(Ui.gapW(act, 8));
        TextView off = Ui.dangerBtn(act, "下线");
        off.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { revoke(s); }
        });
        btns.addView(off);
        body.addView(btns);
        Dlg.base(act, "分享链接", body, "关闭", null, null);
    }

    private void copyShare(Api.ShareInfo s) {
        String url = shareUrl(s);
        copyText(url + (s.encrypted ? ("\n提取码：" + s.code) : ""));
    }

    private void copyText(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("轻聊分享", text));
            act.toast("已复制");
        } catch (Exception e) {
            act.toast("复制失败");
        }
    }

    private void revoke(final Api.ShareInfo s) {
        Dlg.confirm(act, "下线分享", "下线后这个链接立刻失效，别人打不开了（文件本身还在网盘里）。", "下线",
                new Dlg.OnOk() {
                    public void run() {
                        act.runBg(new Runnable() {
                            public void run() {
                                try {
                                    act.api().revokeShare(s.shareId);
                                    act.ui(new Runnable() {
                                        public void run() {
                                            act.toast("已下线");
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

    /* ================================================================ */
    /* 目录                                                              */
    /* ================================================================ */

    private void askNewFolder() {
        Dlg.input(act, "新建目录", "目录名（最多 80 字）", "", new Dlg.OnText() {
            public void run(String s) {
                final String name = s.trim();
                if (name.length() == 0) { act.toast("目录名不能为空"); return; }
                act.runBg(new Runnable() {
                    public void run() {
                        try {
                            act.api().createFolder(name);
                            act.ui(new Runnable() {
                                public void run() {
                                    act.toast("目录已创建");
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
        }, "创建");
    }

    private void askDeleteFolder() {
        final String name = folder;
        if (name == null || name.length() == 0) return;
        Dlg.confirm(act, "删除目录", "只能删除空目录；如果里面还有文件，请先移走。", "删除",
                new Dlg.OnOk() {
                    public void run() {
                        act.runBg(new Runnable() {
                            public void run() {
                                try {
                                    act.api().deleteFolder(name);
                                    act.ui(new Runnable() {
                                        public void run() {
                                            act.toast("目录已删除");
                                            folder = null;
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

    /* ================================================================ */
    /* 选文件上传                                                        */
    /* ================================================================ */

    public void onPickedFile(final Uri uri, final String name) {
        final Dlg.Busy b = Dlg.progress(act, "准备上传…");
        act.runBg(new Runnable() {
            public void run() {
                try {
                    File tmp = FileUtil.copyToCache(act, uri, name);
                    final String folderTarget = (folder != null && folder.length() > 0) ? folder : "";
                    act.api().uploadDrive(tmp, folderTarget, new Api.Progress() {
                        public void onProgress(final long done, final long total) {
                            final int pct = total <= 0 ? 0 : (int) (done * 100 / total);
                            act.ui(new Runnable() {
                                public void run() { b.set("上传中… " + pct + "%"); }
                            });
                        }
                    });
                    try { tmp.delete(); } catch (Exception ignored) { }
                    act.ui(new Runnable() {
                        public void run() {
                            b.dismiss();
                            act.toast("上传完成");
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
}
