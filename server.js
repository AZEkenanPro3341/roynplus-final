// server.js (Tüm Hataları Düzeltilmiş FİNAL SÜRÜM)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const SQLiteStore = require('connect-sqlite3')(session);
const app = express();

const PORT = process.env.PORT || 8000;
const ADMIN_KEY = process.env.ADMIN_KEY;

const dbPath = path.join(process.env.RENDER_DISK_MOUNT_PATH || '.', 'keys.db');
let settings = {};

// AYARLARI YÜKLEME FONKSİYONU GERİ EKLENDİ
function loadSettings(callback) {
    const db = new sqlite3.Database(dbPath);
    db.all("SELECT setting_key, setting_value FROM settings", [], (err, rows) => {
        db.close();
        if (err) { return callback(err); }
        rows.forEach(row => { settings[row.setting_key] = row.setting_value; });
        console.log("Ayarlar başarıyla yüklendi.");
        callback(null);
    });
}

// --- Microsoft Graph API Fonksiyonları ---
let msGraphToken = { accessToken: null, expiresAt: 0 };
async function getMsGraphToken() {
    if (msGraphToken.accessToken && Date.now() < msGraphToken.expiresAt) { return msGraphToken.accessToken; }
    if (!settings.tenant_id || !settings.client_id || !settings.client_secret) { console.log("Azure ayarları veritabanında eksik."); return null; }
    const tokenUrl = `https://login.microsoftonline.com/${settings.tenant_id}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', settings.client_id);
    params.append('client_secret', settings.client_secret);
    params.append('scope', 'https://graph.microsoft.com/.default');
    try {
        const response = await axios.post(tokenUrl, params);
        msGraphToken.accessToken = response.data.access_token;
        msGraphToken.expiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
        return msGraphToken.accessToken;
    } catch (error) { console.error("HATA: Microsoft'tan token alınamadı.", error.response?.data); return null; }
}

async function getLatestEmail() {
    const accessToken = await getMsGraphToken();
    if (!accessToken) return { error: 'API token alınamadı. Ayarları kontrol edin.' };
    if (!settings.target_user_id) return { error: 'Hedef mail adresi ayarlanmamış.' };

    // DÜZELTME: API isteği basitleştirildi ($orderby kaldırıldı)
    const graphUrl = `https://graph.microsoft.com/v1.0/users/${settings.target_user_id}/messages?$filter=from/emailAddress/address eq 'no-reply@account.capcut.com'&$top=20&$select=subject,from,receivedDateTime,body`;
    try {
        const response = await axios.get(graphUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        const messages = response.data.value;

        // DÜZELTME: Sıralama işlemi artık kod içinde yapılıyor
        if (messages && messages.length > 0) {
            messages.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
            return messages[0]; // En yeni olanı döndür
        }
        return null;
    } catch (error) { return { error: `Mail çekilemedi: ${error.response?.data?.error?.message}` }; }
}

// --- Express Ayarları ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.dirname(dbPath), table: 'sessions' }),
    secret: 'cok-gizli-bir-anahtar-daha',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// --- Rotalar ---
app.get('/', (req, res) => { res.render('login', { error: null }); });

app.post('/login', (req, res) => {
    // ... Bu fonksiyon aynı kalıyor, değişiklik yok ...
    const userKey = req.body.key;
    if (userKey === ADMIN_KEY) { req.session.isLoggedIn = true; req.session.isAdmin = true; return res.redirect('/viewer'); }
    const db = new sqlite3.Database(dbPath);
    db.get("SELECT is_locked FROM access_keys WHERE key = ?", [userKey], (err, row) => {
        if (err || !row) { db.close(); return res.render('login', { error: 'Geçersiz anahtar.' }); }
        if (row.is_locked === 1) { db.close(); return res.render('login', { error: 'Bu anahtar daha önce aktif edilmiştir ve paylaşılamaz.' }); }
        db.run("UPDATE access_keys SET is_locked = 1, first_used_at = ? WHERE key = ?", [new Date().toISOString(), userKey], (updateErr) => {
            if (updateErr) { db.close(); return res.render('login', { error: 'Veritabanı güncellenirken bir hata oluştu.' }); }
            req.session.isLoggedIn = true; req.session.isAdmin = false;
            db.close(); res.redirect('/viewer');
        });
    });
});

app.get('/viewer', async (req, res) => {
    if (!req.session.isLoggedIn) { return res.redirect('/'); }
    const latestEmail = await getLatestEmail();
    res.render('viewer', { email: latestEmail, isAdmin: req.session.isAdmin, settings: settings });
});

// EKSİK OLAN /update-azure-settings ROTASI GERİ EKLENDİ
app.post('/update-azure-settings', (req, res) => {
    if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); }
    const { tenant_id, client_id, client_secret, target_user_id } = req.body;
    const db = new sqlite3.Database(dbPath);
    const stmt = db.prepare("UPDATE settings SET setting_value = ? WHERE setting_key = ?");
    stmt.run(tenant_id, 'tenant_id');
    stmt.run(client_id, 'client_id');
    stmt.run(client_secret, 'client_secret');
    stmt.run(target_user_id, 'target_user_id');
    stmt.finalize((err) => {
        db.close();
        if (err) { return res.status(500).send("Azure ayarları kaydedilemedi."); }
        // Ayarları yeniden yükle
        loadSettings(() => {
            msGraphToken = { accessToken: null, expiresAt: 0 }; // Token'ı sıfırla
            res.redirect('/viewer');
        });
    });
});


app.get('/logout', (req, res) => { req.session.destroy(() => { res.redirect('/'); }); });

// Sunucu başlamadan önce ayarları yükle
loadSettings((err) => {
    if (err) { console.error("Sunucu başlatılamadı, ayarlar yüklenemedi."); process.exit(1); }
    app.listen(PORT, () => { console.log(`Sunucu ${PORT} numaralı portta başarıyla başlatıldı.`); });
});