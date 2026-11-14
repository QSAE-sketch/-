'use strict';
/**
 * 数据模型定义 + 集合读写封装。
 *
 * 集合（namespace）与索引：
 *   users      k1=username(lower)          账号唯一
 *   sessions   k1=token                     登录态
 *   rooms      k1=kind, k2=ownerId          public / group / dm
 *   members    k1=roomId, k2=userId         房间成员（含官职角色）
 *   messages   k1=roomId, k2=seq            消息（按房间取）
 *   files      k1=roomId, k2=ownerId        文件元数据
 *   hidden     k1=userId, k2=targetId       删除（仅本账号隐藏）
 *   friendReqs k1=fromId, k2=toId           好友请求
 *   friendIdx  k1=userId                    -> 好友关系双向索引
 *   shares     k1=userId, k2=fileId         网盘分享链接（网盘复用 files 集合，不另存文件）
 */

const { randomId, now } = require('./util');

const ROOM_PUBLIC = 'public';
const ROOM_GROUP = 'group';
const ROOM_DM = 'dm';

/** 群管理权限体系：按古代官职命名，权限逐级递减 */
const ROLES = {
  owner: { key: 'owner', name: '群主', rank: 4, canAppoint: ['admin', 'subadmin', 'junior'], appointLimit: 3 },
  admin: { key: 'admin', name: '丞相', rank: 3, canAppoint: ['subadmin'], appointLimit: 2 },
  subadmin: { key: 'subadmin', name: '县令', rank: 2, canAppoint: ['junior'], appointLimit: 2 },
  junior: { key: 'junior', name: '乡长', rank: 1, canAppoint: [], appointLimit: 0 },
  member: { key: 'member', name: '百姓', rank: 0, canAppoint: [], appointLimit: 0 }
};

const ROLE_KEYS = Object.keys(ROLES);
const RECALL_WINDOW_MS = 2 * 60 * 1000;      // 撤回窗口 2 分钟
const MAX_FILE_SIZE = 200 * 1024 * 1024;     // 单文件上限 200MB
const MAX_ROOMS_PER_USER = 5;
const SESSION_TTL = 30 * 24 * 3600 * 1000;

function createDb(store) {
  const db = {
    store,

    // ---------- 通用 ----------
    put(ns, doc, id) {
      const k = meta(ns, doc);
      store.put(ns, id || doc.id, doc, k.k1, k.k2);
      return doc;
    },
    get(ns, id) {
      return store.get(ns, id);
    },
    del(ns, id) {
      store.del(ns, id);
    },
    list(ns) {
      return store.list(ns);
    },
    byIdx(ns, col, val) {
      return store.byIdx(ns, col, val);
    },
    countByIdx(ns, col, val) {
      return store.countByIdx(ns, col, val);
    },

    // ---------- 用户 ----------
    findUserByName(username) {
      const u = String(username || '').trim().toLowerCase();
      if (!u) return null;
      const list = this.byIdx('users', 'k1', u);
      return list[0] || null;
    },
    getUser(id) {
      return this.get('users', id);
    },
    /**
     * 新建用户。
     * @param {string} username  登录名（账号+密码方式下由用户自定；其它方式用邮箱/手机号/云账号）
     * @param {string} password  明文密码（可为空，表示该账号没有本地密码）
     * @param {string} nickname  昵称
     * @param {object} [extra]   { authType, email, phone, cloudId }
     */
    createUser(username, password, nickname, extra) {
      const name = String(username || '').trim();
      const ex = extra || {};
      const doc = {
        id: randomId('u_'),
        username: name,
        usernameLower: name.toLowerCase(),
        nickname: String(nickname || name).slice(0, 24),
        salt: '',
        passHash: '',
        // 账号来源：password（账号+密码） / email / otp / workbuddy
        authType: ex.authType || 'password',
        email: ex.email ? String(ex.email).trim().toLowerCase() : '',
        phone: ex.phone ? String(ex.phone).trim() : '',
        cloudId: ex.cloudId ? String(ex.cloudId) : '',
        createdAt: now(),
        lastSeen: now()
      };
      return this.put('users', doc);
    },

    /* ---------- 按外部身份查找（邮箱 / 手机号 / 云账号） ---------- */
    /**
     * users 集合没有 email/phone 的索引列，而用户量级很小（轻聊是个人/小圈子应用），
     * 全表扫描的成本可以忽略，换来的是「不改动既有 k1/k2 索引语义」的稳妥。
     */
    findUserByEmail(email) {
      const e = String(email || '').trim().toLowerCase();
      if (!e) return null;
      const list = this.list('users');
      for (let i = 0; i < list.length; i++) {
        if (list[i].email && list[i].email === e) return list[i];
      }
      return null;
    },
    findUserByPhone(phone) {
      const p = String(phone || '').trim();
      if (!p) return null;
      const list = this.list('users');
      for (let i = 0; i < list.length; i++) {
        if (list[i].phone && list[i].phone === p) return list[i];
      }
      return null;
    },
    findUserByCloudId(cloudId) {
      const c = String(cloudId || '').trim();
      if (!c) return null;
      const list = this.list('users');
      for (let i = 0; i < list.length; i++) {
        if (list[i].cloudId && list[i].cloudId === c) return list[i];
      }
      return null;
    },

    // ---------- 会话 ----------
    createSession(userId) {
      const { randomToken } = require('./util');
      const doc = {
        id: randomToken(),
        userId,
        createdAt: now(),
        expiresAt: now() + SESSION_TTL
      };
      this.put('sessions', doc);
      return doc;
    },
    getSession(token) {
      if (!token) return null;
      const s = this.get('sessions', token);
      if (!s) return null;
      if (s.expiresAt < now()) {
        this.del('sessions', token);
        return null;
      }
      return s;
    },
    dropSession(token) {
      this.del('sessions', token);
    },

    // ---------- 房间 ----------
    getRoom(id) {
      return this.get('rooms', id);
    },
    createRoom(kind, name, ownerId, passwordHash) {
      const doc = {
        id: kind === ROOM_DM ? randomId('dm_') : randomId('r_'),
        kind,
        name: String(name || '').slice(0, 40),
        ownerId: ownerId || null,
        passwordHash: passwordHash || null,
        createdAt: now()
      };
      return this.put('rooms', doc);
    },
    listGroupRoomsOf(ownerId) {
      return this.byIdx('rooms', 'k2', ownerId).filter((r) => r.kind === ROOM_GROUP);
    },
    listRooms() {
      return this.list('rooms');
    },
    publicRoom() {
      const rooms = this.byIdx('rooms', 'k1', ROOM_PUBLIC);
      if (rooms[0]) return rooms[0];
      const doc = this.createRoom(ROOM_PUBLIC, '公共聊天室', null, null);
      doc.kind = ROOM_PUBLIC;
      return this.put('rooms', doc);
    },

    // ---------- 成员 ----------
    memberId(roomId, userId) {
      return roomId + ':' + userId;
    },
    getMember(roomId, userId) {
      return this.get('members', this.memberId(roomId, userId));
    },
    membersOf(roomId) {
      return this.byIdx('members', 'k1', roomId);
    },
    addMember(roomId, userId, role) {
      const existing = this.getMember(roomId, userId);
      if (existing) return existing;
      const doc = {
        id: this.memberId(roomId, userId),
        roomId,
        userId,
        role: role || 'member',
        appointedBy: null,      // 由谁任命（用于"每人任命上限"统计）
        joinedAt: now(),
        mutedUntil: 0,
        mutedReason: ''
      };
      return this.put('members', doc);
    },
    updateMember(roomId, userId, patch) {
      const m = this.getMember(roomId, userId);
      if (!m) return null;
      Object.assign(m, patch);
      return this.put('members', m);
    },
    removeMember(roomId, userId) {
      const id = this.memberId(roomId, userId);
      if (this.get('members', id)) this.del('members', id);
    },
    isMember(roomId, userId) {
      return !!this.getMember(roomId, userId);
    },

    // ---------- 消息 ----------
    seqNo() {
      const cur = this.get('meta', 'seq') || { id: 'seq', value: 0 };
      cur.value += 1;
      this.put('meta', cur);
      return cur.value;
    },
    createMessage(roomId, senderId, payload) {
      const seq = this.seqNo();
      const doc = {
        id: randomId('m_'),
        roomId,
        senderId,
        kind: payload.kind || 'text',
        content: payload.content || '',
        fileId: payload.fileId || null,
        recalled: false,
        createdAt: now(),
        seq,
        rev: seq            // rev 用于增量拉取（撤回等变更也会推进）
      };
      return this.put('messages', doc);
    },
    /** 推进全局修订号，让"撤回"这类修改也能被其他端增量拉到 */
    bumpRev() {
      return this.seqNo();
    },
    getMessage(id) {
      return this.get('messages', id);
    },
    messagesOf(roomId) {
      const list = this.byIdx('messages', 'k1', roomId);
      list.sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq));
      return list;
    },
    updateMessage(doc) {
      return this.put('messages', doc);
    },
    deleteMessage(id) {
      this.del('messages', id);
    },

    // ---------- 隐藏（仅本账号删除） ----------
    hiddenKey(userId, targetId) {
      return userId + ':' + targetId;
    },
    hide(userId, targetId, type) {
      const doc = {
        id: this.hiddenKey(userId, targetId),
        userId,
        targetId,
        type,
        createdAt: now()
      };
      this.put('hidden', doc);
      return doc;
    },
    isHidden(userId, targetId) {
      return !!this.get('hidden', this.hiddenKey(userId, targetId));
    },
    hiddenSet(userId) {
      const set = new Set();
      this.byIdx('hidden', 'k1', userId).forEach((h) => set.add(h.targetId));
      return set;
    },

    // ---------- 文件 ----------
    getFile(id) {
      return this.get('files', id);
    },
    createFile(ownerId, roomId, name, size, mime, chunkSize) {
      const { randomToken } = require('./util');
      const doc = {
        id: randomId('f_'),
        accessToken: randomToken(),    // 独立访问令牌（供 <img>/<video> 直连）
        ownerId,
        roomId,
        name: String(name || 'file'),
        size: Number(size) || 0,
        mime: String(mime || 'application/octet-stream'),
        chunkSize: Number(chunkSize) || (2 * 1024 * 1024),
        received: [],
        sha256: '',
        state: 'uploading',
        createdAt: now(),
        readyAt: 0
      };
      return this.put('files', doc);
    },
    updateFile(doc) {
      return this.put('files', doc);
    },
    filesOf(roomId) {
      return this.byIdx('files', 'k1', roomId);
    },
    filesOfOwner(ownerId) {
      return this.byIdx('files', 'k2', ownerId);
    },

    // ---------- 好友 ----------
    friendPairKey(a, b) {
      return [a, b].sort().join('~');
    },
    createFriendRequest(fromId, toId, message) {
      const doc = {
        id: randomId('fr_'),
        fromId,
        toId,
        status: 'pending',
        // 申请附言（打招呼的话），最多 200 字
        message: String(message === undefined || message === null ? '' : message).slice(0, 200),
        createdAt: now()
      };
      this.put('friendReqs', doc);
      return doc;
    },
    getFriendRequest(id) {
      return this.get('friendReqs', id);
    },
    incomingRequests(userId) {
      return this.byIdx('friendReqs', 'k2', userId).filter((r) => r.status === 'pending');
    },
    outgoingRequests(userId) {
      return this.byIdx('friendReqs', 'k1', userId).filter((r) => r.status === 'pending');
    },
    listFriendRequestsOf(userId) {
      return this.byIdx('friendReqs', 'k1', userId).concat(this.byIdx('friendReqs', 'k2', userId));
    },
    updateFriendRequest(doc) {
      return this.put('friendReqs', doc);
    },
    areFriends(a, b) {
      return !!this.get('friendIdx', this.friendPairKey(a, b));
    },
    addFriend(a, b) {
      const key = this.friendPairKey(a, b);
      this.put('friendIdx', { id: key, a, b, createdAt: now() }, key);
    },
    removeFriend(a, b) {
      this.del('friendIdx', this.friendPairKey(a, b));
    },
    /**
     * 某个用户的好友列表。
     *
     * friendIdx 一条记录里 k1=fromId、k2=toId（见 meta()），
     * 而「成为好友」时 addFriend(fromId, toId) 的顺序取决于谁先发起申请，
     * 所以只查 k1 会漏掉「后被加的那个人」。
     * 这里 k1、k2 两个方向都查一遍并按 id 去重 —— 双方看到的才是同一份好友列表。
     */
    friendsOf(userId) {
      const seen = {};
      const out = [];
      const push = (list) => {
        for (let i = 0; i < list.length; i++) {
          const id = list[i].id;
          if (seen[id]) continue;
          seen[id] = true;
          out.push(list[i]);
        }
      };
      push(this.byIdx('friendIdx', 'k1', userId));
      push(this.byIdx('friendIdx', 'k2', userId));
      return out;
    }
  };

  return db;
}

function meta(ns, doc) {
  switch (ns) {
    case 'users':
      return { k1: doc.usernameLower, k2: null };
    case 'sessions':
      return { k1: doc.id, k2: doc.userId };
    case 'rooms':
      return { k1: doc.kind, k2: doc.ownerId };
    case 'members':
      return { k1: doc.roomId, k2: doc.userId };
    case 'messages':
      return { k1: doc.roomId, k2: doc.seq };
    case 'files':
      return { k1: doc.roomId, k2: doc.ownerId };
    case 'hidden':
      return { k1: doc.userId, k2: doc.targetId };
    case 'friendReqs':
      return { k1: doc.fromId, k2: doc.toId };
    case 'friendIdx':
      return { k1: doc.a, k2: doc.b };
    // 网盘分享：k1=userId（我的分享列表），k2=fileId（某文件是否已被分享）
    case 'shares':
      return { k1: doc.userId, k2: doc.fileId };
    default:
      return { k1: null, k2: null };
  }
}

module.exports = {
  createDb,
  ROLES,
  ROLE_KEYS,
  ROOM_PUBLIC,
  ROOM_GROUP,
  ROOM_DM,
  RECALL_WINDOW_MS,
  MAX_FILE_SIZE,
  MAX_ROOMS_PER_USER,
  SESSION_TTL
};
