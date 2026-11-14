package com.qingliao.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 聊天主界面（原生 Activity + ListView，完全不含 WebView）。
 *
 * 数据流：Api（同步阻塞）跑在子线程 → runOnUiThread 刷新列表。
 * 轮询用 Handler 每 3 秒拉一次增量，页面不可见时停掉，省电。
 */
public class MainActivity extends Activity implements MsgAdapter.Listener {

    private static final int REQ_PICK_FILE = 2001;
    private static final int POLL_MS = 3000;

    private Store store;
    private Api api;
    private MsgAdapter adapter;

    private List<Api.Room> rooms = new ArrayList<Api.Room>();
    private String roomId = "";
    private String roomName = "";
    private long lastSeq = 0;
    private boolean loading = false;
    private long lastBackAt = 0;

    private TextView tvTitle, tvSub, btnRooms, btnMe, btnFile;
    private EditText edInput;
    private Button btnSend;
    private ListView list;

    private final Handler handler = new Handler();
    private final Runnable pollTask = new Runnable() {
        public void run() {
            if (!isFinishing() && roomId.length() > 0) loadMessages(false);
            handler.postDelayed(this, POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        store = new Store(this);
        if (store.token().length() == 0) {
            gotoLogin();
            return;
        }
        api = new Api(store.base().length() > 0 ? store.base() : Api.DEFAULT_BASE);
        api.setToken(store.token());

        setContentView(R.layout.activity_main);
        tvTitle = (TextView) findViewById(R.id.tvTitle);
        tvSub = (TextView) findViewById(R.id.tvSub);
        btnRooms = (TextView) findViewById(R.id.btnRooms);
        btnMe = (TextView) findViewById(R.id.btnMe);
        btnFile = (TextView) findViewById(R.id.btnFile);
        edInput = (EditText) findViewById(R.id.edInput);
        btnSend = (Button) findViewById(R.id.btnSend);
        list = (ListView) findViewById(R.id.list);

        adapter = new MsgAdapter(this, this);
        list.setAdapter(adapter);

        btnRooms.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showRooms(); }
        });
        btnMe.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showMe(); }
        });
        btnSend.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { send(); }
        });
        btnFile.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { pickFile(); }
        });
        edInput.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            public boolean onEditorAction(TextView v, int actionId, KeyEvent event) {
                if (actionId == EditorInfo.IME_ACTION_SEND
                        || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                        && event.getAction() == KeyEvent.ACTION_DOWN)) {
                    send();
                    return true;
                }
                return false;
            }
        });

        loadRooms();

        /* 顺手把个人资料拉下来：改昵称、显示昵称都要用 */
        new Thread(new Runnable() {
            public void run() {
                try { api.me(); } catch (Exception ignored) { }
            }
        }).start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.removeCallbacks(pollTask);
        handler.postDelayed(pollTask, POLL_MS);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(pollTask);
    }

    private void gotoLogin() {
        startActivity(new Intent(this, LoginActivity.class));
        finish();
    }

    /* ---------------- 房间 ---------------- */

    private void loadRooms() {
        new Thread(new Runnable() {
            public void run() {
                try {
                    final List<Api.Room> rs = api.rooms();
                    runOnUiThread(new Runnable() {
                        public void run() {
                            rooms = rs;
                            if (roomId.length() == 0 && !rs.isEmpty()) {
                                Api.Room pick = rs.get(0);
                                for (int i = 0; i < rs.size(); i++) {
                                    if ("public".equals(rs.get(i).kind)) { pick = rs.get(i); break; }
                                }
                                openRoom(pick);
                            }
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            String msg = e.getMessage() == null ? "" : e.getMessage();
                            if (msg.contains("登录") || msg.contains("凭证")) {
                                store.setToken("");
                                gotoLogin();
                            } else {
                                toast("加载房间失败：" + msg);
                            }
                        }
                    });
                }
            }
        }).start();
    }

    private void openRoom(Api.Room r) {
        roomId = r.id;
        roomName = r.name;
        lastSeq = 0;
        adapter.setData(new ArrayList<Api.Message>());
        tvTitle.setText(r.name);
        tvSub.setText("");
        loadMessages(true);
    }

    private void showRooms() {
        if (rooms.isEmpty()) {
            loadRooms();
            toast("正在加载房间…");
            return;
        }
        final String[] names = new String[rooms.size()];
        for (int i = 0; i < rooms.size(); i++) {
            Api.Room r = rooms.get(i);
            String tag = "public".equals(r.kind) ? "公共" : (r.memberCount + " 人");
            names[i] = r.name + "　（" + tag + "）";
        }
        new AlertDialog.Builder(this)
                .setTitle("选择房间")
                .setItems(names, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        openRoom(rooms.get(which));
                    }
                })
                .setNeutralButton("新建房间", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) { newRoom(); }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void newRoom() {
        final EditText ed = new EditText(this);
        ed.setHint("房间名称");
        new AlertDialog.Builder(this)
                .setTitle("新建房间")
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("创建", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        final String name = ed.getText().toString().trim();
                        if (name.length() == 0) return;
                        new Thread(new Runnable() {
                            public void run() {
                                try {
                                    final Api.Room r = api.createRoom(name, "");
                                    runOnUiThread(new Runnable() {
                                        public void run() {
                                            toast("房间已创建");
                                            loadRooms();
                                            openRoom(r);
                                        }
                                    });
                                } catch (final Exception e) {
                                    runOnUiThread(new Runnable() {
                                        public void run() {
                                            toast(e.getMessage() == null ? "创建失败" : e.getMessage());
                                        }
                                    });
                                }
                            }
                        }).start();
                    }
                })
                .show();
    }

    /* ---------------- 消息 ---------------- */

    private void loadMessages(final boolean full) {
        if (loading || roomId.length() == 0) return;
        loading = true;
        final long since = full ? 0 : lastSeq;
        new Thread(new Runnable() {
            public void run() {
                try {
                    final Api.MessagePage page = api.messages(roomId, since, full ? 80 : 60);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            loading = false;
                            applyPage(page, full);
                        }
                    });
                } catch (final Exception e) {
                    loading = false;
                    runOnUiThread(new Runnable() {
                        public void run() {
                            String msg = e.getMessage() == null ? "" : e.getMessage();
                            if (msg.contains("登录") || msg.contains("凭证")) {
                                store.setToken("");
                                gotoLogin();
                            }
                        }
                    });
                }
            }
        }).start();
    }

    private void applyPage(Api.MessagePage page, boolean full) {
        if (full) {
            adapter.setData(page.messages);
            lastSeq = page.lastSeq;
            scrollToBottom();
        } else {
            if (page.messages.isEmpty() && page.purgedIds.isEmpty()) {
                lastSeq = Math.max(lastSeq, page.lastSeq);
                return;
            }
            List<Api.Message> cur = adapter.data();
            boolean added = false;
            for (int i = 0; i < page.messages.size(); i++) {
                Api.Message nm = page.messages.get(i);
                boolean found = false;
                for (int k = 0; k < cur.size(); k++) {
                    if (cur.get(k).id.equals(nm.id)) {
                        cur.set(k, nm);
                        found = true;
                        break;
                    }
                }
                if (!found) { cur.add(nm); added = true; }
            }
            for (int i = 0; i < page.purgedIds.size(); i++) {
                String pid = page.purgedIds.get(i);
                for (int k = 0; k < cur.size(); k++) {
                    if (cur.get(k).id.equals(pid)) { cur.remove(k); break; }
                }
            }
            lastSeq = Math.max(lastSeq, page.lastSeq);
            adapter.notifyDataSetChanged();
            if (added) scrollToBottom();
        }

        String sub = page.total + " 条消息";
        if (page.dissolved) sub += " · 该房间已解散";
        else if (page.roleName != null && page.roleName.length() > 0) sub += " · " + page.roleName;
        tvSub.setText(sub);

        boolean canSend = page.canPost && !page.dissolved;
        btnSend.setEnabled(canSend);
        btnSend.setAlpha(canSend ? 1f : 0.5f);
        if (!canSend) {
            edInput.setHint(page.muted ? "你已被禁言" : "当前不能发言");
        } else {
            edInput.setHint("说点什么…");
        }
    }

    private void scrollToBottom() {
        list.post(new Runnable() {
            public void run() {
                if (adapter.getCount() > 0) list.setSelection(adapter.getCount() - 1);
            }
        });
    }

    private void send() {
        final String text = edInput.getText().toString().trim();
        if (text.length() == 0 || roomId.length() == 0) return;
        if (text.length() > 4000) { toast("单条消息最多 4000 字"); return; }
        edInput.setText("");
        new Thread(new Runnable() {
            public void run() {
                try {
                    api.sendText(roomId, text);
                    runOnUiThread(new Runnable() {
                        public void run() { loadMessages(false); }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            toast(e.getMessage() == null ? "发送失败" : e.getMessage());
                            edInput.setText(text);
                        }
                    });
                }
            }
        }).start();
    }

    /* ---------------- 文件 ---------------- */

    private void pickFile() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("*/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_PICK_FILE);
        } catch (Exception e) {
            toast("没有可用的文件选择器");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_FILE || resultCode != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri == null) return;
        uploadUri(uri);
    }

    private String displayName(Uri uri) {
        String name = null;
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        if (name == null) {
            name = uri.getLastPathSegment();
            if (name == null) name = "file";
            int slash = name.lastIndexOf('/');
            if (slash >= 0) name = name.substring(slash + 1);
        }
        return name;
    }

    private void uploadUri(final Uri uri) {
        final String name = displayName(uri);
        tvSub.setText("正在上传 0%");
        new Thread(new Runnable() {
            public void run() {
                File tmp = null;
                try {
                    tmp = new File(getCacheDir(), "upload_" + System.currentTimeMillis() + "_" + name);
                    InputStream is = getContentResolver().openInputStream(uri);
                    if (is == null) throw new Exception("无法读取该文件");
                    OutputStream os = new FileOutputStream(tmp);
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                    os.close();
                    is.close();

                    final String shown = name;
                    String fileId = api.upload(roomId, tmp, new Api.Progress() {
                        public void onProgress(long done, long total) {
                            final int pct = total > 0 ? (int) (done * 100 / total) : 0;
                            runOnUiThread(new Runnable() {
                                public void run() { tvSub.setText("正在上传 " + pct + "%"); }
                            });
                        }
                    }, MainActivity.this);
                    api.sendFile(roomId, fileId, "");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            tvSub.setText("已发送：" + shown);
                            loadMessages(false);
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            tvSub.setText("");
                            toast(e.getMessage() == null ? "上传失败" : e.getMessage());
                        }
                    });
                } finally {
                    if (tmp != null) tmp.delete();
                }
            }
        }).start();
    }

    public void onFileClick(final Api.Message m) {
        if (!m.hasFile || m.file.deleted) return;
        final String url = m.file.dlUrl.length() > 0 ? m.file.dlUrl : m.file.url;
        new AlertDialog.Builder(this)
                .setTitle(m.file.name)
                .setMessage("保存到手机？")
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) { download(url, m.file.name); }
                })
                .show();
    }

    private void download(final String urlPath, final String name) {
        tvSub.setText("正在下载…");
        new Thread(new Runnable() {
            public void run() {
                try {
                    File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getFilesDir();
                    if (!dir.exists()) dir.mkdirs();
                    final File out = new File(dir, name);
                    api.download(urlPath, out, null);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            tvSub.setText("已保存：" + out.getName());
                            toast("已保存到\n" + out.getAbsolutePath());
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            tvSub.setText("");
                            toast(e.getMessage() == null ? "下载失败" : e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    public void onMessageLongClick(final Api.Message m) {
        if ("system".equals(m.kind)) return;
        final List<String> opts = new ArrayList<String>();
        if (m.canRecall) opts.add("撤回");
        if (m.mine) opts.add("直接删除");
        if (opts.isEmpty()) return;

        new AlertDialog.Builder(this)
                .setItems(opts.toArray(new String[0]), new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        final boolean recall = "撤回".equals(opts.get(which));
                        new Thread(new Runnable() {
                            public void run() {
                                try {
                                    if (recall) api.recall(m.id);
                                    else api.deleteMessage(m.id);
                                    runOnUiThread(new Runnable() {
                                        public void run() { loadMessages(false); }
                                    });
                                } catch (final Exception e) {
                                    runOnUiThread(new Runnable() {
                                        public void run() {
                                            toast(e.getMessage() == null ? "操作失败" : e.getMessage());
                                        }
                                    });
                                }
                            }
                        }).start();
                    }
                })
                .show();
    }

    /* ---------------- 我的 ---------------- */

    private void showMe() {
        String nick = api.user.nickname.length() > 0 ? api.user.nickname : "";
        String[] items = {"修改昵称" + (nick.length() > 0 ? "（" + nick + "）" : ""), "退出登录"};
        new AlertDialog.Builder(this)
                .setItems(items, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) editNick();
                        else confirmLogout();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void editNick() {
        final EditText ed = new EditText(this);
        ed.setText(api.user.nickname);
        new AlertDialog.Builder(this)
                .setTitle("修改昵称")
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        final String n = ed.getText().toString().trim();
                        if (n.length() == 0) return;
                        new Thread(new Runnable() {
                            public void run() {
                                try {
                                    api.setNickname(n);
                                    store.updateNick(api.user.username, n);
                                    runOnUiThread(new Runnable() {
                                        public void run() { toast("昵称已更新"); }
                                    });
                                } catch (final Exception e) {
                                    runOnUiThread(new Runnable() {
                                        public void run() {
                                            toast(e.getMessage() == null ? "修改失败" : e.getMessage());
                                        }
                                    });
                                }
                            }
                        }).start();
                    }
                })
                .show();
    }

    private void confirmLogout() {
        new AlertDialog.Builder(this)
                .setTitle("退出登录")
                .setMessage("确定退出吗？记住密码的账号仍会保留。")
                .setNegativeButton("取消", null)
                .setPositiveButton("退出", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        new Thread(new Runnable() {
                            public void run() {
                                api.logout();
                                store.setToken("");
                                store.setAutoUser("");
                                runOnUiThread(new Runnable() {
                                    public void run() { gotoLogin(); }
                                });
                            }
                        }).start();
                    }
                })
                .show();
    }

    /* ---------------- 杂项 ---------------- */

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
            return;
        }
        lastBackAt = now;
        toast("再按一次退出轻聊");
    }
}
