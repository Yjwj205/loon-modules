/*!
 * YouTube Enhance (Loon port) - request.js
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
(()=>{const e="YouTubeConfig";function t(t=e,r=1/0){const n=$persistentStore.read(t);if("string"==typeof n&&n.length>r)return{};try{const e=JSON.parse(n||"{}");return e&&"object"==typeof e&&!Array.isArray(e)?e:{}}catch{return{}}}function r(e){const t=new Uint8Array(e.reduce((e,t)=>e+t.length,0));let r=0;for(const n of e)t.set(n,r),r+=n.length;return t}function n(e,t){return e===t||e.length===t.length&&e.every((e,r)=>e===t[r])}function o(e){const t=[];do{t.push(e%128|(e>127?128:0)),e=Math.floor(e/128)}while(e);return new Uint8Array(t)}function i(e){const t=[];let r=0;function n(){let t=0,n=1;for(let o=0;o<5;o++){if(r>=e.length)throw new Error("Truncated protobuf varint");const o=e[r++];if(t+=(127&o)*n,!(128&o)){if(t>4294967295)throw new Error("Protobuf length/tag overflow");return t}n*=128}throw new Error("Invalid protobuf varint")}for(;r<e.length;){const o=r,i=n(),s=Math.floor(i/8),u=i%8;if(!s)throw new Error("Invalid protobuf field");let a=r;if(2===u){const e=n();a=r,r+=e}else if(1===u)r+=8;else if(5===u)r+=4;else{if(0!==u)throw new Error("Unsupported protobuf wire type "+u);{let t,n=0;do{if(r>=e.length||10===n++)throw new Error("Invalid protobuf integer");if(t=e[r++],10===n&&t>1)throw new Error("Protobuf integer overflow")}while(128&t)}}if(r>e.length)throw new Error("Truncated protobuf field");t.push({no:s,wire:u,data:e.subarray(a,r),raw:e.subarray(o,r)})}return t}function s(e){let t=0,r=1;for(const n of e)t+=(127&n)*r,r*=128;return t}function u(e={}){return"string"!=typeof $argument||$argument.includes("{{{")?e:{...e,...JSON.parse($argument)}}function a(e){return Object.entries(e.headers??{}).some(([e,t])=>"user-agent"===e.toLowerCase()&&/music/i.test(t))?"youtubeMusic":"youtube"}function f(e,t,r=!1){let n;for(const o of i(e))if(o.no===t&&2===o.wire){if(!r)return o.data;if(n)return;n=o.data}return n}function c(e){const t=e.replace(/[-_\s=]/g,e=>"-"===e?"+":"_"===e?"/":""),r=t.length%4==1,n=Uint8Array.fromBase64(r?t+"A":t);return r?n.subarray(0,-1):n}function h(e,t){const n=new Map(t?[[13,0],[14,2],[16,t.height],[21,t.height],[26,3],[30,0]]:[[16,4320],[26,1],[30,0]]),u=new Set,a=[];let f=!1;for(const t of i(e)){const e=0===t.wire?n.get(t.no):void 0;void 0!==e?(s(t.data)===e?a.push(t.raw):(a.push(o(8*t.no),o(e)),f=!0),u.add(t.no)):a.push(t.raw)}for(const[e,t]of n)u.has(e)||(a.push(o(8*e),o(t)),f=!0);return f?r(a):e}function l(e){const t=e.body;if(ArrayBuffer.isView(t))return new Uint8Array(t.buffer,t.byteOffset,t.byteLength);if(t?.length)throw new Error("YouTube requires binary-body-mode for request bodies");const r=Object.entries(e.headers??{}).find(([e])=>"content-length"===e.toLowerCase())?.[1];if(Number(r)>0)throw new Error("YouTube request body unavailable; requires-body must be enabled")}!function(){try{const g=$request.url.split("?")[0];let d;if(g.endsWith("/player/ad_break"))d={response:{status:200,headers:{"Content-Type":"application/x-protobuf"},body:new Uint8Array}};else if(g.endsWith("/log_event"))d=function(e){const r=Object.keys(e.headers??{}).filter(e=>"x-youtube-hot-hash-data"===e.toLowerCase());if(!r.length||t()[a(e)]?.clientKey)return;const n={...e.headers};for(const e of r)delete n[e];return{headers:n}}($request);else if(g.endsWith("/initplayback")){if("GET"!==$request.method&&"HEAD"!==$request.method){const s=l($request);if(s?.length&&function(r,o){const i=f(r,3),s=i&&f(i,5);if(!s?.length)return!1;const u=t()[o];for(const e of(a=u)?[a,...Array.isArray(a.previous)?a.previous.slice(0,3):[]].filter(e=>e&&"string"==typeof e.clientKey&&"string"==typeof e.encryptKey&&e.clientKey.length>0&&e.clientKey.length<=5500&&e.encryptKey.length>0&&e.encryptKey.length<=5500):[])try{if(n(s,c(e.encryptKey)))return!0}catch{}var a;return function(r,n){if(void 0===r||void 0===n)return;const o=t();if(!Object.hasOwn(o,r))return;const i=o[r],s=n;JSON.stringify(i)===JSON.stringify(s)&&(delete o[r],function(t,r=e){$persistentStore.write(JSON.stringify(t),r)}(o))}(o,u),!1}(s,a($request))&&!1!==u().autoHd){const e=function(e){const t=i(e),n=t.filter(e=>2===e.no&&2===e.wire);if(1!==n.length)return e;const s=n[0],u=h(s.data,void 0);return u===s.data?e:r(t.map(e=>e===s?r([o(18),o(u.length),u]):e.raw))}(s);e!==s&&(d={body:e})}}}else if(g.endsWith("/videoplayback")){const e=!1===u().autoHd?void 0:l($request);if(e?.length){const u=function(e,u){const a=i(e),c=function(e,r){try{const n=/[?&]id=([^&]+)/.exec(r);if(!n)return;const o=e.find(e=>5===e.no&&2===e.wire),u=o&&f(o.data,1);if(!u?.length)return;const a=t("YouTubeQuality",65536)?.[decodeURIComponent(n[1])];if(!function(e){const t=e;return!!(t&&"object"==typeof t&&!Array.isArray(t)&&Number.isInteger(t.height)&&t.height>0&&t.height<=2147483647&&Array.isArray(t.itags)&&t.itags.length>0&&t.itags.length<=256&&t.itags.every(e=>Number.isInteger(e)&&e>0&&e<=4294967295)&&new Set(t.itags).size===t.itags.length&&(void 0===t.premiumItags||Array.isArray(t.premiumItags)&&t.premiumItags.length<=t.itags.length&&new Set(t.premiumItags).size===t.premiumItags.length&&t.premiumItags.every(e=>t.itags.includes(e))))}(a))return;const c=[],h=[];for(const e of i(u)){if(6!==e.no||2!==e.wire)continue;const t=i(e.data).find(e=>1===e.no&&0===e.wire);if(!t)continue;const r=s(t.data);a.itags.includes(r)&&(c.push(e.data),a.premiumItags?.includes(r)&&h.push(e.data))}return c.length?{height:a.height,formats:h.length?h:c}:void 0}catch{return}}(a,u),l=a.filter(e=>17===e.no&&2===e.wire),g=c&&(l.length!==c.formats.length||l.some((e,t)=>!n(e.data,c.formats[t]))),d=[];let y=!1,p=!!g;for(const e of a)if(1===e.no&&2===e.wire){const t=h(e.data,c);t===e.data?d.push(e.raw):(d.push(o(10),o(t.length),t),p=!0),y=!0}else{if(g&&17===e.no&&2===e.wire)continue;d.push(e.raw)}if(!y){const e=h(new Uint8Array,c);d.push(o(10),o(e.length),e),p=!0}if(g)for(const e of c.formats)d.push(o(138),o(e.length),e);return p?r(d):e}(e,$request.url);u!==e&&(d={body:u})}}$done(d)}catch(e){console.log("YouTube request: "+e),$done()}}()})();
}).call(this, __loonArgJSON);
