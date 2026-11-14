package com.qingliao.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 登录页（原生控件，不含 WebView）。
 *
 * 三种形态：
 *   首次使用 → 账号密码表单
 *   记住过密码 → 头像横排，点选后一键登录（与 QQ 一致）
 *   添加账号 → 回到表单，同时保留已有账号
 */
public class LoginActivity extends Activity {

    private Store store;
    private Api api;

    private List<Store.Account> accounts = new ArrayList<Store.Account>();
    private int activeIndex = -1;
    private boolean registerMode = false;
    private boolean addingAccount = false;
    private boolean busy = false;

    private LinearLayout accountRow;
    private LinearLayout formBox;
    private EditText edUser, edPass, edNick;
    private TextView labelNick, tvSub, tvError, linkSwitch, linkManage;
    private CheckBox cbRemember, cbAuto, cbAutoOnly;
    private Button btnLogin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_login);

        store = new Store(this);
        api = new Api(store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE);

        accountRow = (LinearLayout) findViewById(R.id.accountRow);
        formBox = (LinearLayout) findViewById(R.id.formBox);
        edUser = (EditText) findViewById(R.id.edUser);
        edPass = (EditText) findViewById(R.id.edPass);
        edNick = (EditText) findViewById(R.id.edNick);
        labelNick = (TextView) findViewById(R.id.labelNick);
        tvSub = (TextView) findViewById(R.id.tvSub);
        tvError = (TextView) findViewById(R.id.tvError);
        linkSwitch = (TextView) findViewById(R.id.linkSwitch);
        linkManage = (TextView) findViewById(R.id.linkManage);
        cbRemember = (CheckBox) findViewById(R.id.cbRemember);
        cbAuto = (CheckBox) findViewById(R.id.cbAuto);
        cbAutoOnly = (CheckBox) findViewById(R.id.cbAutoOnly);
        btnLogin = (Button) findViewById(R.id.btnLogin);

        accounts = store.accounts();
        if (!accounts.isEmpty()) {
            activeIndex = 0;
            String last = store.lastUser();
            for (int i = 0; i < accounts.size(); i++) {
                if (accounts.get(i).user.equals(last)) { activeIndex = i; break; }
            }
        }
        addingAccount = accounts.isEmpty();
        cbRemember.setChecked(store.rememberDefault());

        btnLogin.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { submit(); }
        });
        linkSwitch.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { onSwitchLink(); }
        });
        linkManage.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showManage(); }
        });
        cbAuto.setOnCheckedChangeListener(new android.widget.CompoundButton.OnCheckedChangeListener() {
            public void onCheckedChanged(android.widget.CompoundButton b, boolean checked) {
                if (checked) cbRemember.setChecked(true);
            }
        });
        cbAutoOnly.setOnCheckedChangeListener(new android.widget.CompoundButton.OnCheckedChangeListener() {
            public void onCheckedChanged(android.widget.CompoundButton b, boolean checked) {
                if (activeIndex >= 0 && activeIndex < accounts.size()) {
                    store.setAutoUser(checked ? accounts.get(activeIndex).user : "");
                }
            }
        });

        refreshUi();

        /* 自动登录：只对勾过「自动登录」的账号生效 */
        String auto = store.autoUser();
        if (auto.length() > 0) {
            Store.Account a = store.find(auto);
            if (a != null && a.pass.length() > 0) {
                /* Account 没有重写 equals，不能用 indexOf，按账号名找 */
                for (int i = 0; i < accounts.size(); i++) {
                    if (accounts.get(i).user.equals(a.user)) { activeIndex = i; break; }
                }
                doLogin(a.user, a.pass, true);
            }
        }
    }

    /* ---------------- 界面状态 ---------------- */

    private boolean pickerMode() {
        return !registerMode && !addingAccount && !accounts.isEmpty();
    }

    private void refreshUi() {
        boolean picker = pickerMode();
        accountRow.setVisibility(picker ? View.VISIBLE : View.GONE);
        formBox.setVisibility(picker ? View.GONE : View.VISIBLE);
        cbAutoOnly.setVisibility(picker ? View.VISIBLE : View.GONE);
        linkManage.setVisibility(picker && accounts.size() > 1 ? View.VISIBLE : View.GONE);

        labelNick.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        edNick.setVisibility(registerMode ? View.VISIBLE : View.GONE);

        if (picker) {
            buildAccountRow();
            tvSub.setText(accounts.size() == 1 ? "点一下即可登录" : "选择一个账号登录");
            btnLogin.setText(busy ? "请稍候…" : "登录");
            linkSwitch.setText("其他登录方式");
            cbAutoOnly.setChecked(activeIndex >= 0 && activeIndex < accounts.size()
                    && store.autoUser().equals(accounts.get(activeIndex).user));
        } else {
            tvSub.setText(registerMode ? "创建账号，开始聊天" : "登录后即可收发消息");
            btnLogin.setText(busy ? "请稍候…" : (registerMode ? "注册并登录" : "登录"));
            if (registerMode) {
                linkSwitch.setText("已有账号？返回登录");
            } else if (!accounts.isEmpty()) {
                linkSwitch.setText("返回账号选择");
            } else {
                linkSwitch.setText("没有账号？立即注册");
            }
        }
        btnLogin.setEnabled(!busy);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void buildAccountRow() {
        accountRow.removeAllViews();
        int count = Math.min(accounts.size(), 4);
        for (int i = 0; i < count; i++) {
            final Store.Account a = accounts.get(i);
            final int idx = i;
            boolean sel = (i == activeIndex);

            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams lp =
                    new LinearLayout.LayoutParams(dp(76), ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(6);
            lp.rightMargin = dp(6);
            item.setLayoutParams(lp);

            TextView av = new TextView(this);
            int sz = dp(62);
            av.setLayoutParams(new LinearLayout.LayoutParams(sz, sz));
            av.setGravity(Gravity.CENTER);
            String nick = a.nick.length() > 0 ? a.nick : a.user;
            av.setText(nick.substring(0, Math.min(2, nick.length())));
            av.setTextColor(Color.WHITE);
            av.setTextSize(19);
            GradientDrawable g = new GradientDrawable();
            g.setShape(GradientDrawable.OVAL);
            g.setColor(sel ? 0xFF1F6FEB : 0xFFE2E5EA);
            if (sel) g.setStroke(dp(2), 0xFF96BEFA);
            av.setBackgroundDrawable(g);
            if (!sel) av.setTextColor(0xFF8A929E);

            av.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    activeIndex = idx;
                    tvError.setVisibility(View.GONE);
                    refreshUi();
                }
            });
            av.setOnLongClickListener(new View.OnLongClickListener() {
                public boolean onLongClick(View v) {
                    confirmForget(a);
                    return true;
                }
            });

            TextView name = new TextView(this);
            name.setLayoutParams(new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            name.setGravity(Gravity.CENTER);
            name.setText(nick);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.END);
            name.setTextSize(12);
            name.setTextColor(sel ? 0xFF1F2328 : 0xFF969EA8);
            name.setPadding(0, dp(7), 0, 0);

            item.addView(av);
            item.addView(name);
            accountRow.addView(item);
        }

        /* 「+」添加账号 */
        LinearLayout add = new LinearLayout(this);
        add.setOrientation(LinearLayout.VERTICAL);
        add.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams alp =
                new LinearLayout.LayoutParams(dp(76), ViewGroup.LayoutParams.WRAP_CONTENT);
        alp.leftMargin = dp(6);
        add.setLayoutParams(alp);

        TextView plus = new TextView(this);
        int sz = dp(62);
        plus.setLayoutParams(new LinearLayout.LayoutParams(sz, sz));
        plus.setGravity(Gravity.CENTER);
        plus.setText("+");
        plus.setTextSize(26);
        plus.setTextColor(0xFF969EA8);
        GradientDrawable pg = new GradientDrawable();
        pg.setShape(GradientDrawable.OVAL);
        pg.setColor(0xFFF7F8FA);
        pg.setStroke(dp(1), 0xFFDEE2E8);
        plus.setBackgroundDrawable(pg);
        plus.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                addingAccount = true;
                registerMode = false;
                edUser.setText("");
                edPass.setText("");
                tvError.setVisibility(View.GONE);
                refreshUi();
                edUser.requestFocus();
            }
        });

        TextView plusLabel = new TextView(this);
        plusLabel.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        plusLabel.setGravity(Gravity.CENTER);
        plusLabel.setText("添加账号");
        plusLabel.setTextSize(12);
        plusLabel.setTextColor(0xFF969EA8);
        plusLabel.setPadding(0, dp(7), 0, 0);

        add.addView(plus);
        add.addView(plusLabel);
        accountRow.addView(add);
    }

    /* ---------------- 交互 ---------------- */

    private void onSwitchLink() {
        if (registerMode) {
            registerMode = false;
        } else if (!accounts.isEmpty() && addingAccount) {
            addingAccount = false;
        } else if (!accounts.isEmpty()) {
            addingAccount = true;
            edUser.setText("");
            edPass.setText("");
        } else {
            registerMode = true;
        }
        tvError.setVisibility(View.GONE);
        refreshUi();
    }

    private void submit() {
        if (busy) return;
        if (pickerMode()) {
            if (activeIndex < 0 || activeIndex >= accounts.size()) return;
            Store.Account a = accounts.get(activeIndex);
            if (a.pass.length() == 0) {
                addingAccount = true;
                refreshUi();
                return;
            }
            cbRemember.setChecked(true);
            cbAuto.setChecked(store.autoUser().equals(a.user));
            doLogin(a.user, a.pass, false);
            return;
        }

        String u = edUser.getText().toString().trim();
        String p = edPass.getText().toString();
        if (u.length() == 0 || p.length() == 0) {
            showError("请填写账号和密码");
            return;
        }
        if (registerMode) {
            doRegister(u, p, edNick.getText().toString().trim());
        } else {
            doLogin(u, p, false);
        }
    }

    private void showError(String msg) {
        tvError.setText(msg);
        tvError.setVisibility(View.VISIBLE);
    }

    private void setBusy(boolean b) {
        busy = b;
        btnLogin.setEnabled(!b);
        btnLogin.setText(b ? "请稍候…" : (registerMode ? "注册并登录" : "登录"));
    }

    /* ---------------- 网络 ---------------- */

    private void doLogin(final String user, final String pass, final boolean silent) {
        setBusy(true);
        if (!silent) tvError.setVisibility(View.GONE);
        new Thread(new Runnable() {
            public void run() {
                try {
                    final Api.User u = api.login(user, pass);
                    store.setToken(api.token());
                    store.setBase(api.base());
                    boolean remember = silent || cbRemember.isChecked();
                    boolean auto = silent ? true : cbAuto.isChecked();
                    store.remember(user, pass, u.nickname, remember);
                    store.setAutoUser(auto && remember ? user : "");
                    runOnUiThread(new Runnable() {
                        public void run() { gotoMain(); }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            setBusy(false);
                            if (!silent) {
                                showError(e.getMessage() == null ? "登录失败" : e.getMessage());
                            } else {
                                /* 自动登录失败：退回选择账号 */
                                accounts = store.accounts();
                                if (e.getMessage() != null && e.getMessage().contains("密码")) {
                                    store.forget(user);
                                    accounts = store.accounts();
                                    addingAccount = accounts.isEmpty();
                                }
                                refreshUi();
                            }
                        }
                    });
                }
            }
        }).start();
    }

    private void doRegister(final String user, final String pass, final String nick) {
        setBusy(true);
        tvError.setVisibility(View.GONE);
        new Thread(new Runnable() {
            public void run() {
                try {
                    final Api.User u = api.register(user, pass, nick);
                    store.setToken(api.token());
                    store.setBase(api.base());
                    store.remember(user, pass, u.nickname, cbRemember.isChecked());
                    store.setAutoUser(cbAuto.isChecked() ? user : "");
                    runOnUiThread(new Runnable() {
                        public void run() { gotoMain(); }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            setBusy(false);
                            showError(e.getMessage() == null ? "注册失败" : e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    private void gotoMain() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    /* ---------------- 账号管理 ---------------- */

    private void confirmForget(final Store.Account a) {
        new AlertDialog.Builder(this)
                .setTitle("移除账号")
                .setMessage("从本机移除「" + (a.nick.length() > 0 ? a.nick : a.user)
                        + "」保存的密码？下次需要重新输入。")
                .setNegativeButton("取消", null)
                .setPositiveButton("移除", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        store.forget(a.user);
                        reloadAccounts();
                    }
                })
                .show();
    }

    private void showManage() {
        final List<Store.Account> list = store.accounts();
        final String[] names = new String[list.size()];
        for (int i = 0; i < list.size(); i++) {
            Store.Account a = list.get(i);
            names[i] = (a.nick.length() > 0 ? a.nick : a.user) + "（@" + a.user + "）";
        }
        new AlertDialog.Builder(this)
                .setTitle("账号管理")
                .setItems(names, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        confirmForget(list.get(which));
                    }
                })
                .setNegativeButton("关闭", null)
                .show();
    }

    private void reloadAccounts() {
        accounts = store.accounts();
        if (accounts.isEmpty()) {
            activeIndex = -1;
            addingAccount = true;
        } else {
            if (activeIndex >= accounts.size()) activeIndex = 0;
            addingAccount = false;
        }
        refreshUi();
    }

    @Override
    public void onBackPressed() {
        if (pickerMode()) {
            finish();
            return;
        }
        if (registerMode || (!accounts.isEmpty() && addingAccount)) {
            registerMode = false;
            addingAccount = false;
            refreshUi();
            return;
        }
        super.onBackPressed();
    }
}
