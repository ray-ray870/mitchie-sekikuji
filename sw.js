// みっちーの席くじ - オフライン対応用 Service Worker
// アプリを更新した時は CACHE_NAME の末尾の数字を1つ増やしてください
// (増やさないと、ユーザーのスマホに古いキャッシュが残り続けてしまいます)
const CACHE_NAME = 'mitchie-seat-lottery-v22';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './icon-1024.png'
];

// インストール時: 主要ファイルをまとめてキャッシュ
self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return Promise.all(
        CORE_ASSETS.map(function(url){
          return cache.add(url).catch(function(){
            // 1つのファイルが失敗しても全体を止めない
          });
        })
      );
    })
  );
});

// 有効化時: 古いバージョンのキャッシュを削除
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(
        names.filter(function(name){ return name !== CACHE_NAME; })
             .map(function(name){ return caches.delete(name); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

// リクエスト時:
//  - アプリ本体(ページ/index.html): まずネットから最新版を取り、取れなければ
//    (オフライン時) 保存しておいた版を使う。こうしないと、GitHubを更新した
//    直後に開いたとき、1回目は古いプログラムが動いてしまう。
//    ブラウザの一時保存（GitHub Pagesは約10分）も使わず、毎回GitHubに確認する。
//  - アイコン等その他: まずキャッシュ、裏で最新版に更新(stale-while-revalidate)
self.addEventListener('fetch', function(event){
  if(event.request.method !== 'GET') return;

  var url = new URL(event.request.url);
  var isPage = event.request.mode === 'navigate' ||
    url.pathname === '/' || /\/$/.test(url.pathname) || /index\.html$/.test(url.pathname);

  if(isPage){
    event.respondWith(
      fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function(response){
        if(response && response.status === 200){
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, copy); });
        }
        return response;
      }).catch(function(){
        return caches.match(event.request).then(function(cached){
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(cached){
      var networkFetch = fetch(event.request).then(function(response){
        if(response && response.status === 200){
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache){
            cache.put(event.request, copy);
          });
        }
        return response;
      }).catch(function(){
        return cached;
      });
      // キャッシュがあれば即座に返しつつ、裏で最新版に更新(stale-while-revalidate)
      return cached || networkFetch;
    })
  );
});
