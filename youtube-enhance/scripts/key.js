/*!
 * YouTube Enhance (Loon port) - key.js
 * Upstream: gholts/surge@c2b0e7be (2026-11-10)
 * Source : https://github.com/gholts/surge (Apache-2.0, based on Maasea's code)
 * Port   : Yjwj205 / Minis
 */
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

;(function ($argument) {
(()=>{const e="YouTubeConfig";function t(e,t,r=!1){let n;for(const o of function(e){const t=[];let r=0;function n(){let t=0,n=1;for(let o=0;o<5;o++){if(r>=e.length)throw new Error("Truncated protobuf varint");const o=e[r++];if(t+=(127&o)*n,!(128&o)){if(t>4294967295)throw new Error("Protobuf length/tag overflow");return t}n*=128}throw new Error("Invalid protobuf varint")}for(;r<e.length;){const o=r,i=n(),l=Math.floor(i/8),s=i%8;if(!l)throw new Error("Invalid protobuf field");let c=r;if(2===s){const e=n();c=r,r+=e}else if(1===s)r+=8;else if(5===s)r+=4;else{if(0!==s)throw new Error("Unsupported protobuf wire type "+s);{let t,n=0;do{if(r>=e.length||10===n++)throw new Error("Invalid protobuf integer");if(t=e[r++],10===n&&t>1)throw new Error("Protobuf integer overflow")}while(128&t)}}if(r>e.length)throw new Error("Truncated protobuf field");t.push({no:l,wire:s,data:e.subarray(c,r),raw:e.subarray(o,r)})}return t}(e))if(o.no===t&&2===o.wire){if(!r)return o.data;if(n)return;n=o.data}return n}!function(){try{const o=$request.url.split("?")[0].split("/youtubei/v1/")[1];if("config"!==o&&"log_event"!==o||!$response.body?.length)return $done();let i=$response.body;for(const e of[1,16,7,138536474,146311580])if(i=t(i,e,!0),!i)return $done();const l=t(i,1,!0),s=t(i,2,!0);if(l?.length&&s?.length&&l.length<=4096&&s.length<=4096){const t=(n=$request,Object.entries(n.headers??{}).some(([e,t])=>"user-agent"===e.toLowerCase()&&/music/i.test(t))?"youtubeMusic":"youtube"),o=function(t=e,r=1/0){const n=$persistentStore.read(t);if("string"==typeof n&&n.length>r)return{};try{const e=JSON.parse(n||"{}");return e&&"object"==typeof e&&!Array.isArray(e)?e:{}}catch{return{}}}(),i={clientKey:l.toBase64(),encryptKey:s.toBase64()};if(o[t]?.clientKey!==i.clientKey||o[t]?.encryptKey!==i.encryptKey){const n=(r=o[t],r?[r,...Array.isArray(r.previous)?r.previous.slice(0,3):[]].filter(e=>e&&"string"==typeof e.clientKey&&"string"==typeof e.encryptKey&&e.clientKey.length>0&&e.clientKey.length<=5500&&e.encryptKey.length>0&&e.encryptKey.length<=5500):[]).filter(e=>e.clientKey!==i.clientKey||e.encryptKey!==i.encryptKey).slice(0,3).map(({clientKey:e,encryptKey:t})=>({clientKey:e,encryptKey:t}));n.length&&(i.previous=n),o[t]=i,function(t,r=e){return $persistentStore.write(JSON.stringify(t),r)}(o)||console.log("YouTube key write failed")}}$done()}catch(e){console.log("YouTube keys: "+e),$done()}var r,n}()})();
}).call(this, __loonArgJSON);
