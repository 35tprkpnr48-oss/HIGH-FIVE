# Otoyol Sürücüsü — Multiplayer Yarış

Ham WebSocket (ek bağımlılık yok), Node.js 16+. Yerel çalıştırma: `node server.js` → http://localhost:8080

Dosyalar: `oyun.html` (oyun), `admin.html` (yönetim, `/admin`), `server.js`, `dogan.bin` / `egea.bin` / `civic.bin` (araç modelleri, oyun açılınca gerektiğinde indirilir).

Render ortam değişkenleri: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (≥16), `SESSION_SECRET` (≥32). İsteğe bağlı: `DATA_FILE` (bakiye/fiyat/engel kayıt dosyası; Render ücretsiz planda kalıcı değildir).

Yarış: 2 oyuncu, 4 km, ilk bitiren kazanır. Çarpışma hızı düşürür.
