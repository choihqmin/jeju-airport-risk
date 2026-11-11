// 제주 표류 전망 서비스 워커: 늘 네트워크 먼저(최신 예보), 끊기면 마지막으로 받은 화면을 보여 준다.
// 오프라인일 때는 화면이 '인터넷 연결이 없어 마지막으로 받은 예보'라고 알린다(index.html).
const PREFIX = 'pyoryu-', CACHE = PREFIX + 'v2';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); e.waitUntil(caches.open(CACHE).then(x => x.put(r, c))); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true })));
});
