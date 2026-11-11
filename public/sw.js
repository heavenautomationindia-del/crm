const C='rago-v12';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.json'])));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.pathname.startsWith('/api/'))return;
 e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request)))});

self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch(x){}
 e.waitUntil(self.registration.showNotification(d.title||'Rago',{body:d.body||'',icon:'/icon-192.png',badge:'/icon-192.png',vibrate:[200,100,200],silent:false,tag:d.tag||('gz-'+(d.sid||'')),renotify:true,requireInteraction:!!d.todo,data:{url:d.url||'/',sid:d.sid,todo:d.todo,att:d.att}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const d=e.notification.data||{};
 e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c){c.postMessage({sid:d.sid,todo:d.todo,att:d.att});return c.focus()}}return clients.openWindow(d.url||'/')}))});
