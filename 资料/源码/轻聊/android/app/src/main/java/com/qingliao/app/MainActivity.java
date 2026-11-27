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
    private AvatarLoader avatars;

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

        avatars = new AvatarLoader(api, 96);
        adapter = new MsgAdapter(this, this, avatars);
        list.setAdapter(adapter);

        btnRooms.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showRooms(); }
        });
        tvTitle.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { showMembers(); }
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

    /** 后台跑一个网络任务，主线程回调结果（统一错误处理） */
    private interface BgCall { void run() throws Exception; }
    private interface BgDone { void onDone(String error); }
    private void bg(final BgCall call, final BgDone done) {
        new Thread(new Runnable() {
            public void run() {
                final String[] err = new String[1];
                try { call.run(); } catch (Exception e) {
                    err[0] = e.getMessage() == null ? "操作失败" : e.getMessage();
                }
                runOnUiThread(new Runnable() {
                    public void run() { done.onDone(err[0]); }
                });
            }
        }).start();
    }
    private void errToast(String e) {
        if (e != null) toast(e);
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
        // 会话列表 = 公共聊天室 / 群聊 + 最下面的「好友私聊」。私聊本身不是房间，
        // 不会出现在上面这些房间项里，只从这里进入（像微信的会话列表）。
        final String[] names = new String[rooms.size() + 1];
        for (int i = 0; i < rooms.size(); i++) {
            Api.Room r = rooms.get(i);
            String tag = "public".equals(r.kind) ? "公共" : (r.memberCount + " 人");
            names[i] = r.name + "　（" + tag + "）";
        }
        names[rooms.size()] = "👤 好友与私聊…";
        new AlertDialog.Builder(this)
                .setTitle("选择聊天")
                .setItems(names, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == rooms.size()) { showFriends(); return; }
                        openRoom(rooms.get(which));
                    }
                })
                .setNeutralButton("更多（搜索 / 新建）", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) { showRoomTools(); }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /** 房间工具：搜索房间 / 新建房间 / 搜索用户加好友 */
    private void showRoomTools() {
        final String[] items = {"🔍 搜索房间并加入", "➕ 新建房间", "👤 搜索用户加好友"};
        new AlertDialog.Builder(this)
                .setTitle("发现")
                .setItems(items, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) searchRoomDialog();
                        else if (which == 1) newRoom();
                        else searchUserDialog();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /** 好友中心：收到的申请 → 好友列表（点一下私聊）→ 我发出的 → 搜索加好友 */
    private void showFriends() {
        toast("正在加载好友…");
        bg(new BgCall() {
            public void run() throws Exception { friendData = api.friendData(); }
        }, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast("加载好友失败：" + e); return; }
                final Api.FriendData d = friendData;
                List<String> rows = new ArrayList<String>();
                for (int i = 0; i < d.incoming.size(); i++) {
                    Api.FriendReq r = d.incoming.get(i);
                    rows.add("🔔 申请：" + r.nickname + "（" + r.username + "）");
                }
                for (int i = 0; i < d.friends.size(); i++) {
                    Api.Friend f = d.friends.get(i);
                    rows.add("💬 " + f.nickname + "（" + f.username + "）");
                }
                for (int i = 0; i < d.outgoing.size(); i++) {
                    Api.FriendReq r = d.outgoing.get(i);
                    rows.add("⏳ 已申请：" + r.nickname);
                }
                if (rows.isEmpty()) rows.add("还没有好友，点「加好友」搜索");
                final String[] names = rows.toArray(new String[0]);
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("好友与私聊")
                        .setItems(names, new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface dialog, int which) {
                                handleFriendRow(d, which);
                            }
                        })
                        .setPositiveButton("加好友", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface dd, int w) { searchUserDialog(); }
                        })
                        .setNegativeButton("取消", null)
                        .show();
            }
        });
    }

    private Api.FriendData friendData;

    /** 好友行点击：收到的申请弹处理框，好友直接进私聊 */
    private void handleFriendRow(final Api.FriendData d, int which) {
        int i = which;
        if (i < d.incoming.size()) {
            final Api.FriendReq req = d.incoming.get(i);
            String msg = req.message.length() > 0 ? ("\n留言：" + req.message) : "";
            new AlertDialog.Builder(this)
                    .setTitle("好友申请")
                    .setMessage(req.nickname + "（" + req.username + "）想加你好友" + msg)
                    .setPositiveButton("同意", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface dd, int w) {
                            bg(new BgCall() {
                                public void run() throws Exception { api.acceptFriend(req.id); }
                            }, new BgDone() {
                                public void onDone(String e) {
                                    errToast(e);
                                    if (e == null) { toast("已添加好友"); showFriends(); }
                                }
                            });
                        }
                    })
                    .setNegativeButton("拒绝", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface dd, int w) {
                            bg(new BgCall() {
                                public void run() throws Exception { api.rejectFriend(req.id); }
                            }, new BgDone() {
                                public void onDone(String e) { errToast(e); if (e == null) showFriends(); }
                            });
                        }
                    })
                    .setNeutralButton("取消", null)
                    .show();
            return;
        }
        i -= d.incoming.size();
        if (i < d.friends.size()) { openDm(d.friends.get(i)); return; }
        // 发出的申请：提示等待
        toast("等待对方同意好友申请");
    }

    /** 搜索用户加好友 */
    private void searchUserDialog() {
        final EditText ed = new EditText(this);
        ed.setHint("对方账号名或昵称");
        ed.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle("搜索用户")
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("搜索", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        final String q = ed.getText().toString().trim();
                        if (q.length() == 0) return;
                        doSearchUser(q);
                    }
                })
                .show();
    }

    private void doSearchUser(final String q) {
        bg(new BgCall() {
            public void run() throws Exception { searchedUsers = api.searchUsers(q); }
        }, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast("搜索失败：" + e); return; }
                final List<Api.Friend> us = searchedUsers;
                if (us.isEmpty()) { toast("没有找到匹配的用户"); return; }
                String[] names = new String[us.size()];
                for (int i = 0; i < us.size(); i++) names[i] = us.get(i).nickname + "（" + us.get(i).username + "）";
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("搜索结果")
                        .setItems(names, new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface dd, int which) {
                                sendFriendRequest(us.get(which).username);
                            }
                        })
                        .setNegativeButton("取消", null)
                        .show();
            }
        });
    }

    private List<Api.Friend> searchedUsers = new ArrayList<Api.Friend>();

    private void sendFriendRequest(final String username) {
        final EditText ed = new EditText(this);
        ed.setHint("附言（可选）");
        new AlertDialog.Builder(this)
                .setTitle("加好友：" + username)
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("发送申请", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dd, int w) {
                        final String msg = ed.getText().toString().trim();
                        bg(new BgCall() {
                            public void run() throws Exception { api.requestFriend(username, msg); }
                        }, new BgDone() {
                            public void onDone(String e) {
                                if (e != null) { toast("申请失败：" + e); return; }
                                toast("已发送好友申请");
                            }
                        });
                    }
                })
                .show();
    }

    /** 打开与某位好友的私聊会话 */
    private void openDm(final Api.Friend f) {
        toast("正在打开与「" + f.nickname + "」的私聊…");
        new Thread(new Runnable() {
            public void run() {
                try {
                    final Api.Room r = api.dm(f.id);
                    runOnUiThread(new Runnable() {
                        public void run() {
                            if (r == null || r.id == null || r.id.length() == 0) {
                                toast("打开私聊失败");
                                return;
                            }
                            if (r.name == null || r.name.length() == 0) r.name = f.nickname;
                            openRoom(r);
                        }
                    });
                } catch (final Exception e) {
                    final String msg = (e instanceof Api.ApiException)
                            ? ((Api.ApiException) e).getMessage() : String.valueOf(e.getMessage());
                    runOnUiThread(new Runnable() {
                        public void run() { toast("打开私聊失败：" + msg); }
                    });
                }
            }
        }).start();
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

    /** 搜索房间：结果里点一个，已加入直接进，未加入则加入（密码房先验证） */
    private void searchRoomDialog() {
        final EditText ed = new EditText(this);
        ed.setHint("房间名称关键词");
        ed.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle("搜索房间")
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("搜索", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        final String q = ed.getText().toString().trim();
                        if (q.length() == 0) return;
                        doSearchRoom(q);
                    }
                })
                .show();
    }

    private void doSearchRoom(final String q) {
        bg(new BgCall() {
            public void run() throws Exception { searchedRooms = api.searchRooms(q); }
        }, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast("搜索失败：" + e); return; }
                final List<Api.SearchRoom> rs = searchedRooms;
                if (rs.isEmpty()) { toast("没有找到匹配的房间"); return; }
                String[] names = new String[rs.size()];
                for (int i = 0; i < rs.size(); i++) {
                    Api.SearchRoom s = rs.get(i);
                    names[i] = s.name + "　（" + s.memberCount + " 人"
                            + (s.hasPassword ? " · 需密码" : "") + (s.joined ? " · 已加入" : "") + "）";
                }
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("搜索结果")
                        .setItems(names, new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface dd, int which) { joinOrOpen(rs.get(which)); }
                        })
                        .setNegativeButton("取消", null)
                        .show();
            }
        });
    }

    private List<Api.SearchRoom> searchedRooms = new ArrayList<Api.SearchRoom>();

    private void joinOrOpen(final Api.SearchRoom s) {
        if (s.joined) {
            Api.Room r = new Api.Room();
            r.id = s.id; r.name = s.name; r.kind = s.kind;
            r.memberCount = s.memberCount; r.joined = true;
            openRoom(r);
            return;
        }
        if (s.hasPassword) {
            final EditText ed = new EditText(this);
            ed.setHint("房间密码");
            ed.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
            new AlertDialog.Builder(this)
                    .setTitle("输入房间密码")
                    .setView(ed)
                    .setNegativeButton("取消", null)
                    .setPositiveButton("加入", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface dd, int w) {
                            doJoinRoom(s, ed.getText().toString());
                        }
                    })
                    .show();
        } else {
            doJoinRoom(s, "");
        }
    }

    private void doJoinRoom(final Api.SearchRoom s, final String password) {
        bg(new BgCall() {
            public void run() throws Exception {
                if (password.length() > 0) api.verifyRoom(s.id, password);
                api.joinRoom(s.id);
            }
        }, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast("加入失败：" + e); return; }
                toast("已加入房间");
                loadRooms();
                Api.Room r = new Api.Room();
                r.id = s.id; r.name = s.name; r.kind = s.kind;
                r.joined = true;
                openRoom(r);
            }
        });
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
        if (resultCode != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri == null) return;
        if (requestCode == REQ_PICK_FILE) uploadUri(uri);
        else if (requestCode == REQ_PICK_AVATAR) uploadAvatar(uri);
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

    /* ---------------- 成员管理 ---------------- */

    private void showMembers() {
        if (roomId.length() == 0) return;
        bg(new BgCall() {
            public void run() throws Exception { memberPage = api.members(roomId); }
        }, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast("加载成员失败：" + e); return; }
                showMembersDialog(memberPage);
            }
        });
    }

    private Api.MemberPage memberPage;

    private void showMembersDialog(final Api.MemberPage p) {
        List<String> rows = new ArrayList<String>();
        for (int i = 0; i < p.members.size(); i++) {
            Api.Member m = p.members.get(i);
            rows.add(m.displayName + "　（" + m.roleName + "）");
        }
        final String[] names = rows.toArray(new String[0]);
        AlertDialog.Builder b = new AlertDialog.Builder(this).setTitle("成员（" + p.members.size() + "）");
        if (names.length > 0) {
            b.setItems(names, new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int which) { memberAction(p, p.members.get(which)); }
            });
        } else {
            b.setMessage("暂无成员");
        }
        // 群主/管理才显示管理动作；解散按服务端 canDissolve 判断
        if (p.canManage) {
            b.setNeutralButton("管理", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { showManageMenu(p); }
            });
        }
        b.setNegativeButton("关闭", null).show();
    }

    private void memberAction(final Api.MemberPage p, final Api.Member m) {
        if (!p.canManage) { toast("只有管理才能操作成员"); return; }
        final String[] acts = {"设为继承人", "禁言 10 分钟", "禁言 1 天", "踢出房间", "转让群主"};
        new AlertDialog.Builder(this)
                .setTitle(m.displayName + "（" + m.roleName + "）")
                .setItems(acts, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) memberTask("设置继承人", new BgCall() {
                            public void run() throws Exception { api.setHeir(roomId, m.userId); }
                        });
                        else if (which == 1) memberTask("禁言 10 分钟", new BgCall() {
                            public void run() throws Exception { api.setMute(roomId, m.userId, 10); }
                        });
                        else if (which == 2) memberTask("禁言 1 天", new BgCall() {
                            public void run() throws Exception { api.setMute(roomId, m.userId, 1440); }
                        });
                        else if (which == 3) memberTask("踢出", new BgCall() {
                            public void run() throws Exception { api.kickMember(roomId, m.userId); }
                        });
                        else memberTask("转让群主", new BgCall() {
                            public void run() throws Exception { api.transferOwner(roomId, m.userId); }
                        });
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void memberTask(final String label, final BgCall call) {
        bg(call, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast(label + "失败：" + e); return; }
                toast("已" + label);
                showMembers();
            }
        });
    }

    private void showManageMenu(final Api.MemberPage p) {
        List<String> items = new ArrayList<String>();
        items.add("修改我在本房间的昵称");
        if (p.canDissolve) items.add(p.publicHall ? "解散公共大厅" : "解散房间");
        final String[] arr = items.toArray(new String[0]);
        new AlertDialog.Builder(this)
                .setTitle("房间管理")
                .setItems(arr, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) roomNickDialog(p);
                        else confirmDissolve();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void roomNickDialog(final Api.MemberPage p) {
        final EditText ed = new EditText(this);
        ed.setText(p.myRoomNickname);
        ed.setHint("留空恢复全局昵称");
        new AlertDialog.Builder(this)
                .setTitle("本房间昵称")
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        final String nick = ed.getText().toString().trim();
                        bg(new BgCall() {
                            public void run() throws Exception { api.setRoomNickname(roomId, nick); }
                        }, new BgDone() {
                            public void onDone(String e) {
                                errToast(e);
                                if (e == null) { toast("已更新"); loadMessages(false); }
                            }
                        });
                    }
                })
                .show();
    }

    private void confirmDissolve() {
        new AlertDialog.Builder(this)
                .setTitle("解散房间")
                .setMessage("解散后仅保留历史消息，不可恢复。确定解散吗？")
                .setNegativeButton("取消", null)
                .setPositiveButton("解散", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        bg(new BgCall() {
                            public void run() throws Exception { api.dissolveRoom(roomId); }
                        }, new BgDone() {
                            public void onDone(String e) {
                                if (e != null) { toast("解散失败：" + e); return; }
                                toast("已解散");
                                loadRooms();
                                loadMessages(true);
                            }
                        });
                    }
                })
                .show();
    }

    /* ---------------- 我的 ---------------- */

    private void showMe() {
        String nick = api.user.nickname.length() > 0 ? api.user.nickname : "";
        final String[] items = {
                "修改昵称" + (nick.length() > 0 ? "（" + nick + "）" : ""),
                "更换头像",
                "🔑 激活最高权限",
                "📜 历史更新记录 / 公告",
                "在线人数 / 服务器",
                "退出登录",
                "注销账号（不可恢复）"
        };
        new AlertDialog.Builder(this)
                .setTitle("我的")
                .setItems(items, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        switch (which) {
                            case 0: editNick(); break;
                            case 1: avatarDialog(); break;
                            case 2: permDialog(); break;
                            case 3: showChangelog(); break;
                            case 4: showServerInfo(); break;
                            case 5: confirmLogout(); break;
                            case 6: confirmDeleteAccount(); break;
                        }
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /* ---------------- 头像 ---------------- */

    private static final int REQ_PICK_AVATAR = 2002;
    private Uri pendingAvatarUri;

    private void avatarDialog() {
        final String[] acts = api.user.avatar.length() > 0
                ? new String[]{"从相册选择新头像", "恢复默认头像"}
                : new String[]{"从相册选择新头像"};
        new AlertDialog.Builder(this)
                .setTitle("头像")
                .setItems(acts, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) {
                            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                            i.setType("image/*");
                            i.addCategory(Intent.CATEGORY_OPENABLE);
                            try {
                                startActivityForResult(Intent.createChooser(i, "选择头像"), REQ_PICK_AVATAR);
                            } catch (Exception e) { toast("没有可用的图片选择器"); }
                        } else {
                            bg(new BgCall() {
                                public void run() throws Exception { api.clearAvatar(); }
                            }, new BgDone() {
                                public void onDone(String e) {
                                    errToast(e);
                                    if (e == null) toast("已恢复默认头像");
                                }
                            });
                        }
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void uploadAvatar(final Uri uri) {
        final String name = displayName(uri);
        String mime = "image/jpeg";
        String low = name.toLowerCase();
        if (low.endsWith(".png")) mime = "image/png";
        else if (low.endsWith(".gif")) mime = "image/gif";
        else if (low.endsWith(".webp")) mime = "image/webp";
        final String finalMime = mime;
        bg(new BgCall() {
            public void run() throws Exception {
                File tmp = new File(getCacheDir(), "avatar_" + System.currentTimeMillis());
                InputStream is = getContentResolver().openInputStream(uri);
                if (is == null) throw new Exception("无法读取图片");
                OutputStream os = new FileOutputStream(tmp);
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                os.close(); is.close();
                try { api.setAvatar(tmp, finalMime); }
                finally { tmp.delete(); }
            }
        }, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast("上传失败：" + e); return; }
                toast("头像已更新");
            }
        });
    }

    /* ---------------- 最高权限 ---------------- */

    private void permDialog() {
        final EditText ed = new EditText(this);
        ed.setHint("权限密钥");
        ed.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        new AlertDialog.Builder(this)
                .setTitle("激活最高权限")
                .setMessage("输入权限密钥后可管理全部房间与用户。")
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("激活", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        final String key = ed.getText().toString().trim();
                        if (key.length() == 0) return;
                        bg(new BgCall() {
                            public void run() throws Exception { api.activatePerm(key); }
                        }, new BgDone() {
                            public void onDone(String e) {
                                if (e != null) { toast("激活失败：" + e); return; }
                                toast("最高权限已激活");
                            }
                        });
                    }
                })
                .show();
    }

    /* ---------------- 版本 / 公告 ---------------- */

    private void showChangelog() {
        bg(new BgCall() {
            public void run() throws Exception { versionInfo = api.version(); }
        }, new BgDone() {
            public void onDone(String e) {
                if (e != null) { toast("获取失败：" + e); return; }
                StringBuilder sb = new StringBuilder();
                org.json.JSONObject v = versionInfo.optJSONObject("version");
                if (v != null) sb.append("当前版本：v").append(v.optString("name")).append("（").append(v.optInt("code")).append("）\n\n");
                String ann = versionInfo.optString("announcement", "");
                if (ann != null && ann.trim().length() > 0) sb.append("【公告】").append(ann).append("\n\n");
                org.json.JSONObject log = versionInfo.optJSONObject("changelog");
                if (log != null) {
                    org.json.JSONArray rels = log.optJSONArray("releases");
                    if (rels != null) {
                        int n = Math.min(6, rels.length());
                        for (int i = 0; i < n; i++) {
                            org.json.JSONObject r = rels.optJSONObject(i);
                            if (r == null) continue;
                            sb.append("v").append(r.optString("version")).append("\n");
                            org.json.JSONArray ch = r.optJSONArray("changes");
                            if (ch != null) {
                                for (int k = 0; k < ch.length(); k++) sb.append(" · ").append(ch.optString(k)).append("\n");
                            }
                            sb.append("\n");
                        }
                    }
                }
                if (sb.length() == 0) sb.append("暂无更新记录");
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("更新记录 / 公告")
                        .setMessage(sb.toString())
                        .setPositiveButton("关闭", null)
                        .show();
            }
        });
    }

    private org.json.JSONObject versionInfo;

    private void showServerInfo() {
        bg(new BgCall() {
            public void run() throws Exception { onlineNow = api.onlineCount(); }
        }, new BgDone() {
            public void onDone(String e) {
                String s = "服务器：" + api.base() + "\n公共聊天室在线：" + (e == null ? String.valueOf(onlineNow) : "获取失败");
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("在线人数 / 服务器")
                        .setMessage(s)
                        .setPositiveButton("关闭", null)
                        .show();
            }
        });
    }

    private int onlineNow = 0;

    /* ---------------- 注销账号 ---------------- */

    private void confirmDeleteAccount() {
        final EditText ed = new EditText(this);
        ed.setHint("请输入你的账号名：" + api.user.username);
        new AlertDialog.Builder(this)
                .setTitle("注销账号")
                .setMessage("账号、消息、文件、好友关系将被永久删除，不可恢复。请输入账号名确认。")
                .setView(ed)
                .setNegativeButton("取消", null)
                .setPositiveButton("确认注销", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        if (!api.user.username.equals(ed.getText().toString().trim())) {
                            toast("账号名不符，已取消");
                            return;
                        }
                        bg(new BgCall() {
                            public void run() throws Exception { api.deleteAccount(); }
                        }, new BgDone() {
                            public void onDone(String e) {
                                if (e != null) { toast("注销失败：" + e); return; }
                                store.setToken("");
                                store.forget(api.user.username);
                                toast("账号已注销");
                                gotoLogin();
                            }
                        });
                    }
                })
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
