# Otoyol Sürücüsü — Multiplayer Yarış

Bu sürüm, aynı yolda iki oyuncunun gerçek zamanlı yarışabilmesi için Socket.IO sunucusu kullanır.

## Çalıştırma
1. Bilgisayarda Node.js 18 veya üstünü kur.
2. Bu klasörde terminal aç.
3. `npm install`
4. `npm start`
5. Tarayıcıda `http://localhost:3000` adresini aç.

İki oyuncunun aynı yarışta eşleşmesi için oyunu iki farklı cihazda/sekmede açıp **Multiplayer Yarış** düğmesine basın. Aynı bilgisayarda test ederken iki ayrı sekme kullanılabilir.

## İnternetten başkalarıyla oynamak
Sunucuyu internete açık bir Node.js hostuna dağıtıp hostun verdiği HTTPS adresini açmalısın. Yalnızca HTML dosyasını paylaşmak yeterli değildir; otomatik oyuncu eşleştirme ve gerçek zamanlı durum aktarımı için `server.js` çalışır durumda olmalıdır. Hosting sağlayıcısının WebSocket/Socket.IO bağlantılarını desteklediğinden emin ol.

## Yarış kuralları
- İlk sürümde 2 oyuncu eşleşir.
- Bitiş çizgisi 5 km'dedir.
- Çarpışma ve trafik temasları hızı düşürür; multiplayer yarışta kaza ekranı açılmaz.
- İlk bitiren kazanır.

Bu ilk çevrimiçi altyapı prototipidir. Sunucuya dağıtmadan, yalnızca dosyayı telefonda açarak internet üzerinden eşleşme yapılamaz.
