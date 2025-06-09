// server.js (Dinamik Oturum Süreli FİNAL SÜRÜM)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { createClient } = require('@libsql/sqlite3');
const axios = require('axios');
const path = require('path');
const SQLiteStore = require('connect-sqlite3')(session);
const app = express();

const PORT = process.env.PORT || 8000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'BDaP5924';

const dbConfig = {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
};
let settings = {};

function loadSettings(callback) { /* ... Bu fonksiyon aynı kalıyor ... */ }
let msGraphToken = { accessToken: null, expiresAt: 0 };
async function getMsGraphToken() { /* ... Bu fonksiyon aynı kalıyor ... */ }
async function getLatestEmail() { /* ... Bu fonksiyon aynı kalıyor ... */ }

// --- Express Ayarları ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// Session ayarlarından sabit cookie süresini kaldırıyoruz
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: path.dirname(dbConfig.url.startsWith('libsql') ? './' : dbConfig.url), // Geçici çözüm, Render'da çalışması için
        table: 'sessions'
    }),
    secret: 'klavyemden-cıkan-cok-gizli-kelimeler-2',
    resave: false,
    saveUninitialized: false
    // DİKKAT: cookie: { maxAge: ... } satırını buradan sildik!
}));


// --- Rotalar ---
app.get('/', (req, res) => { res.render('login', { error: null }); });

app.post('/login', (req, res) => {
    const userKey = req.body.key;
    if (userKey === ADMIN_KEY) {
        req.session.isLoggedIn = true;
        req.session.isAdmin = true;
        // Admin oturumu 1 yıl sürsün
        req.session.cookie.maxAge = 365 * 24 * 60 * 60 * 1000;
        return res.redirect('/viewer');
    }

    const db = createClient(dbConfig);
    db.get("SELECT first_used_at, is_locked FROM access_keys WHERE key = ?", [userKey], (err, row) => {
        if (err || !row) {
            res.render('login', { error: 'Geçersiz anahtar.' });
            db.close();
            return;
        }

        const now = new Date();
        const isFirstUse = row.first_used_at === null;

        // Eğer anahtar kilitliyse ve ilk kullanım değilse, engelle
        if (row.is_locked === 1 && !isFirstUse) {
             return res.render('login', { error: 'Bu anahtar daha önce aktif edilmiştir ve paylaşılamaz.' });
        }
        
        // Süre hesaplamasını yap
        const firstUsedDate = isFirstUse ? now : new Date(row.first_used_at);
        const expiryDate = new Date(firstUsedDate);
        expiryDate.setDate(firstUsedDate.getDate() + 30);

        // Süre dolmuş mu kontrol et
        if (expiryDate <= now && !isFirstUse) {
            return res.render('login', { error: 'Girdiğiniz anahtarın 1 aylık kullanım süresi dolmuş.' });
        }
        
        // --- YENİ DİNAMİK SÜRE AYARI ---
        const remainingTime = expiryDate.getTime() - now.getTime();
        if (remainingTime > 0) {
            req.session.cookie.maxAge = remainingTime;
        }

        req.session.isLoggedIn = true;
        req.session.isAdmin = false;

        // Eğer ilk kullanım ise veritabanını güncelle ve kilitle
        if (isFirstUse) {
            db.run("UPDATE access_keys SET first_used_at = ?, is_locked = 1 WHERE key = ?", [now.toISOString(), userKey], (updateErr) => {
                if (updateErr) {
                    res.render('login', { error: 'Veritabanı güncellenirken bir hata oluştu.' });
                } else {
                    res.redirect('/viewer');
                }
                db.close();
            });
        } else {
            // İlk kullanım değilse, sadece giriş yap
            res.redirect('/viewer');
            db.close();
        }
    });
});

app.get('/viewer', async (req, res) => { /* ... Bu rota aynı kalıyor ... */ });
app.post('/update-copy-text', (req, res) => { /* ... Bu rota aynı kalıyor ... */ });
app.post('/update-azure-settings', (req, res) => { /* ... Bu rota aynı kalıyor ... */ });
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });


// Sunucu başlatma kısmı (loadSettings ve app.listen içerir)
// Karışıklık olmaması için kodun tamamını tekrar yapıştırıyorum
function loadSettings(callback) { const db = createClient(dbConfig); db.all("SELECT setting_key, setting_value FROM settings", [], (err, rows) => { if (err) { console.error("AYARLAR YÜKLENEMEDİ:", err.message); db.close(); return callback(err); } rows.forEach(row => { settings[row.setting_key] = row.setting_value; }); console.log("Ayarlar veritabanından başarıyla yüklendi."); db.close(); callback(null); }); }
app.get('/viewer', async (req, res) => { if (!req.session.isLoggedIn) { return res.redirect('/'); } const latestEmail = await getLatestEmail(); const db = createClient(dbConfig); db.get("SELECT setting_value FROM settings WHERE setting_key = 'copy_text'", [], (err, row) => { if (err) { res.status(500).send("Ayar okuma hatası"); db.close(); return; } const copyText = row ? row.setting_value : ''; res.render('viewer', { email: latestEmail, isAdmin: req.session.isAdmin, settings: { ...settings, copy_text: copyText } }); db.close(); }); });
app.post('/update-copy-text', (req, res) => { if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); } const newText = req.body.new_text; const db = createClient(dbConfig); db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'copy_text'", [newText], (err) => { if (err) { return res.status(500).send("Ayar kaydetme hatası"); } else { settings.copy_text = newText; res.redirect('/viewer'); } db.close(); }); });
app.post('/update-azure-settings', (req, res) => { if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); } const { tenant_id, client_id, client_secret, target_user_id } = req.body; const db = createClient(dbConfig); const stmt = db.prepare("UPDATE settings SET setting_value = ? WHERE setting_key = ?"); stmt.run(tenant_id, 'tenant_id'); stmt.run(client_id, 'client_id'); stmt.run(client_secret, 'client_secret'); stmt.run(target_user_id, 'target_user_id'); stmt.finalize((err) => { if (err) { return res.status(500).send("Azure ayarları kaydedilemedi."); db.close(); return; } loadSettings(() => { msGraphToken = { accessToken: null, expiresAt: 0 }; res.redirect('/viewer'); }); db.close(); }); });
loadSettings((err) => { if (err) { console.error("Sunucu başlatılamadı, ayarlar yüklenemedi."); process.exit(1); } app.listen(PORT, () => { console.log(`Sunucu ${PORT} numaralı portta başarıyla başlatıldı.`); }); });