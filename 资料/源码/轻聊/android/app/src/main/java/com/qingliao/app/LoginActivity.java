package com.qingliao.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 登录 / 注册页。视觉与主界面同一套设计系统（深蓝方角）。
 * 保留多账号记忆、记住密码、自动登录。
 */
public class LoginActivity extends Activity {

    private Store store;
    private Api api;
    private Prefs prefs;

    private final List<Store.Account> accounts = new ArrayList<Store.Account>();
    private int active = -1;
    private boolean registerMode = false;
    private boolean busy = false;

    private LinearLayout body;
    private EditText edUser, edPass, edNick;
    private TextView err;
    private CheckBox remember;
    private CheckBox autoLogin;
    private TextView submit;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = new Store(this);
        prefs = new Prefs(this);
        Ui.init(this);
        prefs.applySkinColors();
        Ui.themeWindow(this);

        api = new Api(store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE);

        // 已有有效登录态：直接进主界面（服务端失效会在主界面被踢回来）
        if (store.token().length() > 0) {
            gotoMain();
            return;
        }

        accounts.clear();
        accounts.addAll(store.accounts());
        if (!accounts.isEmpty()) {
            active = 0;
            String last = store.lastUser();
            for (int i = 0; i < accounts.size(); i++) {
                if (accounts.get(i).user.equals(last)) { active = i; break; }
            }
        }

        build();
        tryAutoLogin();
    }

    private void build() {
        LinearLayout root = Ui.col(this);
        root.setBackgroundColor(Ui.bg);

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        LinearLayout wrap = Ui.col(this);
        wrap.setPadding(Ui.dp(22), Ui.dp(46), Ui.dp(22), Ui.dp(28));

        // 标志
        TextView logo = Ui.bold(this, "轻聊", 32, Ui.fg);
        logo.setGravity(Gravity.CENTER);
        logo.setLetterSpacing(0.18f);
        wrap.addView(logo);
        TextView sub = Ui.text(this, "原生客户端 · 不加载网页", 12.5f, Ui.fg3);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, Ui.dp(7), 0, Ui.dp(26));
        wrap.addView(sub);

        // 卡片
        LinearLayout card = Ui.card(this);
        card.setPadding(Ui.dp(16), Ui.dp(16), Ui.dp(16), Ui.dp(16));
        body = Ui.col(this);
        card.addView(body);
        wrap.addView(card, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        err = Ui.text(this, "", 12.5f, Ui.danger);
        err.setPadding(0, Ui.dp(10), 0, 0);
        err.setVisibility(View.GONE);
        wrap.addView(err);

        TextView foot = Ui.text(this, "登录即表示同意站内规则；账号与网页版互通。", 11, Ui.fg3);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, Ui.dp(18), 0, 0);
        wrap.addView(foot);

        sv.addView(wrap, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        renderBody();
    }

    private void renderBody() {
        body.removeAllViews();
        err.setVisibility(View.GONE);

        boolean picker = !registerMode && !accounts.isEmpty() && active >= 0;

        // 模式切换
        LinearLayout seg = Ui.row(this);
        seg.setBackgroundDrawable(Ui.rect(Ui.surface2, 4, Ui.border, 1));
        seg.setPadding(Ui.dp(3), Ui.dp(3), Ui.dp(3), Ui.dp(3));
        String[] names = {"登录", "注册"};
        for (int i = 0; i < 2; i++) {
            final boolean reg = i == 1;
            boolean on = reg == registerMode;
            TextView t = Ui.text(this, names[i], 13.5f, on ? Ui.onAccent : Ui.fg2);
            if (on) t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, Ui.dp(8), 0, Ui.dp(8));
            t.setBackgroundDrawable(on ? Ui.rect(Ui.accent, 3, 0, 0) : null);
            t.setClickable(true);
            t.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    registerMode = reg;
                    renderBody();
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i > 0) lp.leftMargin = Ui.dp(3);
            seg.addView(t, lp);
        }
        body.addView(seg);
        body.addView(Ui.gap(this, 14));

        if (picker) {
            body.addView(Ui.text(this, accounts.size() == 1 ? "点一下头像即可登录" : "选择账号登录",
                    12.5f, Ui.fg3));
            body.addView(Ui.gap(this, 10));

            LinearLayout row = Ui.row(this);
            int count = Math.min(accounts.size(), 4);
            for (int i = 0; i < count; i++) {
                final int idx = i;
                final Store.Account a = accounts.get(i);
                boolean sel = i == active;
                LinearLayout item = Ui.col(this);
                item.setGravity(Gravity.CENTER);

                FrameLayout av = Ui.avatar(this, first(a.nick.length() > 0 ? a.nick : a.user),
                        null, 52);
                if (sel) av.setBackgroundDrawable(Ui.circle(Ui.accent, Ui.fg2, 2));
                item.addView(av);
                TextView nm = Ui.text(this, a.nick.length() > 0 ? a.nick : a.user, 11.5f,
                        sel ? Ui.fg : Ui.fg3);
                nm.setGravity(Gravity.CENTER);
                nm.setPadding(0, Ui.dp(6), 0, 0);
                item.addView(nm);
                item.setClickable(true);
                item.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) {
                        active = idx;
                        renderBody();
                    }
                });
                item.setOnLongClickListener(new View.OnLongClickListener() {
                    public boolean onLongClick(View v) {
                        askForget(a);
                        return true;
                    }
                });
                row.addView(item, new LinearLayout.LayoutParams(0,
                        ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            }
            body.addView(row);

            body.addView(Ui.gap(this, 14));
            remember = new CheckBox(this);
            remember.setText("记住密码");
            remember.setTextColor(Ui.fg2);
            remember.setTextSize(13);
            remember.setChecked(true);
            Ui.tintCheck(remember);
            body.addView(remember);

            autoLogin = new CheckBox(this);
            autoLogin.setText("下次自动登录");
            autoLogin.setTextColor(Ui.fg2);
            autoLogin.setTextSize(13);
            Ui.tintCheck(autoLogin);
            body.addView(autoLogin);

            body.addView(Ui.gap(this, 12));
            submit = Ui.button(this, busy ? "请稍候…" : "登录", true);
            submit.setEnabled(!busy);
            submit.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    if (active < 0 || active >= accounts.size()) return;
                    Store.Account a = accounts.get(active);
                    store.remember(a.user, a.pass, a.nick, remember.isChecked());
                    store.setAutoUser(autoLogin.isChecked() ? a.user : "");
                    doLogin(a.user, a.pass, false);
                }
            });
            body.addView(submit);

            body.addView(Ui.gap(this, 12));
            TextView other = Ui.text(this, "使用其他账号登录", 12.5f, Ui.accent);
            other.setGravity(Gravity.CENTER);
            other.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
            other.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    active = -1;
                    renderBody();
                }
            });
            body.addView(other);
            return;
        }

        // 表单
        edUser = Ui.input(this, "账号名");
        body.addView(edUser);
        body.addView(Ui.gap(this, 9));
        edPass = Ui.input(this, "密码");
        edPass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        body.addView(edPass);

        if (registerMode) {
            body.addView(Ui.gap(this, 9));
            edNick = Ui.input(this, "昵称（可留空，默认用账号名）");
            body.addView(edNick);
        }

        body.addView(Ui.gap(this, 10));
        remember = new CheckBox(this);
        remember.setText("记住密码");
        remember.setTextColor(Ui.fg2);
        remember.setTextSize(13);
        remember.setChecked(store.rememberDefault());
        Ui.tintCheck(remember);
        body.addView(remember);

        autoLogin = new CheckBox(this);
        autoLogin.setText("下次自动登录");
        autoLogin.setTextColor(Ui.fg2);
        autoLogin.setTextSize(13);
        Ui.tintCheck(autoLogin);
        body.addView(autoLogin);

        body.addView(Ui.gap(this, 12));
        submit = Ui.button(this, busy ? "请稍候…" : (registerMode ? "注册并登录" : "登录"), true);
        submit.setEnabled(!busy);
        submit.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { submit(); }
        });
        body.addView(submit);

        if (!accounts.isEmpty()) {
            body.addView(Ui.gap(this, 12));
            TextView back = Ui.text(this, "返回账号选择", 12.5f, Ui.accent);
            back.setGravity(Gravity.CENTER);
            back.setPadding(0, Ui.dp(6), 0, Ui.dp(6));
            back.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    registerMode = false;
                    active = 0;
                    renderBody();
                }
            });
            body.addView(back);
        }
    }

    private void submit() {
        if (busy) return;
        String u = edUser.getText().toString().trim();
        String p = edPass.getText().toString();
        String nick = edNick == null ? "" : edNick.getText().toString().trim();
        if (u.length() == 0) { showError("请输入账号名"); return; }
        if (p.length() < 6) { showError("密码至少 6 位"); return; }
        if (registerMode) doRegister(u, p, nick);
        else doLogin(u, p, false);
    }

    private void doLogin(final String user, final String pass, final boolean silent) {
        busy = true;
        if (submit != null && !silent) submit.setText("请稍候…");
        new Thread(new Runnable() {
            public void run() {
                try {
                    api.login(user, pass);
                    store.setBase(api.base());
                    store.setToken(api.token());
                    store.remember(user, pass, api.user.nickname, true);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            busy = false;
                            gotoMain();
                        }
                    });
                } catch (final Api.ApiException e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            busy = false;
                            if (submit != null) submit.setText("登录");
                            if (silent) {
                                store.setToken("");
                                renderBody();
                            } else {
                                showError(e.getMessage());
                            }
                        }
                    });
                }
            }
        }).start();
    }

    private void doRegister(final String user, final String pass, final String nick) {
        busy = true;
        if (submit != null) submit.setText("请稍候…");
        new Thread(new Runnable() {
            public void run() {
                try {
                    api.register(user, pass, nick);
                    store.setBase(api.base());
                    store.setToken(api.token());
                    store.remember(user, pass, api.user.nickname, true);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            busy = false;
                            gotoMain();
                        }
                    });
                } catch (final Api.ApiException e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            busy = false;
                            if (submit != null) submit.setText("注册并登录");
                            showError(e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    private void tryAutoLogin() {
        String auto = store.autoUser();
        if (auto.length() == 0) return;
        Store.Account a = store.find(auto);
        if (a == null || a.pass.length() == 0) return;
        doLogin(a.user, a.pass, true);
    }

    private void askForget(final Store.Account a) {
        Dlg.confirm(this, "移除账号", "从本机移除「" + (a.nick.length() > 0 ? a.nick : a.user)
                + "」记住的密码？（不影响服务器上的账号）", "移除", new Dlg.OnOk() {
            public void run() {
                store.forget(a.user);
                accounts.clear();
                accounts.addAll(store.accounts());
                active = accounts.isEmpty() ? -1 : 0;
                renderBody();
            }
        });
    }

    private void showError(String msg) {
        err.setText(msg == null ? "操作失败" : msg);
        err.setVisibility(View.VISIBLE);
    }

    private void gotoMain() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private static String first(String s) {
        if (s == null || s.length() == 0) return "?";
        return s.substring(0, 1);
    }
}
