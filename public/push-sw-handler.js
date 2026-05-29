/* Web Push display + click routing (imported by Workbox service worker). */
self.addEventListener("push", function (event) {
  var data = { title: "UD CRM", body: "", url: "/" };
  try {
    if (event.data) {
      var parsed = event.data.json();
      data.title = parsed.title || data.title;
      data.body = parsed.body || "";
      data.url = parsed.url || "/";
      data.tag = parsed.tag || parsed.type || "uddash-notification";
    }
  } catch (_e) {
    if (event.data) data.body = event.data.text();
  }

  var options = {
    body: data.body,
    icon: "/pwa-192.png",
    badge: "/pwa-192.png",
    data: { url: data.url },
    tag: data.tag || "uddash-notification",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || "/";
  var absolute = new URL(targetUrl, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (!client.url.startsWith(self.location.origin)) continue;
        if ("focus" in client) {
          return client.focus().then(function (focused) {
            if ("navigate" in focused) return focused.navigate(absolute);
            return focused;
          });
        }
      }
      if (clients.openWindow) return clients.openWindow(absolute);
    }),
  );
});
