/*
 * 轻聊原生客户端 · 极简 JSON（header-only）
 *
 * 为什么自己写：原生端不能引第三方库，也不该为解析一个响应拖进几百 KB 依赖。
 * 这里只做客户端真正需要的事：解析 UTF-8 JSON、按 key 取值、按需拼装请求体。
 * 字符串统一以 UTF-8 存放，界面层再转 UTF-16，避免两套编码到处转换。
 */
#ifndef QL_JSON_H
#define QL_JSON_H

#include <string>
#include <vector>
#include <utility>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>

namespace ql {

class Json {
public:
    enum Type { NUL, BOOL, NUM, STR, ARR, OBJ };

    Type type;
    bool bval;
    double nval;
    std::string sval;
    std::vector<Json> items;                            // 数组元素
    std::vector<std::pair<std::string, Json> > fields;  // 对象成员（保序）

    Json() : type(NUL), bval(false), nval(0) {}

    static Json null() { return Json(); }
    static Json boolean(bool v) { Json j; j.type = BOOL; j.bval = v; return j; }
    static Json number(double v) { Json j; j.type = NUM; j.nval = v; return j; }
    static Json string(const std::string& v) { Json j; j.type = STR; j.sval = v; return j; }
    static Json array() { Json j; j.type = ARR; return j; }
    static Json object() { Json j; j.type = OBJ; return j; }

    bool isNull() const { return type == NUL; }
    bool isArray() const { return type == ARR; }
    bool isObject() const { return type == OBJ; }
    bool isString() const { return type == STR; }

    size_t size() const { return type == ARR ? items.size() : fields.size(); }

    /* ---- 读取 ---- */

    const Json* find(const char* key) const {
        if (type != OBJ) return NULL;
        for (size_t i = 0; i < fields.size(); ++i) {
            if (fields[i].first == key) return &fields[i].second;
        }
        return NULL;
    }

    bool has(const char* key) const { return find(key) != NULL; }

    /* 字符串取值；字段缺失或类型不符时返回 fallback */
    std::string str(const char* key, const char* fallback = "") const {
        const Json* v = find(key);
        if (!v) return fallback;
        if (v->type == STR) return v->sval;
        if (v->type == NUM) {
            char buf[64];
            snprintf(buf, sizeof(buf), "%g", v->nval);
            return buf;
        }
        return fallback;
    }

    double num(const char* key, double fallback = 0) const {
        const Json* v = find(key);
        if (!v) return fallback;
        if (v->type == NUM) return v->nval;
        if (v->type == STR) return atof(v->sval.c_str());
        if (v->type == BOOL) return v->bval ? 1 : 0;
        return fallback;
    }

    long long i64(const char* key, long long fallback = 0) const {
        return (long long)num(key, (double)fallback);
    }

    bool boolOf(const char* key, bool fallback = false) const {
        const Json* v = find(key);
        if (!v) return fallback;
        if (v->type == BOOL) return v->bval;
        if (v->type == NUM) return v->nval != 0;
        if (v->type == STR) return v->sval == "true" || v->sval == "1";
        return fallback;
    }

    /* 取子对象 / 子数组的原始 JSON 文本（用于把对象塞进另一个对象） */
    const Json* at(size_t i) const {
        return (type == ARR && i < items.size()) ? &items[i] : NULL;
    }

    /* ---- 写入 ---- */

    void set(const char* key, const Json& v) {
        if (type != OBJ) { type = OBJ; }
        for (size_t i = 0; i < fields.size(); ++i) {
            if (fields[i].first == key) { fields[i].second = v; return; }
        }
        fields.push_back(std::make_pair(std::string(key), v));
    }
    void set(const char* key, const std::string& v) { set(key, string(v)); }
    void set(const char* key, const char* v) { set(key, string(std::string(v ? v : ""))); }
    void set(const char* key, double v) { set(key, number(v)); }
    void set(const char* key, int v) { set(key, number((double)v)); }
    void set(const char* key, long long v) { set(key, number((double)v)); }
    void set(const char* key, bool v) { set(key, boolean(v)); }

    void push(const Json& v) { type = ARR; items.push_back(v); }

    /* ---- 序列化 ---- */

    std::string dump() const {
        std::string out;
        dumpTo(out);
        return out;
    }

    void dumpTo(std::string& out) const {
        switch (type) {
        case NUL: out += "null"; break;
        case BOOL: out += bval ? "true" : "false"; break;
        case NUM: {
            char buf[64];
            if (nval == (double)(long long)nval && fabs(nval) < 1e15) {
                snprintf(buf, sizeof(buf), "%lld", (long long)nval);
            } else {
                snprintf(buf, sizeof(buf), "%.10g", nval);
            }
            out += buf;
            break;
        }
        case STR: dumpString(out, sval); break;
        case ARR:
            out += '[';
            for (size_t i = 0; i < items.size(); ++i) {
                if (i) out += ',';
                items[i].dumpTo(out);
            }
            out += ']';
            break;
        case OBJ:
            out += '{';
            for (size_t i = 0; i < fields.size(); ++i) {
                if (i) out += ',';
                dumpString(out, fields[i].first);
                out += ':';
                fields[i].second.dumpTo(out);
            }
            out += '}';
            break;
        }
    }

    static void dumpString(std::string& out, const std::string& s) {
        out += '"';
        for (size_t i = 0; i < s.size(); ++i) {
            unsigned char c = (unsigned char)s[i];
            switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char)c;
                }
            }
        }
        out += '"';
    }

    /* ---- 解析 ---- */

    static bool parse(const std::string& text, Json& out) {
        size_t pos = 0;
        bool ok = parseValue(text, pos, out);
        if (!ok) return false;
        skipWs(text, pos);
        return true;  // 尾部多余空白容忍；多余内容不影响已解析结果
    }

private:
    static void skipWs(const std::string& s, size_t& p) {
        while (p < s.size()) {
            char c = s[p];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { ++p; continue; }
            // 容忍 UTF-8 BOM
            if ((unsigned char)c == 0xEF && p + 2 < s.size() &&
                (unsigned char)s[p + 1] == 0xBB && (unsigned char)s[p + 2] == 0xBF) {
                p += 3; continue;
            }
            break;
        }
    }

    static bool parseValue(const std::string& s, size_t& p, Json& out) {
        skipWs(s, p);
        if (p >= s.size()) return false;
        char c = s[p];
        if (c == '{') return parseObject(s, p, out);
        if (c == '[') return parseArray(s, p, out);
        if (c == '"') {
            out.type = STR;
            return parseString(s, p, out.sval);
        }
        if (c == 't' && s.compare(p, 4, "true") == 0) { out.type = BOOL; out.bval = true; p += 4; return true; }
        if (c == 'f' && s.compare(p, 5, "false") == 0) { out.type = BOOL; out.bval = false; p += 5; return true; }
        if (c == 'n' && s.compare(p, 4, "null") == 0) { out.type = NUL; p += 4; return true; }
        return parseNumber(s, p, out);
    }

    static bool parseObject(const std::string& s, size_t& p, Json& out) {
        out.type = OBJ;
        ++p;  // {
        skipWs(s, p);
        if (p < s.size() && s[p] == '}') { ++p; return true; }
        while (p < s.size()) {
            skipWs(s, p);
            if (p >= s.size() || s[p] != '"') return false;
            std::string key;
            if (!parseString(s, p, key)) return false;
            skipWs(s, p);
            if (p >= s.size() || s[p] != ':') return false;
            ++p;
            Json v;
            if (!parseValue(s, p, v)) return false;
            out.fields.push_back(std::make_pair(key, v));
            skipWs(s, p);
            if (p >= s.size()) return false;
            if (s[p] == ',') { ++p; continue; }
            if (s[p] == '}') { ++p; return true; }
            return false;
        }
        return false;
    }

    static bool parseArray(const std::string& s, size_t& p, Json& out) {
        out.type = ARR;
        ++p;  // [
        skipWs(s, p);
        if (p < s.size() && s[p] == ']') { ++p; return true; }
        while (p < s.size()) {
            Json v;
            if (!parseValue(s, p, v)) return false;
            out.items.push_back(v);
            skipWs(s, p);
            if (p >= s.size()) return false;
            if (s[p] == ',') { ++p; continue; }
            if (s[p] == ']') { ++p; return true; }
            return false;
        }
        return false;
    }

    static void putUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out += (char)cp;
        } else if (cp < 0x800) {
            out += (char)(0xC0 | (cp >> 6));
            out += (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += (char)(0xE0 | (cp >> 12));
            out += (char)(0x80 | ((cp >> 6) & 0x3F));
            out += (char)(0x80 | (cp & 0x3F));
        } else {
            out += (char)(0xF0 | (cp >> 18));
            out += (char)(0x80 | ((cp >> 12) & 0x3F));
            out += (char)(0x80 | ((cp >> 6) & 0x3F));
            out += (char)(0x80 | (cp & 0x3F));
        }
    }

    static unsigned hex4(const std::string& s, size_t p) {
        unsigned v = 0;
        for (int i = 0; i < 4 && p + i < s.size(); ++i) {
            char c = s[p + i];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
            else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        }
        return v;
    }

    static bool parseString(const std::string& s, size_t& p, std::string& out) {
        ++p;  // 开引号
        out.clear();
        while (p < s.size()) {
            char c = s[p];
            if (c == '"') { ++p; return true; }
            if (c == '\\') {
                ++p;
                if (p >= s.size()) return false;
                char e = s[p];
                switch (e) {
                case '"': out += '"'; ++p; break;
                case '\\': out += '\\'; ++p; break;
                case '/': out += '/'; ++p; break;
                case 'b': out += '\b'; ++p; break;
                case 'f': out += '\f'; ++p; break;
                case 'n': out += '\n'; ++p; break;
                case 'r': out += '\r'; ++p; break;
                case 't': out += '\t'; ++p; break;
                case 'u': {
                    unsigned cp = hex4(s, p + 1);
                    p += 5;
                    // 代理对：高位 D800-DBFF + 低位 DC00-DFFF
                    if (cp >= 0xD800 && cp <= 0xDBFF && p + 5 < s.size() &&
                        s[p] == '\\' && s[p + 1] == 'u') {
                        unsigned lo = hex4(s, p + 2);
                        if (lo >= 0xDC00 && lo <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            p += 6;
                        }
                    }
                    putUtf8(out, cp);
                    break;
                }
                default: out += e; ++p; break;
                }
                continue;
            }
            out += c;
            ++p;
        }
        return false;
    }

    static bool parseNumber(const std::string& s, size_t& p, Json& out) {
        size_t start = p;
        if (p < s.size() && (s[p] == '-' || s[p] == '+')) ++p;
        bool any = false;
        while (p < s.size() && ((s[p] >= '0' && s[p] <= '9') || s[p] == '.' ||
                                s[p] == 'e' || s[p] == 'E' || s[p] == '-' || s[p] == '+')) {
            if (s[p] >= '0' && s[p] <= '9') any = true;
            ++p;
        }
        if (!any) return false;
        out.type = NUM;
        out.nval = atof(s.substr(start, p - start).c_str());
        return true;
    }
};

}  // namespace ql

#endif  // QL_JSON_H
