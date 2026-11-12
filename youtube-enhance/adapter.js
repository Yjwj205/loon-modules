/* ===== Loon 适配层 for YouTube Enhance =====
 * 1) Loon 的 $argument 是插件参数对象，Surge 版脚本按 JSON 字符串解析 → 这里转成 JSON 字符串
 * 2) Loon 的 JS 运行时（JavaScriptCore）没有 TextEncoder / TextDecoder / Uint8Array.fromBase64 /
 *    CompressionStream → 缺失时补上（gzip 走 Loon $utils.gzip / $utils.ungzip，需 Build >= 988）
 * 本段由 build.py 自动插入，请勿手工修改。
 */
var __loonArgJSON = (function () {
  function toJSON(raw) {
    if (typeof raw === "string") return raw;
    if (!raw || typeof raw !== "object") return "{}";
    var out = {}, keys = [], k, i, v;
    for (k in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k)) keys.push(k);
    }
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      v = raw[k];
      if (v === null || v === undefined) continue;
      if (typeof v === "string") {
        if (v === "true") v = true;
        else if (v === "false") v = false;
        else if (/^-?\d+(?:\.\d+)?$/.test(v)) v = Number(v);
      }
      out[k] = v;
    }
    /* snake_case -> camelCase 兼容 */
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (!(k in out)) continue;
      var camel = k.replace(/_+([a-zA-Z0-9])/g, function (_, c) { return c.toUpperCase(); });
      if (camel !== k && !(camel in out)) out[camel] = out[k];
    }
    return JSON.stringify(out);
  }
  try {
    return toJSON(typeof $argument === "undefined" ? undefined : $argument);
  } catch (e) {
    return "{}";
  }
})();

(function () {
  var G = (typeof globalThis !== "undefined") ? globalThis : (typeof self !== "undefined" ? self : this);

  /* ---------- TextEncoder ---------- */
  if (typeof G.TextEncoder === "undefined") {
    var Enc = function TextEncoder() { this.encoding = "utf-8"; };
    Enc.prototype.encode = function (str) {
      str = String(str == null ? "" : str);
      var out = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
          out.push(c);
        } else if (c < 0x800) {
          out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          var c2 = str.charCodeAt(i + 1);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) {
            var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
            i++;
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          } else {
            out.push(0xef, 0xbf, 0xbd);
          }
        } else if (c >= 0xd800 && c <= 0xdfff) {
          out.push(0xef, 0xbf, 0xbd);
        } else {
          out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
      }
      return new Uint8Array(out);
    };
    G.TextEncoder = Enc;
  }

  /* ---------- TextDecoder ---------- */
  if (typeof G.TextDecoder === "undefined") {
    var Dec = function TextDecoder(label, options) {
      this.encoding = "utf-8";
      this.fatal = !!(options && options.fatal);
      this.ignoreBOM = !!(options && options.ignoreBOM);
    };
    Dec.prototype.decode = function (input) {
      if (input == null) return "";
      var bytes;
      if (input instanceof Uint8Array) {
        bytes = input;
      } else if (input && input.buffer instanceof ArrayBuffer) {
        bytes = new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
      } else {
        bytes = new Uint8Array(input);
      }
      var fatal = this.fatal;
      function bad() {
        if (fatal) throw new TypeError("The encoded data was not valid for encoding utf-8");
      }
      var cps = [], i = 0, n = bytes.length;
      if (!this.ignoreBOM && n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
      while (i < n) {
        var b = bytes[i++];
        if (b < 0x80) { cps.push(b); continue; }
        var extra, cp, min;
        if (b >= 0xc2 && b <= 0xdf) { extra = 1; cp = b & 0x1f; min = 0x80; }
        else if (b >= 0xe0 && b <= 0xef) { extra = 2; cp = b & 0x0f; min = 0x800; }
        else if (b >= 0xf0 && b <= 0xf4) { extra = 3; cp = b & 0x07; min = 0x10000; }
        else { bad(); cps.push(0xfffd); continue; }
        if (i + extra > n) { bad(); cps.push(0xfffd); break; }
        var ok = true;
        for (var j = 0; j < extra; j++) {
          var nb = bytes[i + j];
          if ((nb & 0xc0) !== 0x80) { ok = false; break; }
          cp = (cp << 6) | (nb & 0x3f);
        }
        if (!ok) { bad(); cps.push(0xfffd); i += 1; continue; }
        i += extra;
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { bad(); cps.push(0xfffd); continue; }
        cps.push(cp);
      }
      var chunks = [], CH = 4096;
      for (var k = 0; k < cps.length; k += CH) {
        chunks.push(String.fromCodePoint.apply(null, cps.slice(k, k + CH)));
      }
      return chunks.join("");
    };
    G.TextDecoder = Dec;
  }

  /* ---------- Base64 ---------- */
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function b64decode(str) {
    var s = String(str).replace(/[-_\s=]/g, function (c) {
      return c === "-" ? "+" : (c === "_" ? "/" : "");
    }).replace(/[^A-Za-z0-9+/]/g, "");
    var len = s.length, rem = len & 3;
    if (rem === 1) throw new Error("invalid base64");
    var outLen = (len >> 2) * 3 + (rem === 2 ? 1 : (rem === 3 ? 2 : 0));
    var out = new Uint8Array(outLen), o = 0, i = 0;
    while (i < len) {
      var c1 = B64.indexOf(s.charAt(i++)), c2 = B64.indexOf(s.charAt(i++));
      var c3 = i < len ? B64.indexOf(s.charAt(i++)) : 64;
      var c4 = i < len ? B64.indexOf(s.charAt(i++)) : 64;
      if (c1 < 0 || c2 < 0) throw new Error("invalid base64");
      out[o++] = (c1 << 2) | (c2 >> 4);
      if (c3 < 64) {
        out[o++] = ((c2 & 15) << 4) | (c3 >> 2);
        if (c4 < 64) out[o++] = ((c3 & 3) << 6) | c4;
      }
    }
    return out;
  }
  function b64encode(bytes) {
    var out = "", i = 0, n = bytes.length;
    for (; i + 2 < n; i += 3) {
      var t = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64.charAt((t >> 18) & 63) + B64.charAt((t >> 12) & 63) + B64.charAt((t >> 6) & 63) + B64.charAt(t & 63);
    }
    var left = n - i;
    if (left === 1) {
      var a = bytes[i] << 16;
      out += B64.charAt((a >> 18) & 63) + B64.charAt((a >> 12) & 63) + "==";
    } else if (left === 2) {
      var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64.charAt((b >> 18) & 63) + B64.charAt((b >> 12) & 63) + B64.charAt((b >> 6) & 63) + "=";
    }
    return out;
  }
  if (typeof Uint8Array.fromBase64 !== "function") {
    Uint8Array.fromBase64 = function (str) { return b64decode(str); };
  }
  if (typeof Uint8Array.prototype.toBase64 !== "function") {
    Uint8Array.prototype.toBase64 = function () { return b64encode(this); };
  }

  /* ---------- CompressionStream / DecompressionStream（gzip） ---------- */
  function makeGzipStream(decompress) {
    var chunks = [], total = 0, settled = false, delivered = false;
    var resolveReady, rejectReady;
    var ready = new Promise(function (res, rej) { resolveReady = res; rejectReady = rej; });
    ready.catch(function () {});
    function concat() {
      var all = new Uint8Array(total), off = 0, i;
      for (i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
      return all;
    }
    function runtime() {
      if (typeof $utils === "undefined" || !$utils) throw new Error("Loon $utils unavailable (requires Build >= 988)");
      var fn = decompress ? $utils.ungzip : $utils.gzip;
      if (typeof fn !== "function") throw new Error("Loon $utils." + (decompress ? "ungzip" : "gzip") + " unavailable (requires Build >= 988)");
      return fn;
    }
    this.readable = {
      getReader: function () {
        return {
          read: function () {
            return ready.then(function (buf) {
              if (delivered) return { value: undefined, done: true };
              delivered = true;
              return { value: buf, done: false };
            });
          },
          cancel: function () { return Promise.resolve(); },
          releaseLock: function () {}
        };
      }
    };
    this.writable = {
      getWriter: function () {
        return {
          write: function (chunk) {
            if (settled) return Promise.reject(new Error("stream closed"));
            var bytes = chunk instanceof Uint8Array ? chunk : (chunk && chunk.buffer ? new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength) : new Uint8Array(chunk || 0));
            chunks.push(bytes);
            total += bytes.length;
            return Promise.resolve();
          },
          close: function () {
            if (settled) return Promise.resolve();
            settled = true;
            try {
              var out = runtime()(concat());
              resolveReady(out instanceof Uint8Array ? out : new Uint8Array(out));
            } catch (e) {
              rejectReady(e);
            }
            return Promise.resolve();
          },
          abort: function (reason) {
            if (settled) return Promise.resolve();
            settled = true;
            rejectReady(reason || new Error("aborted"));
            return Promise.resolve();
          },
          releaseLock: function () {}
        };
      }
    };
  }
  if (typeof G.CompressionStream === "undefined") {
    G.CompressionStream = function CompressionStream(format) {
      if (String(format).toLowerCase() !== "gzip") throw new Error("only gzip is supported");
      makeGzipStream.call(this, false);
    };
  }
  if (typeof G.DecompressionStream === "undefined") {
    G.DecompressionStream = function DecompressionStream(format) {
      if (String(format).toLowerCase() !== "gzip") throw new Error("only gzip is supported");
      makeGzipStream.call(this, true);
    };
  }
})();
