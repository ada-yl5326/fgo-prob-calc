// 离线缓存（Service Worker）：整个版本的文件一起缓存，打开网页时只用当前版本的缓存，断网也能用。
// 网页文件改动后，CACHE 里的版本号会变（由 tools/update_sw_version.py 按文件内容生成，测试会检查）：
// 浏览器发现 sw.js 变了，就在后台下载新版本的全部文件，下载完再整体替换旧版本，不会新旧文件混用。
const CACHE = 'killprob-5fec8a6b07';
const FILES = [
  './', 'index.html', 'style.css', 'groups.js', 'killprob.js', 'deal.js', 'combo.js', 'send.js', 'send-worker.js', 'buff.js',
  'app.js', 'deal-app.js', 'send-app.js', 'buff-app.js', 'combo-app.js', 'share.js', 'qr.js', 'qr-read.js', 'workspace-app.js', 'summary-app.js', 'main.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload'：绕过浏览器的普通缓存，确保拿到服务器上的最新文件
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(req, { ignoreSearch: true }))
      .then((hit) => hit || fetch(req))
  );
});
