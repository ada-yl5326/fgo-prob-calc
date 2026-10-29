// 离线缓存（Service Worker）：整个版本的文件一起缓存，打开网页时只用当前版本的缓存，断网也能用。
// 网页文件改动后，CACHE 里的版本号会变（由 tools/update_sw_version.py 按文件内容生成，测试会检查）：
// 浏览器发现 sw.js 变了，就在后台下载新版本的全部文件，下载完再整体替换旧版本，不会新旧文件混用。
const CACHE = 'killprob-dc594408a0';
const FILES = [
  './', 'index.html', 'style.css', 'groups.js', 'killprob.js', 'deal.js', 'combo.js', 'send.js', 'send-worker.js', 'buff.js',
  'app.js', 'deal-app.js', 'send-app.js', 'buff-app.js', 'combo-app.js', 'share.js', 'qr.js', 'qr-read.js', 'workspace-app.js', 'summary-app.js', 'laplace-shot.js', 'laplace-app.js', 'main.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
// 文字识别（「从 Laplace 截图导入」用）：约 7 MB，第一次用到时才下载，存进单独的缓存，网页更新版本时不重新下载
const OCR_CACHE = 'killprob-ocr-tesseract-5.1.1';
const OCR_DIR = '/vendor/tesseract/';
// 使用指南和它的截图（由 tools/build_guide.py 生成，请不要手动修改）
const GUIDE_FILES = [
  'guide.html', 'guide/img/start-header.webp', 'guide/img/start-groups.webp', 'guide/img/kill-basic.webp',
  'guide/img/kill-dims.webp', 'guide/img/kill-aoe.webp', 'guide/img/kill-sl.webp', 'guide/img/kill-dist.webp',
  'guide/img/kill-curve.webp', 'guide/img/laplace-record.webp', 'guide/img/laplace-dialog.webp',
  'guide/img/laplace-groups.webp', 'guide/img/deal-basic.webp', 'guide/img/deal-turns.webp',
  'guide/img/deal-servants.webp', 'guide/img/deal-or.webp', 'guide/img/deal-steps.webp',
  'guide/img/buff-plain.webp', 'guide/img/buff-binom.webp', 'guide/img/send-basic.webp',
  'guide/img/send-servants.webp', 'guide/img/send-enemies.webp', 'guide/img/send-ours.webp',
  'guide/img/send-aim.webp', 'guide/img/send-traits.webp', 'guide/img/send-result.webp',
  'guide/img/send-detail.webp', 'guide/img/send-hits.webp', 'guide/img/send-hits-result.webp',
  'guide/img/combo-basic.webp', 'guide/img/combo-palette.webp', 'guide/img/combo-buff-send.webp',
  'guide/img/combo-split.webp', 'guide/img/combo-split-result.webp', 'guide/img/combo-sl.webp',
  'guide/img/combo-sl-result.webp', 'guide/img/combo-steps.webp', 'guide/img/ws-panel.webp',
  'guide/img/ws-export.webp', 'guide/img/ws-import.webp', 'guide/img/share-image.webp'
];

self.addEventListener('install', (event) => {
  // cache: 'reload'：绕过浏览器的普通缓存，确保拿到服务器上的最新文件
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.concat(GUIDE_FILES).map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes(OCR_DIR)) {
    event.respondWith(
      caches.open(OCR_CACHE).then((cache) => cache.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })))
    );
    return;
  }
  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(req, { ignoreSearch: true }))
      .then((hit) => hit || fetch(req))
  );
});
