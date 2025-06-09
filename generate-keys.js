// generate-keys.js (Düzeltilmiş Final Hali)
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const dbPath = path.join(process.env.RENDER_DISK_MOUNT_PATH || '.', 'keys.db');
const db = new sqlite3.Database(dbPath);

console.log(`Veritabanı şu yolda oluşturulacak/kontrol edilecek: ${dbPath}`);

// db.serialize, içindeki komutların sırayla başlamasını sağlar.
db.serialize(() => {
    
    // 1. Tabloları oluştur
    db.run(`CREATE TABLE IF NOT EXISTS access_keys (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, first_used_at DATETIME DEFAULT NULL, is_locked INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, setting_key TEXT NOT NULL UNIQUE, setting_value TEXT)`);

    // 2. Ayarları ekle
    const settings = [
        ['copy_text', 'Lütfen kopyalanacak metni adminn panelinden ayarlayın.'], ['tenant_id', ''], ['client_id', ''],
        ['client_secret', ''], ['target_user_id', '']
    ];
    const settingStmt = db.prepare("INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)");
    for (const setting of settings) {
        settingStmt.run(setting[0], setting[1]);
    }
    // Ayarları ekleme işlemi bittikten sonra...
    settingStmt.finalize(() => {
        console.log("Başlangıç ayarları eklendi veya zaten mevcuttu.");

        // 3. Anahtar tablosunun boş olup olmadığını kontrol et
        db.get("SELECT count(*) as count FROM access_keys", (err, row) => {
            if (err) {
                console.error("Hata:", err.message);
                db.close(); // Hata durumunda kapat
                return;
            }

            if (row && row.count === 0) {
                const keyStmt = db.prepare("INSERT INTO access_keys (key) VALUES (?)");
                console.log("1000 adet yeni anahtar oluşturuluyor...");
                for (let i = 0; i < 1000; i++) {
                    keyStmt.run(crypto.randomUUID());
                }
                // Anahtar ekleme işlemi de bittikten sonra...
                keyStmt.finalize(() => {
                    console.log("Anahtarlar başarıyla oluşturuldu.");
                    // EN SON İŞLEM OLARAK veritabanını kapat.
                    db.close();
                    console.log("Veritabanı bağlantısı kapatıldı.");
                });
            } else {
                console.log("Veritabanında zaten anahtarlar mevcut, yeni anahtar üretilmedi.");
                // Eğer anahtar üretilmediyse de veritabanını kapat.
                db.close();
                console.log("Veritabanı bağlantısı kapatıldı.");
            }
        });
    });
});