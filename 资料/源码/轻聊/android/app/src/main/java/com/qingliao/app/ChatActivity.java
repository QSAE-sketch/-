package com.qingliao.app;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * 聊天页（房间 / 私聊共用）。
 *
 * 原生绘制消息流：自己发的靠右、别人的靠左，站长的消息带金色（可在设置里关掉流光）。
 * 每 2.5 秒增量拉一次（since=rev），只在新消息到来时重建列表。
 */
public class ChatActivity extends Activity {

    private static final int REQ_ATTACH = 8101;

    private Api api;
    private Prefs prefs;
    private AvatarLoader avatars;
    private AvatarLoader images;

    private String roomId = "";
    private String roomName = "聊天";

    private ScrollView scroll;
    private LinearLayout list;
    private EditText input;
    private TextView sendBtn;
    private TextView titleView;

    private final List<Api.Message> messages = new ArrayList<Api.Message>();
    private long lastSeq = 0;
    private boolean canPost = true;
    private boolean muted = false;
    private boolean dissolved = false;
    private boolean loading = false;
    private boolean paused = false;
    private boolean atBottom = true;

    private final Handler handler = new Handler();
    private final Runnable poll = new Runnable() {
        public void run() {
            if (paused) return;
            fetch(false);
            handler.postDelayed(this, 2500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        roomId = getIntent().getStringExtra("roomId");
        String nm = getIntent().getStringExtra("roomName");
        if (nm != null && nm.length() > 0) roomName = nm;

        Ui.init(this);
        prefs = new Prefs(this);
        prefs.applySkinColors();
        Ui.themeWindow(this);

        Store store = new Store(this);
        api = new Api(store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE);
        api.setToken(store.token());
        avatars = new AvatarLoader(api, 96);
        images = new AvatarLoader(api, 640, false);

        buildUi();
        fetch(true);
    }

    private void buildUi() {
        LinearLayout root = Ui.col(this);
        root.setBackgroundColor(Ui.bg);

        LinearLayout topWrap = Ui.col(this);
        topWrap.setBackgroundColor(Ui.topbar);
        LinearLayout top = Ui.row(this);
        top.setPadding(Ui.dp(6), 0, Ui.dp(12), 0);
        TextView back = Ui.iconBtn(this, "‹");
        back.setTextSize(26);
        back.setTextColor(Ui.topbarFg);
        back.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { finish(); }
        });
        top.addView(back);
        titleView = Ui.bold(this, roomName, 16.5f, Ui.topbarFg);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tlp.leftMargin = Ui.dp(2);
        top.addView(titleView, tlp);
        TextView mem = Ui.iconBtn(this, "成员");
        mem.setTextColor(Ui.topbarFg);
        mem.setTextSize(13);
        mem.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showMembers(); }
        });
        top.addView(mem);
        topWrap.addView(top, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(54)));
        View tl = new View(this);
        tl.setBackgroundColor(Ui.border);
        topWrap.addView(tl, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.7f))));
        root.addView(topWrap);

        scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipToPadding(false);
        scroll.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
        list = Ui.col(this);
        scroll.addView(list, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.setOnTouchListener(new View.OnTouchListener() {
            public boolean onTouch(View v, android.view.MotionEvent e) {
                return false;
            }
        });
        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 输入区
        LinearLayout inputWrap = Ui.col(this);
        inputWrap.setBackgroundColor(Ui.tabbar);
        View il = new View(this);
        il.setBackgroundColor(Ui.border);
        inputWrap.addView(il, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.7f))));
        LinearLayout inputRow = Ui.row(this);
        inputRow.setPadding(Ui.dp(10), Ui.dp(8), Ui.dp(10), Ui.dp(8));
        TextView attach = Ui.iconBtn(this, "＋");
        attach.setTextSize(22);
        attach.setTextColor(Ui.accent);
        attach.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { pickFile(); }
        });
        inputRow.addView(attach);
        input = Ui.input(this, "说点什么…");
        input.setSingleLine(false);
        input.setMaxLines(4);
        input.setMinLines(1);
        inputRow.addView(input, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        inputRow.addView(Ui.gapW(this, 8));
        sendBtn = Ui.button(this, "发送", true);
        sendBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { sendText(); }
        });
        inputRow.addView(sendBtn);
        inputWrap.addView(inputRow);
        root.addView(inputWrap);

        setContentView(root);
        // 进聊天页不主动弹键盘（想说话再点输入框），视觉上更接近微信
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN);
        input.clearFocus();
    }

    /* ---------------- 拉取 ---------------- */

    private void fetch(final boolean initial) {
        if (loading) return;
        loading = true;
        final long since = initial ? 0 : lastSeq;
        new Thread(new Runnable() {
            public void run() {
                try {
                    final Api.MessagePage p = api.messages(roomId, since, initial ? 80 : 60);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            loading = false;
                            applyPage(p, initial);
                        }
                    });
                } catch (final Api.ApiException e) {
                    loading = false;
                    if (initial) {
                        runOnUiThread(new Runnable() {
                            public void run() {
                                Ui.toast0(ChatActivity.this, e.getMessage());
                            }
                        });
                    }
                }
            }
        }).start();
    }

    private void applyPage(Api.MessagePage p, boolean initial) {
        canPost = p.canPost;
        muted = p.muted;
        dissolved = p.dissolved;
        if (initial) {
            messages.clear();
            messages.addAll(p.messages);
            lastSeq = p.lastSeq;
            renderAll();
            scrollToBottom();
            return;
        }
        boolean changed = false;
        if (p.purgedIds != null) {
            for (int i = messages.size() - 1; i >= 0; i--) {
                if (p.purgedIds.contains(messages.get(i).id)) {
                    messages.remove(i);
                    changed = true;
                }
            }
        }
        for (int i = 0; i < p.messages.size(); i++) {
            Api.Message m = p.messages.get(i);
            boolean exists = false;
            for (int j = 0; j < messages.size(); j++) {
                if (messages.get(j).id.equals(m.id)) {
                    messages.set(j, m);
                    exists = true;
                    changed = true;
                    break;
                }
            }
            if (!exists) {
                messages.add(m);
                changed = true;
            }
        }
        if (p.lastSeq > lastSeq) lastSeq = p.lastSeq;
        if (changed) {
            boolean wasBottom = isAtBottom();
            renderAll();
            if (wasBottom) scrollToBottom();
        }
    }

    private boolean isAtBottom() {
        View child = scroll.getChildAt(0);
        if (child == null) return true;
        return scroll.getScrollY() + scroll.getHeight() >= child.getHeight() - Ui.dp(60);
    }

    private void scrollToBottom() {
        handler.postDelayed(new Runnable() {
            public void run() {
                View child = scroll.getChildAt(0);
                if (child != null) scroll.smoothScrollTo(0, child.getHeight());
            }
        }, 60);
    }

    /* ---------------- 渲染 ---------------- */

    private void renderAll() {
        list.removeAllViews();
        // 只保留最近 120 条，避免长会话把内存顶爆
        int start = Math.max(0, messages.size() - 120);
        for (int i = start; i < messages.size(); i++) {
            Api.Message m = messages.get(i);
            if ("system".equals(m.kind)) {
                TextView sys = Ui.text(this, m.content, 11.5f, Ui.fg3);
                sys.setGravity(Gravity.CENTER);
                sys.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
                list.addView(sys);
                continue;
            }
            list.addView(bubbleRow(m));
        }
        if (dissolved) {
            TextView t = Ui.text(this, "该房间已解散，仅可查看历史消息", 12, Ui.danger);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(10), 0, Ui.dp(10));
            list.addView(t);
        } else if (!canPost) {
            TextView t = Ui.text(this, muted ? "你已被禁言，暂时不能发言" : "加入房间后即可发言",
                    12, Ui.fg3);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(10), 0, Ui.dp(10));
            list.addView(t);
        }
    }

    private View bubbleRow(final Api.Message m) {
        LinearLayout row = Ui.row(this);
        row.setPadding(Ui.dp(12), Ui.dp(5), Ui.dp(12), Ui.dp(5));
        row.setGravity(m.mine ? Gravity.RIGHT : Gravity.LEFT);

        if (!m.mine) {
            final FrameLayout av = Ui.avatar(this, first(m.senderName), null, 32);
            loadAvatar(av, m.senderAvatar);
            LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(Ui.dp(32), Ui.dp(32));
            alp.rightMargin = Ui.dp(8);
            row.addView(av, alp);
        }

        LinearLayout col = Ui.col(this);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        if (m.mine) clp.leftMargin = Ui.dp(40);
        else clp.rightMargin = Ui.dp(40);
        row.addView(col, clp);

        if (!m.mine) {
            LinearLayout nameRow = Ui.row(this);
            nameRow.setGravity(Gravity.LEFT);
            TextView nm = Ui.text(this, m.senderName, 11.5f, Ui.fg3);
            nameRow.addView(nm);
            if (m.senderFounder) {
                nameRow.addView(Ui.gapW(this, 5));
                nameRow.addView(Ui.badge(this, "站长"));
            }
            col.addView(nameRow);
            col.addView(Ui.gap(this, 3));
        }

        LinearLayout bubble = Ui.col(this);
        bubble.setPadding(Ui.dp(11), Ui.dp(8), Ui.dp(11), Ui.dp(8));
        if (m.senderFounder) {
            bubble.setBackgroundDrawable(Ui.gradient(0xFFC8A030, 0xFFF1DA8C, 6));
            if (prefs.goldFx()) {
                ObjectAnimator a = ObjectAnimator.ofFloat(bubble, "alpha", 0.90f, 1f);
                a.setDuration(1400);
                a.setRepeatCount(ValueAnimator.INFINITE);
                a.setRepeatMode(ValueAnimator.REVERSE);
                a.start();
            }
        } else {
            bubble.setBackgroundDrawable(Ui.rect(m.mine ? Ui.bubbleMe : Ui.bubbleOther, 6,
                    Ui.dark ? Ui.border : Ui.border, 1));
        }

        int textColor = m.senderFounder ? 0xFF241A00 : (m.mine ? Ui.bubbleMeFg : Ui.bubbleOtherFg);

        if (m.recalled) {
            TextView t = Ui.text(this, "该消息已撤回", 13, m.senderFounder ? 0xFF4A3A00 : Ui.fg3);
            t.setTypeface(Typeface.DEFAULT, Typeface.ITALIC);
            bubble.addView(t);
        } else if (m.hasFile && m.file != null) {
            bubble.addView(fileCard(m, textColor));
            if (m.content != null && m.content.length() > 0) {
                TextView cap = Ui.text(this, m.content, 14, textColor);
                cap.setPadding(0, Ui.dp(6), 0, 0);
                bubble.addView(cap);
            }
        } else {
            TextView t = Ui.text(this, m.content, 15, textColor);
            t.setTextIsSelectable(true);
            bubble.addView(t);
        }

        int metaColor = m.senderFounder ? 0xFF5B4700
                : (m.mine ? Ui.mix(Ui.bubbleMeFg, Ui.bubbleMe, 0.42f) : Ui.fg3);
        TextView meta = Ui.text(this, time(m.createdAt), 10, metaColor);
        meta.setGravity(Gravity.RIGHT);
        meta.setPadding(0, Ui.dp(3), 0, 0);
        bubble.addView(meta);

        col.addView(bubble);

        bubble.setOnLongClickListener(new View.OnLongClickListener() {
            public boolean onLongClick(View v) {
                messageMenu(m);
                return true;
            }
        });
        return row;
    }

    private View fileCard(final Api.Message m, int textColor) {
        LinearLayout c = Ui.col(this);
        LinearLayout row = Ui.row(this);
        String label = m.file.isImage ? "图" : m.file.isVideo ? "视" : "文";
        TextView icon = Ui.text(this, label, 12, 0xFFFFFFFF);
        icon.setTypeface(Typeface.DEFAULT_BOLD);
        icon.setGravity(Gravity.CENTER);
        icon.setBackgroundDrawable(Ui.rect(0xFF3B7DD8, 3, 0, 0));
        row.addView(icon, new LinearLayout.LayoutParams(Ui.dp(30), Ui.dp(30)));
        row.addView(Ui.gapW(this, 8));
        LinearLayout col = Ui.col(this);
        TextView nm = Ui.text(this, m.file.name, 13.5f, textColor);
        nm.setSingleLine(true);
        nm.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        col.addView(nm);
        col.addView(Ui.text(this, sizeText(m.file.size), 11, textColor));
        row.addView(col, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        c.addView(row);

        if (m.file.isImage && m.file.url != null && m.file.url.length() > 0) {
            final ImageView iv = new ImageView(this);
            iv.setAdjustViewBounds(true);
            iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                    Ui.dp(200), ViewGroup.LayoutParams.WRAP_CONTENT);
            ilp.topMargin = Ui.dp(7);
            c.addView(iv, ilp);
            images.load(m.file.url, new AvatarLoader.Callback() {
                public void onLoaded(String p, final Bitmap bmp) {
                    if (bmp == null) return;
                    runOnUiThread(new Runnable() {
                        public void run() { iv.setImageBitmap(bmp); }
                    });
                }
            });
        }

        TextView dl = Ui.miniBtn(this, "下载");
        dl.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (m.file.deleted) { Ui.toast0(ChatActivity.this, "文件已被删除"); return; }
                Downloads.save(ChatActivity.this, api, prefs, m.file.dlUrl, m.file.name);
            }
        });
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dlp.topMargin = Ui.dp(7);
        c.addView(dl, dlp);
        return c;
    }

    /* ---------------- 操作 ---------------- */

    private void sendText() {
        final String text = input.getText().toString().trim();
        if (text.length() == 0) return;
        if (dissolved) { Ui.toast0(this, "房间已解散"); return; }
        if (muted) { Ui.toast0(this, "你已被禁言"); return; }
        input.setText("");
        new Thread(new Runnable() {
            public void run() {
                try {
                    api.sendText(roomId, text);
                    runOnUiThread(new Runnable() {
                        public void run() { fetch(false); scrollToBottom(); }
                    });
                } catch (final Api.ApiException e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            Ui.toast0(ChatActivity.this, e.getMessage());
                            input.setText(text);
                        }
                    });
                }
            }
        }).start();
    }

    private void pickFile() {
        try {
            Intent it = new Intent(Intent.ACTION_GET_CONTENT);
            it.setType("*/*");
            it.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(it, REQ_ATTACH);
        } catch (Exception e) {
            Ui.toast0(this, "没有可用的文件选择器");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_ATTACH || resultCode != RESULT_OK || data == null
                || data.getData() == null) return;
        final android.net.Uri uri = data.getData();
        final String name = FileUtil.displayName(this, uri);
        final Dlg.Busy b = Dlg.progress(this, "上传中…");
        new Thread(new Runnable() {
            public void run() {
                try {
                    File tmp = FileUtil.copyToCache(ChatActivity.this, uri, name);
                    final String id = api.uploadTo(tmp, roomId, new Api.Progress() {
                        public void onProgress(final long done, final long total) {
                            final int pct = total <= 0 ? 0 : (int) (done * 100 / total);
                            runOnUiThread(new Runnable() {
                                public void run() { b.set("上传中… " + pct + "%"); }
                            });
                        }
                    });
                    try { tmp.delete(); } catch (Exception ignored) { }
                    api.sendFile(roomId, id, "");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            b.dismiss();
                            fetch(false);
                            scrollToBottom();
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            b.dismiss();
                            Ui.toast0(ChatActivity.this,
                                    e.getMessage() == null ? "发送失败" : e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    private void messageMenu(final Api.Message m) {
        LinearLayout body = Ui.col(this);
        if (m.canRecall && !m.recalled) {
            TextView rc = Ui.button(this, "撤回", false);
            rc.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    new Thread(new Runnable() {
                        public void run() {
                            try {
                                api.recall(m.id);
                                runOnUiThread(new Runnable() {
                                    public void run() { fetch(false); }
                                });
                            } catch (final Api.ApiException e) {
                                runOnUiThread(new Runnable() {
                                    public void run() { Ui.toast0(ChatActivity.this, e.getMessage()); }
                                });
                            }
                        }
                    }).start();
                }
            });
            body.addView(rc);
            body.addView(Ui.gap(this, 8));
        }
        TextView del = Ui.dangerBtn(this, "删除（仅自己不可见）");
        del.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                new Thread(new Runnable() {
                    public void run() {
                        try {
                            api.deleteMessage(m.id);
                            runOnUiThread(new Runnable() {
                                public void run() {
                                    messages.remove(m);
                                    renderAll();
                                }
                            });
                        } catch (final Api.ApiException e) {
                            runOnUiThread(new Runnable() {
                                public void run() { Ui.toast0(ChatActivity.this, e.getMessage()); }
                            });
                        }
                    }
                }).start();
            }
        });
        body.addView(del);
        Dlg.base(this, "消息", body, "取消", null, null);
    }

    private void showMembers() {
        new Thread(new Runnable() {
            public void run() {
                try {
                    final Api.MemberPage p = api.members(roomId);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            LinearLayout body = Ui.col(ChatActivity.this);
                            for (int i = 0; i < p.members.size(); i++) {
                                Api.Member m = p.members.get(i);
                                LinearLayout row = Ui.row(ChatActivity.this);
                                row.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
                                row.addView(Ui.avatar(ChatActivity.this, m.initial, m.avatarColor, 30));
                                LinearLayout left = Ui.col(ChatActivity.this);
                                LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(0,
                                        ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                                llp.leftMargin = Ui.dp(9);
                                LinearLayout nr = Ui.row(ChatActivity.this);
                                nr.addView(Ui.text(ChatActivity.this, m.displayName, 14, Ui.fg));
                                if (m.founder) {
                                    nr.addView(Ui.gapW(ChatActivity.this, 5));
                                    nr.addView(Ui.badge(ChatActivity.this, "站长"));
                                }
                                left.addView(nr);
                                left.addView(Ui.text(ChatActivity.this,
                                        m.roleName.length() > 0 ? m.roleName : "成员", 11.5f, Ui.fg3));
                                row.addView(left, llp);
                                body.addView(row);
                            }
                            if (p.members.isEmpty()) {
                                body.addView(Ui.text(ChatActivity.this, "还没有成员", 13, Ui.fg3));
                            }
                            Dlg.base(ChatActivity.this, "成员（" + p.members.size() + "）",
                                    body, "关闭", null, null);
                        }
                    });
                } catch (final Api.ApiException e) {
                    runOnUiThread(new Runnable() {
                        public void run() { Ui.toast0(ChatActivity.this, e.getMessage()); }
                    });
                }
            }
        }).start();
    }

    /* ---------------- 小工具 ---------------- */

    private void loadAvatar(final FrameLayout holder, String path) {
        if (path == null || path.length() == 0) return;
        avatars.load(path, new AvatarLoader.Callback() {
            public void onLoaded(String p, final Bitmap bmp) {
                if (bmp == null) return;
                runOnUiThread(new Runnable() {
                    public void run() {
                        ImageView iv = new ImageView(ChatActivity.this);
                        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                        iv.setImageBitmap(bmp);
                        holder.removeAllViews();
                        holder.addView(iv, new FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT));
                    }
                });
            }
        });
    }

    private static String first(String s) {
        if (s == null || s.length() == 0) return "?";
        return s.substring(0, 1);
    }

    private static String time(long ms) {
        if (ms <= 0) return "";
        long now = System.currentTimeMillis();
        boolean sameDay = new SimpleDateFormat("yyyyMMdd").format(new Date(ms))
                .equals(new SimpleDateFormat("yyyyMMdd").format(new Date(now)));
        return new SimpleDateFormat(sameDay ? "HH:mm" : "MM-dd HH:mm").format(new Date(ms));
    }

    private static String sizeText(long size) {
        if (size < 1024) return size + " B";
        if (size < 1024 * 1024) return String.format("%.1f KB", size / 1024.0);
        return String.format("%.1f MB", size / (1024.0 * 1024));
    }

    @Override
    protected void onResume() {
        super.onResume();
        paused = false;
        handler.removeCallbacks(poll);
        handler.post(poll);
    }

    @Override
    protected void onPause() {
        super.onPause();
        paused = true;
        handler.removeCallbacks(poll);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        Downloads.onPermissionResult(requestCode, grantResults);
    }
}
