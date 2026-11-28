package com.qingliao.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 主界面壳：顶栏 + 内容区 + 底部五页签。
 * 视觉对齐网页版 2.9.x 的手机端（深蓝方角卡片、页签选中顶部短横条）。
 */
public class MainActivity extends Activity {

    public static final String[] TITLES = {"主页", "房间", "好友", "网盘", "我的"};

    public static MainActivity inst;

    public Store store;
    public Api api;
    public Prefs prefs;
    public AvatarLoader avatars;

    private FrameLayout content;
    private TextView titleView;
    private View themeBtn;
    private LinearLayout tabbar;
    private TextView[] tabLabels = new TextView[TITLES.length];
    private View[] tabBars = new View[TITLES.length];

    private Page[] pages = new Page[TITLES.length];
    private View[] pageViews = new View[TITLES.length];
    private int tab = 0;
    private int stamp = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        inst = this;

        store = new Store(this);
        prefs = new Prefs(this);
        Ui.init(this);
        prefs.applySkinColors();
        Ui.themeWindow(this);

        api = new Api(store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE);
        api.setToken(store.token());
        if (!api.loggedIn()) {
            startActivity(new Intent(this, LoginActivity.class));
            finish();
            return;
        }
        avatars = new AvatarLoader(api, 120);
        stamp = calcStamp();

        buildShell();
        select(0);
        refreshMe();
    }

    /* ---------------- 壳 ---------------- */

    private void buildShell() {
        LinearLayout root = Ui.col(this);
        root.setBackgroundColor(Ui.bg);

        // 顶栏
        LinearLayout topWrap = Ui.col(this);
        topWrap.setBackgroundColor(Ui.topbar);
        LinearLayout top = Ui.row(this);
        top.setPadding(Ui.dp(16), 0, Ui.dp(8), 0);
        titleView = Ui.bold(this, TITLES[0], 19, Ui.topbarFg);
        titleView.setLetterSpacing(0.03f);
        top.addView(titleView);
        top.addView(Ui.spacer(this));
        top.addView(Ui.moonButton(this, Ui.dark, new View.OnClickListener() {
            public void onClick(View v) {
                prefs.setThemeMode(2);
                prefs.setManualDark(!Ui.dark);
                recreate();
            }
        }));
        topWrap.addView(top, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(54)));
        View tl = new View(this);
        tl.setBackgroundColor(Ui.border);
        topWrap.addView(tl, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.7f))));
        root.addView(topWrap);

        // 内容
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 底栏
        LinearLayout bottomWrap = Ui.col(this);
        bottomWrap.setBackgroundColor(Ui.tabbar);
        View bl = new View(this);
        bl.setBackgroundColor(Ui.border);
        bottomWrap.addView(bl, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(0.7f))));
        tabbar = Ui.row(this);
        for (int i = 0; i < TITLES.length; i++) {
            LinearLayout item = Ui.col(this);
            item.setGravity(Gravity.CENTER);
            item.setClickable(true);
            final int idx = i;
            View bar = new View(this);
            bar.setBackgroundColor(0x00000000);
            item.addView(bar, new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(2)));
            TextView lb = Ui.text(this, TITLES[i], 12.5f, Ui.fg3);
            lb.setGravity(Gravity.CENTER);
            item.addView(lb, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            item.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { select(idx); }
            });
            tabBars[i] = bar;
            tabLabels[i] = lb;
            tabbar.addView(item, new LinearLayout.LayoutParams(0, Ui.dp(52), 1f));
        }
        bottomWrap.addView(tabbar);
        root.addView(bottomWrap);

        setContentView(root);
    }

    public void select(int idx) {
        if (idx < 0 || idx >= TITLES.length) return;
        tab = idx;
        titleView.setText(TITLES[idx]);
        for (int i = 0; i < TITLES.length; i++) {
            boolean on = i == idx;
            tabLabels[i].setTextColor(on ? Ui.accentText : Ui.fg3);
            tabLabels[i].setTypeface(on ? android.graphics.Typeface.DEFAULT_BOLD : null);
            tabBars[i].setBackgroundColor(on ? Ui.accent : 0x00000000);
        }
        if (pages[idx] == null) {
            pages[idx] = createPage(idx);
            pageViews[idx] = pages[idx].view();
        }
        content.removeAllViews();
        content.addView(pageViews[idx], new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        pages[idx].onShow();
    }

    private Page createPage(int idx) {
        switch (idx) {
            case 1: return new RoomsPage(this);
            case 2: return new FriendsPage(this);
            case 3: return new DrivePage(this);
            case 4: return new MePage(this);
            default: return new HomePage(this);
        }
    }

    /* ---------------- 公共能力 ---------------- */

    public void toast(String msg) {
        if (msg == null || msg.length() == 0) return;
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    public void runBg(final Runnable r) {
        new Thread(new Runnable() {
            public void run() { r.run(); }
        }).start();
    }

    public void ui(final Runnable r) {
        runOnUiThread(new Runnable() {
            public void run() { r.run(); }
        });
    }

    public void refreshMe() {
        runBg(new Runnable() {
            public void run() {
                try {
                    api.me();
                    ui(new Runnable() {
                        public void run() {
                            if (tab == 4 && pages[4] != null) pages[4].load();
                            avatars.clear();
                        }
                    });
                } catch (Exception ignored) {
                }
            }
        });
    }

    public void openRoom(String roomId, String name) {
        Intent it = new Intent(this, ChatActivity.class);
        it.putExtra("roomId", roomId);
        it.putExtra("roomName", name);
        startActivity(it);
    }

    /** 打开与某人的私聊（私聊不是房间，单独走 /api/dm） */
    public void openDm(final String userId, final String name) {
        runBg(new Runnable() {
            public void run() {
                try {
                    final Api.Room r = api.dm(userId);
                    ui(new Runnable() {
                        public void run() {
                            openRoom(r.id, name == null || name.length() == 0 ? r.name : name);
                        }
                    });
                } catch (final Api.ApiException e) {
                    ui(new Runnable() {
                        public void run() { toast(e.getMessage()); }
                    });
                }
            }
        });
    }

    public void reloadTab(int idx) {
        if (idx >= 0 && idx < pages.length && pages[idx] != null) pages[idx].load();
    }

    public Store store() { return store; }
    public Api api() { return api; }
    public Prefs prefs() { return prefs; }
    public AvatarLoader avatars() { return avatars; }

    /* ---------------- 生命周期 ---------------- */

    private int calcStamp() {
        return prefs.themeMode() * 31 + (prefs.manualDark() ? 7 : 0) + prefs.skinId().hashCode();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (api != null && !api.loggedIn()) {
            startActivity(new Intent(this, LoginActivity.class));
            finish();
            return;
        }
        if (stamp != 0 && stamp != calcStamp()) {
            recreate();
            return;
        }
        if (pages[tab] != null) pages[tab].onShow();
    }

    /* ---------------- 选文件（网盘上传 / 换头像） ---------------- */

    public static final int REQ_PICK_DRIVE = 7001;
    public static final int REQ_PICK_AVATAR = 7002;

    public void pickFileForDrive() {
        try {
            Intent it = new Intent(Intent.ACTION_GET_CONTENT);
            it.setType("*/*");
            it.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(it, REQ_PICK_DRIVE);
        } catch (Exception e) {
            toast("没有可用的文件选择器");
        }
    }

    public void pickAvatar() {
        try {
            Intent it = new Intent(Intent.ACTION_GET_CONTENT);
            it.setType("image/*");
            it.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(it, REQ_PICK_AVATAR);
        } catch (Exception e) {
            toast("没有可用的相册");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        android.net.Uri uri = data.getData();
        if (requestCode == REQ_PICK_DRIVE) {
            String name = FileUtil.displayName(this, uri);
            if (pages[3] instanceof DrivePage) ((DrivePage) pages[3]).onPickedFile(uri, name);
        } else if (requestCode == REQ_PICK_AVATAR) {
            if (pages[4] instanceof MePage) ((MePage) pages[4]).onAvatarPicked(uri);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        Downloads.onPermissionResult(requestCode, grantResults);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (tab != 0) {
                select(0);
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }
}
