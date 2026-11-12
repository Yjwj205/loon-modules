// Loon 运行时模拟测试
const vm = require('vm');
const fs = require('fs');
const zlib = require('zlib');

function makeStore() {
  const data = {};
  return {
    read: (k) => (k === undefined ? data['default'] : data[k]),
    write: (v, k) => { const key = k === undefined ? 'default' : k; if (v === undefined || v === null) delete data[key]; else data[key] = String(v); return true; },
    remove: () => { for (const k in data) delete data[k]; return true; },
    _data: data,
  };
}

function run(file, opts) {
  const calls = [];
  const logs = [];
  const ctx = {
    $argument: opts.argument,
    $request: opts.request,
    $response: opts.response,
    $persistentStore: opts.store || makeStore(),
    $utils: {
      gzip: (u8) => new Uint8Array(zlib.gzipSync(Buffer.from(u8))),
      ungzip: (u8) => new Uint8Array(zlib.gunzipSync(Buffer.from(u8))),
    },
    $done: (v) => calls.push(v),
    console: { log: (...a) => logs.push(a.map(String).join(' ')) },
    setTimeout, Promise, Uint8Array, ArrayBuffer, JSON, Math, Object, String, Number, RegExp, Error, TypeError, BigInt,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const code = fs.readFileSync(file, 'utf8');
  let err = null;
  try { vm.runInContext(code, ctx, { filename: file, timeout: 20000 }); } catch (e) { err = e; }
  return { calls, logs, err, ctx };
}

const S = 'scripts/';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

console.log('== 1. argument 适配 ==');
for (const arg of [
  { blockUpload: true, blockShorts: false, autoHd: true },
  { block_upload: true, block_shorts: false, auto_hd: true },
  { blockUpload: 'true', autoHd: 'false' },
  undefined,
]) {
  const r = run(S + 'key.js', { argument: arg, request: { url: 'https://youtubei.googleapis.com/youtubei/v1/config', headers: {} }, response: { status: 200, body: new Uint8Array([1, 2]) } });
  const json = vm.runInContext('__loonArgJSON', r.ctx);
  console.log('   ', JSON.stringify(arg), '=>', json);
}

console.log('== 2. request.js / ad_break ==');
{
  const r = run(S + 'request.js', {
    argument: { autoHd: true },
    request: { url: 'https://youtubei.googleapis.com/youtubei/v1/player/ad_break?prettyPrint=false', method: 'POST', headers: {}, body: new Uint8Array([1, 2, 3]) },
  });
  check('无异常', !r.err, r.err && r.err.stack);
  check('$done 调用一次', r.calls.length === 1, 'calls=' + r.calls.length);
  const v = r.calls[0] || {};
  check('返回 200 本地响应', v.response && v.response.status === 200, JSON.stringify(v).slice(0, 200));
  check('空 body', v.response && v.response.body && v.response.body.length === 0, v.response && v.response.body && v.response.body.length);
}

console.log('== 3. request.js / log_event 去头 ==');
{
  const r = run(S + 'request.js', {
    argument: {},
    request: { url: 'https://youtubei.googleapis.com/youtubei/v1/log_event?alt=proto', method: 'POST', headers: { 'X-Youtube-Hot-Hash-Data': 'abc', 'Content-Type': 'application/x-protobuf' }, body: new Uint8Array([1]) },
  });
  check('无异常', !r.err, r.err && r.err.stack);
  check('$done 一次', r.calls.length === 1, r.calls.length);
  const h = (r.calls[0] || {}).headers || {};
  check('移除 hot hash 头', !Object.keys(h).some(k => k.toLowerCase() === 'x-youtube-hot-hash-data'), JSON.stringify(h));
}

console.log('== 4. request.js / videoplayback 无 body 不崩 ==');
{
  const r = run(S + 'request.js', {
    argument: { autoHd: true },
    request: { url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?id=abc', method: 'GET', headers: {} },
  });
  check('无异常', !r.err, r.err && r.err.stack);
  check('$done 一次', r.calls.length === 1, r.calls.length);
}

console.log('== 5. response.js 垃圾 body 不崩 ==');
{
  const r = run(S + 'response.js', {
    argument: { blockUpload: true, blockShorts: false, autoHd: true, blockGames: true, blockVerticalLive: false, jumpAhead: true, blockStore: true, blockAi: true, onTheGo: true },
    request: { url: 'https://youtubei.googleapis.com/youtubei/v1/browse?prettyPrint=false', headers: {} },
    response: { status: 200, headers: {}, body: new Uint8Array([8, 1, 18, 4, 1, 2, 3, 4]) },
  });
  check('无异常', !r.err, r.err && r.err.stack);
  check('$done 一次', r.calls.length === 1, 'calls=' + r.calls.length);
  console.log('    logs:', r.logs.slice(0, 3).join(' | ').slice(0, 200));
}

console.log('== 6. ump.js 无 key 时安全退出 ==');
{
  const r = run(S + 'ump.js', {
    argument: { autoHd: true },
    request: { url: 'https://rr1---sn-abc.googlevideo.com/initplayback?xyz=1', headers: {} },
    response: { status: 200, headers: { 'content-type': 'application/vnd.yt-ump' }, body: new Uint8Array([1, 2, 3]) },
  });
  check('无异常', !r.err, r.err && r.err.stack);
  check('$done 一次', r.calls.length === 1, 'calls=' + r.calls.length);
  console.log('    logs:', r.logs.join(' | ').slice(0, 200));
}

console.log('== 7. polyfill 单测（删掉原生实现）==');
{
  const ctx = { $argument: {}, $utils: null, $done: () => {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // 强制缺失
  vm.runInContext('delete globalThis.TextEncoder; delete globalThis.TextDecoder; delete globalThis.CompressionStream; delete globalThis.DecompressionStream;', ctx);
  vm.runInContext(fs.readFileSync('adapter.js', 'utf8'), ctx);
  const has = (n) => vm.runInContext(`typeof ${n}`, ctx);
  check('TextEncoder 注入', has('TextEncoder') === 'function', has('TextEncoder'));
  check('TextDecoder 注入', has('TextDecoder') === 'function', has('TextDecoder'));
  check('CompressionStream 注入', has('CompressionStream') === 'function', has('CompressionStream'));
  check('DecompressionStream 注入', has('DecompressionStream') === 'function', has('DecompressionStream'));
  const enc = vm.runInContext(`new TextEncoder().encode("中文a😀")`, ctx);
  const dec = vm.runInContext(`new TextDecoder().decode(new Uint8Array([${enc.join(',')}]))`, ctx);
  check('UTF-8 往返', dec === '中文a😀', dec);
  const b64 = vm.runInContext(`new Uint8Array([0,1,2,250,255]).toBase64()`, ctx);
  const back = vm.runInContext(`Uint8Array.fromBase64("${b64}")`, ctx);
  check('base64 往返', JSON.stringify([0,1,2,250,255]) === JSON.stringify(Array.from(back)), b64 + ' -> ' + Array.from(back));
  let fatal = 'no';
  try { vm.runInContext(`new TextDecoder("utf-8",{fatal:true}).decode(new Uint8Array([0xff]))`, ctx); } catch (e) { fatal = 'threw'; }
  check('fatal 解码抛错', fatal === 'threw', fatal);
}

console.log('== 8. CompressionStream shim 端到端 ==');
{
  const r = run(S + 'key.js', { argument: {}, request: { url: 'https://youtubei.googleapis.com/youtubei/v1/config', headers: {} }, response: { status: 200, body: new Uint8Array([1]) } });
  void r;
  const ctx = { $argument: {}, console, $done: () => {}, Promise, Uint8Array, Error };
  ctx.globalThis = ctx;
  ctx.$utils = { gzip: (u8) => new Uint8Array(zlib.gzipSync(Buffer.from(u8))), ungzip: (u8) => new Uint8Array(zlib.gunzipSync(Buffer.from(u8))) };
  vm.createContext(ctx);
  vm.runInContext('delete globalThis.CompressionStream; delete globalThis.DecompressionStream;', ctx);
  vm.runInContext(fs.readFileSync('adapter.js', 'utf8'), ctx);
  const out = vm.runInContext(`
    (async () => {
      const src = new Uint8Array([1,2,3,4,5]);
      const cs = new CompressionStream("gzip");
      const w = cs.writable.getWriter(); const rr = cs.readable.getReader();
      const p = (async () => { const a = await rr.read(); const b = await rr.read(); return {first: Array.from(a.value), done: a.done, secondDone: b.done}; })();
      await w.write(src); await w.close();
      const res = await p;
      const ds = new DecompressionStream("gzip");
      const w2 = ds.writable.getWriter(); const r2 = ds.readable.getReader();
      const p2 = (async () => { const a = await r2.read(); return Array.from(a.value); })();
      await w2.write(new Uint8Array(res.first)); await w2.close();
      return { gz: res, roundtrip: await p2 };
    })()
  `, ctx);
  out.then(v => {
    check('gzip 输出可用', v.gz.first[0] === 0x1f && v.gz.first[1] === 0x8b && v.gz.secondDone === true, JSON.stringify(v.gz));
    check('解压往返', JSON.stringify(v.roundtrip) === JSON.stringify([1,2,3,4,5]), JSON.stringify(v.roundtrip));
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }).catch(e => {
    check('CompressionStream 测试', false, e.stack);
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  });
}
