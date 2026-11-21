package com.qingliao.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 消息列表适配器：三种行类型（对方 / 自己 / 系统通知）。
 * 气泡全部是原生 TextView + 圆角背景，没有任何 WebView。
 */
public class MsgAdapter extends BaseAdapter {

    private static final int TYPE_OTHER = 0;
    private static final int TYPE_MINE = 1;
    private static final int TYPE_SYSTEM = 2;

    public interface Listener {
        void onFileClick(Api.Message m);
        void onMessageLongClick(Api.Message m);
    }

    private final LayoutInflater inflater;
    private final List<Api.Message> data = new ArrayList<Api.Message>();
    private final Listener listener;
    private final AvatarLoader avatars;
    private int maxBubbleWidth;

    /** 上一条消息的发送者：用来合并连续消息的昵称与头像 */
    private final List<Boolean> showHeader = new ArrayList<Boolean>();

    public MsgAdapter(Context ctx, Listener l, AvatarLoader avatarLoader) {
        inflater = LayoutInflater.from(ctx);
        listener = l;
        avatars = avatarLoader;
        int screen = ctx.getResources().getDisplayMetrics().widthPixels;
        maxBubbleWidth = (int) (screen * 0.70f);
    }

    public void setData(List<Api.Message> list) {
        data.clear();
        if (list != null) data.addAll(list);
        rebuildHeader();
        notifyDataSetChanged();
    }

    public void append(Api.Message m) {
        data.add(m);
        rebuildHeader();
        notifyDataSetChanged();
    }

    public List<Api.Message> data() { return data; }

    private void rebuildHeader() {
        showHeader.clear();
        String last = null;
        for (int i = 0; i < data.size(); i++) {
            Api.Message m = data.get(i);
            if ("system".equals(m.kind)) {
                showHeader.add(Boolean.FALSE);
                last = null;
                continue;
            }
            boolean show = !m.mine && !m.senderId.equals(last == null ? "" : last);
            showHeader.add(Boolean.valueOf(show));
            last = m.mine ? "" : m.senderId;
        }
    }

    public int getCount() { return data.size(); }
    public Api.Message getItem(int i) { return data.get(i); }
    public long getItemId(int i) { return i; }

    public int getViewTypeCount() { return 3; }

    public int getItemViewType(int position) {
        Api.Message m = data.get(position);
        if ("system".equals(m.kind)) return TYPE_SYSTEM;
        return m.mine ? TYPE_MINE : TYPE_OTHER;
    }

    private static String fmtSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        return String.format("%.1f MB", bytes / 1024.0 / 1024.0);
    }

    private String bubbleText(Api.Message m) {
        if (m.recalled) return "这条消息已被撤回";
        if (m.hasFile) {
            if (m.file.deleted) return "[文件已删除]";
            return "📄 " + m.file.name + "\n" + fmtSize(m.file.size) + " · 点击保存";
        }
        return m.content;
    }

    public View getView(int position, View convertView, ViewGroup parent) {
        final Api.Message m = data.get(position);
        int type = getItemViewType(position);
        View v = convertView;

        if (type == TYPE_SYSTEM) {
            if (v == null || v.getTag() == null || !(v.getTag() instanceof Integer)) {
                v = inflater.inflate(R.layout.item_msg_system, parent, false);
                v.setTag(Integer.valueOf(TYPE_SYSTEM));
            }
            TextView tv = (TextView) v.findViewById(R.id.tvSystem);
            tv.setText(m.content);
            return v;
        }

        if (type == TYPE_MINE) {
            if (v == null || !Integer.valueOf(TYPE_MINE).equals(v.getTag())) {
                v = inflater.inflate(R.layout.item_msg_mine, parent, false);
                v.setTag(Integer.valueOf(TYPE_MINE));
            }
            TextView bubble = (TextView) v.findViewById(R.id.bubble);
            bubble.setText(bubbleText(m));
            bubble.setMaxWidth(maxBubbleWidth);
            bubble.setAlpha(m.recalled ? 0.6f : 1f);
            bindActions(bubble, m);
            return v;
        }

        if (v == null || !Integer.valueOf(TYPE_OTHER).equals(v.getTag())) {
            v = inflater.inflate(R.layout.item_msg_other, parent, false);
            v.setTag(Integer.valueOf(TYPE_OTHER));
        }
        FrameLayout avatarBox = (FrameLayout) v.findViewById(R.id.avatarBox);
        TextView avatar = (TextView) v.findViewById(R.id.avatar);
        final ImageView avatarImg = (ImageView) v.findViewById(R.id.avatarImg);
        TextView name = (TextView) v.findViewById(R.id.tvName);
        TextView bubble = (TextView) v.findViewById(R.id.bubble);

        boolean show = position < showHeader.size() && showHeader.get(position).booleanValue();
        String nick = TextUtils.isEmpty(m.senderName) ? "?" : m.senderName;

        if (show) {
            avatarBox.setVisibility(View.VISIBLE);
            name.setVisibility(View.VISIBLE);
            avatar.setText(nick.substring(0, Math.min(2, nick.length())));
            name.setText(nick);
            if (m.senderFounder) name.setTextColor(0xFFB48214);
            else name.setTextColor(0xFF6E7681);

            /* 头像底色按发送者 id 稳定取色，和网页端一致的做法 */
            int hash = m.senderId == null ? 0 : m.senderId.hashCode();
            int hue = Math.abs(hash) % 360;
            float[] hsv = new float[]{hue, 0.52f, 0.72f};
            GradientDrawable g = new GradientDrawable();
            g.setShape(GradientDrawable.OVAL);
            g.setColor(android.graphics.Color.HSVToColor(hsv));
            avatarBox.setBackgroundDrawable(g);
            avatar.setBackgroundDrawable(null);
            avatar.setTextColor(0xFFFFFFFF);

            /* 真实头像：缓存命中立刻盖上去，没命中就后台下好再刷（失败保持色块+首字） */
            String av = m.senderAvatar;
            avatarImg.setTag(av == null ? "" : av);
            Bitmap hit = (avatars == null || av == null || av.length() == 0) ? null : avatars.peek(av);
            if (hit != null) {
                avatarImg.setImageBitmap(hit);
                avatarImg.setVisibility(View.VISIBLE);
            } else {
                avatarImg.setImageDrawable(null);
                avatarImg.setVisibility(View.GONE);
                if (avatars != null && av != null && av.length() > 0) {
                    final String want = av;
                    avatars.load(want, new AvatarLoader.Callback() {
                        public void onLoaded(String path, Bitmap bmp) {
                            // 复用行可能已经被滚去别的消息了，url 对上才画，防错位
                            if (path.equals(avatarImg.getTag())) {
                                avatarImg.setImageBitmap(bmp);
                                avatarImg.setVisibility(View.VISIBLE);
                            }
                        }
                    });
                }
            }
        } else {
            avatarBox.setVisibility(View.INVISIBLE);
            name.setVisibility(View.GONE);
        }

        LinearLayout.LayoutParams lp =
                (LinearLayout.LayoutParams) bubble.getLayoutParams();
        if (lp == null) lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        if (show) {
            lp.topMargin = (int) (3 * parent.getResources().getDisplayMetrics().density);
        } else {
            lp.topMargin = 0;
        }
        bubble.setLayoutParams(lp);

        bubble.setText(bubbleText(m));
        bubble.setMaxWidth(maxBubbleWidth);
        bubble.setAlpha(m.recalled ? 0.6f : 1f);
        bindActions(bubble, m);
        return v;
    }

    private void bindActions(TextView bubble, final Api.Message m) {
        bubble.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (m.hasFile && !m.file.deleted && listener != null) {
                    listener.onFileClick(m);
                }
            }
        });
        bubble.setOnLongClickListener(new View.OnLongClickListener() {
            public boolean onLongClick(View v) {
                if (listener != null) listener.onMessageLongClick(m);
                return true;
            }
        });
    }
}
