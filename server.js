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

function loadSettings(callback) {
    const db = createClient(dbConfig);
    db.all("SELECT setting_key, setting_value FROM settings", [], (err, rows) => {
        if (err) { console.error("AYARLAR YÜKLENEMEDİ:", err.message); db.close(); return callback(err); }
        rows.forEach(row => { settings[row.setting_key] = row.setting_value; });
        console.log("Ayarlar veritabanından başarıyla yüklendi.");
        db.close();
        callback(null);
    });
}

let msGraphToken = { accessToken: null, expiresAt: 0 };
async function getMsGraphToken() { /* ... Bu fonksiyon aynı kalıyor, değişiklik yok ... */ }
async function getLatestEmail() { /* ... Bu fonksiyon aynı kalıyor, değişiklik yok ... */ }

// --- Express Ayarları ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.dirname(dbConfig.url.startsWith('libsql') ? './' : dbConfig.url), table: 'sessions' }),
    secret: 'klavyemden-cıkan-cok-gizli-kelimeler-2',
    resave: false,
    saveUninitialized: false,
}));

// --- Rotalar ---
app.get('/', (req, res) => { res.render('login', { error: null }); });

app.post('/login', (req, res) => {
    const userKey = req.body.key;
    if (userKey === ADMIN_KEY) {
        req.session.cookie.maxAge = 365 * 24 * 60 * 60 * 1000; // Admin oturumu 1 yıl
        req.session.isLoggedIn = true;
        req.session.isAdmin = true;
        return res.redirect('/viewer');
    }

    const db = createClient(dbConfig);
    // ANAHTAR KİLİTLEME MANTIĞI BURADA
    db.get("SELECT is_locked FROM access_keys WHERE key = ?", [userKey], (err, row) => {
        if (err) {
            res.render('login', { error: 'Bir veritabanı hatası oluştu.' });
            db.close();
            return;
        }

        if (!row) {
            res.render('login', { error: 'Geçersiz anahtar.' });
            db.close();
            return;
        }

        // 1. KONTROL: Anahtar daha önce kullanılıp kilitlenmiş mi?
        if (row.is_locked === 1) {
            res.render('login', { error: 'Bu anahtar daha önce başka bir kullanıcı tarafından aktif edilmiştir ve paylaşılamaz.' });
            db.close();
            return;
        }

        // Eğer kilitli değilse (ilk ve tek kullanım)...
        const now = new Date();
        const expiryDate = new Date(now);
        expiryDate.setDate(now.getDate() + 30); // Süreyi 30 gün olarak ayarla

        const remainingTime = expiryDate.getTime() - now.getTime();
        
        // Oturum süresini ayarla
        if (remainingTime > 0) {
            req.session.cookie.maxAge = remainingTime;
        }
        
        req.session.isLoggedIn = true;
        req.session.isAdmin = false;

        // Veritabanını GÜNCELLE ve KİLİTLE
        db.run("UPDATE access_keys SET first_used_at = ?, is_locked = 1 WHERE key = ?", [now.toISOString(), userKey], (updateErr) => {
            if (updateErr) {
                res.render('login', { error: 'Veritabanı güncellenirken bir hata oluştu.' });
            } else {
                res.redirect('/viewer');
            }
            db.close();
        });
    });
});

app.get('/viewer', async (req, res) => { /* ... Bu rota aynı kalıyor ... */ });
app.post('/update-copy-text', (req, res) => { /* ... Bu rota aynı kalıyor ... */ });
app.post('/update-azure-settings', (req, res) => { /* ... Bu rota aynı kalıyor ... */ });
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// Karışıklık olmasın diye tam kodu tekrar yapıştırıyorum
async function getMsGraphToken() { if (msGraphToken.accessToken && Date.now() < msGraphToken.expiresAt) { return msGraphToken.accessToken; } if (!settings.tenant_id || !settings.client_id || !settings.client_secret) { console.log("Azure ayarları eksik, token alınamıyor."); return null; } const tokenUrl = `https://login.microsoftonline.com/${settings.tenant_id}/oauth2/v2.0/token`; const params = new URLSearchParams(); params.append('grant_type', 'client_credentials'); params.append('client_id', settings.client_id); params.append('client_secret', settings.client_secret); params.append('scope', 'https://graph.microsoft.com/.default'); try { const response = await axios.post(tokenUrl, params); msGraphToken.accessToken = response.data.access_token; msGraphToken.expiresAt = Date.now() + (response.data.expires_in - 300) * 1000; console.log("Yeni bir Microsoft Graph API token'ı alındı."); return msGraphToken.accessToken; } catch (error) { console.error("HATA: Microsoft'tan token alınamadı.", error.response?.data); return null; } }
async function getLatestEmail() { const accessToken = await getMsGraphToken(); if (!accessToken) return { error: 'API token alınamadı. Lütfen admin panelinden Azure ayarlarını kontrol edin.' }; if (!settings.target_user_id) return { error: 'Hedef mail adresi admin panelinde ayarlanmamış.' }; const graphUrl = `https://graph.microsoft.com/v1.0/users/${settings.target_user_id}/messages?$filter=from/emailAddress/address eq 'no-reply@account.capcut.com'&$top=20&$select=subject,from,receivedDateTime,body`; try { const response = await axios.get(graphUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } }); const messages = response.data.value; if (messages && messages.length > 0) { messages.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime)); return messages[0]; } else { return null; } } catch (error) { const errorMessage = error.response?.data?.error?.message || error.message; return { error: `Mail çekilemedi: ${errorMessage}` }; } }
app.get('/viewer', async (req, res) => { if (!req.session.isLoggedIn) { return res.redirect('/'); } loadSettings(async () => { const latestEmail = await getLatestEmail(); const db = createClient(dbConfig); db.get("SELECT setting_value FROM settings WHERE setting_key = 'copy_text'", [], (err, row) => { if (err) { res.status(500).send("Ayar okuma hatası"); db.close(); return; } const copyText = row ? row.setting_value : ''; res.render('viewer', { email: latestEmail, isAdmin: req.session.isAdmin, settings: { ...settings, copy_text: copyText } }); db.close(); }); }); });
app.post('/update-copy-text', (req, res) => { if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); } const newText = req.body.new_text; const db = createClient(dbConfig); db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'copy_text'", [newText], (err) => { if (err) { return res.status(500).send("Ayar kaydetme hatası"); } else { settings.copy_text = newText; res.redirect('/viewer'); } db.close(); }); });
app.post('/update-azure-settings', (req, res) => { if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); } const { tenant_id, client_id, client_secret, target_user_id } = req.body; const db = createClient(dbConfig); const stmt = db.prepare("UPDATE settings SET setting_value = ? WHERE setting_key = ?"); stmt.run(tenant_id, 'tenant_id'); stmt.run(client_id, 'client_id'); stmt.run(client_secret, 'client_secret'); stmt.run(target_user_id, 'target_user_id'); stmt.finalize((err) => { if (err) { return res.status(500).send("Azure ayarları kaydedilemedi."); db.close(); return; } loadSettings(() => { msGraphToken = { accessToken: null, expiresAt: 0 }; res.redirect('/viewer'); }); db.close(); }); });

loadSettings((err) => {
    if (err) {
        console.error("Sunucu başlatılamadı, ayarlar yüklenemedi.");
        process.exit(1);
    }
    app.listen(PORT, () => { console.log(`Sunucu ${PORT} numaralı portta başarıyla başlatıldı.`); });
});