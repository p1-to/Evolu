// sw.js をモックした ServiceWorker 環境で実行し、更新・オフラインの挙動を確認する
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'sw.js'), 'utf8');

const ORIGIN = 'https://evolu.test';
const stores = new Map();
const key = (r) => { const u = typeof r === 'string' ? new URL(r, ORIGIN + '/').href : r.url; return u; };
const openStore = (name) => {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    match: async (r) => m.get(key(r)),
    put: async (r, res) => { m.set(key(r), res); },
    addAll: async (list) => { for (const u of list) { const res = await sandbox.fetch({ url: key(u) }); if (!res.ok) throw new Error('addAll ' + u); m.set(key(u), res); } },
  };
};
let mode = 'online';
const fetched = [];
const res = (body, ok = true) => ({ ok, type: 'basic', body, clone() { return this; } });
const listeners = {};
const sandbox = {
  URL, setTimeout, console,
  self: {
    location: { origin: ORIGIN },
    addEventListener: (n, f) => { listeners[n] = f; },
    skipWaiting: async () => { sandbox.skipped = true; },
    clients: { claim: async () => { sandbox.claimed = true; } },
  },
  caches: {
    open: async (n) => openStore(n),
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
  },
  fetch: async (r) => {
    fetched.push(r.url);
    if (mode === 'offline') throw new TypeError('offline');
    if (mode === 'slow') await new Promise((f) => setTimeout(f, 3600));
    return res('fresh:' + r.url);
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const fire = async (name, event = {}) => {
  let p = null; let responded = false;
  listeners[name]({ ...event, waitUntil: (x) => { p = x; }, respondWith: (x) => { responded = true; p = x; } });
  const value = await p;
  return { value, responded };
};
const get = (path, extra = {}) => ({ request: { url: path.startsWith('http') ? path : ORIGIN + path, method: 'GET', ...extra } });

(async () => {
  stores.set('evolu-v1', new Map([[ORIGIN + '/script.js', res('OLD')]]));
  await fire('install');
  assert.ok(sandbox.skipped, 'skipWaiting');
  assert.ok(stores.get('evolu-v2').has(ORIGIN + '/vendor/mediabunny.min.mjs'));
  await fire('activate');
  assert.deepEqual([...stores.keys()], ['evolu-v2'], '古いキャッシュ削除');
  assert.ok(sandbox.claimed, 'claim');

  // 更新が届く: オンラインならキャッシュより新しい内容
  stores.get('evolu-v2').set(ORIGIN + '/script.js', res('STALE'));
  let r = await fire('fetch', get('/script.js'));
  assert.equal(r.value.body, 'fresh:' + ORIGIN + '/script.js');
  await new Promise((f) => setTimeout(f, 10));
  assert.equal(stores.get('evolu-v2').get(ORIGIN + '/script.js').body, 'fresh:' + ORIGIN + '/script.js', 'キャッシュ更新');

  // オフライン: キャッシュで動く
  mode = 'offline';
  stores.get('evolu-v2').set(ORIGIN + '/script.js', res('CACHED'));
  r = await fire('fetch', get('/script.js'));
  assert.equal(r.value.body, 'CACHED');
  // オフラインの未キャッシュ画面遷移は index.html へ
  r = await fire('fetch', get('/some/page', { mode: 'navigate' }));
  assert.ok(String(r.value.body).endsWith('/index.html'));
  // オフラインの未キャッシュ素材はエラー
  await assert.rejects(fire('fetch', get('/missing.png')));

  // 回線が遅い: 3秒でキャッシュへ
  mode = 'slow';
  const t = Date.now();
  r = await fire('fetch', get('/script.js'));
  assert.equal(r.value.body, 'CACHED');
  assert.ok(Date.now() - t < 3400, 'timeout');
  await new Promise((f) => setTimeout(f, 700));

  // POSTと無関係な外部通信には触らない
  mode = 'online';
  r = await fire('fetch', { request: { url: ORIGIN + '/x', method: 'POST' } }).catch(() => ({ responded: false }));
  assert.equal(r.responded, false);
  r = await fire('fetch', get('https://example.com/a.js'));
  assert.equal(r.responded, false);
  // Webフォントはキャッシュ優先
  await fire('fetch', get('https://fonts.gstatic.com/a.woff2'));
  mode = 'offline';
  r = await fire('fetch', get('https://fonts.gstatic.com/a.woff2'));
  assert.ok(r.value.ok);
  console.log('sw ok');
})().catch((e) => { console.error(e); process.exit(1); });
