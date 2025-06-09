// server.js (Cihaz Kilitleme Sistemli NİHAİ SÜRÜM)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const crypto = require('crypto'); // Parmak izi için
const cookieParser = require('cookie-parser'); // Yeni cookie paketi
const SQLiteStore = require('connect-sqlite3')(session);
const app = express();

const PORT = process.env.PORT || 8000;

// --- AYARLAR (Bu bilgileri .env dosyasından okuyacağız) ---
const ADMIN_KEY = process.env.ADMIN_KEY;
const TENANT_ID = process.env.TENANT_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TARGET_USER_ID = process.env.TARGET_USER_ID;

const dbPath = path.join(process.env.RENDER_DISK_MOUNT_PATH || '.', 'keys.db');

// --- Microsoft Graph API Fonksiyonları ---
let msGraphToken = { accessToken: null, expiresAt: 0 };
async function getMsGraphToken() { /* ... Bu fonksiyon aynı kalıyor, değişiklik yok ... */ }
async function getLatestEmail() { /* ... Bu fonksiyon aynı kalıyor, değişiklik yok ... */ }

// --- Express Ayarları ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser()); // Cookie parser'ı kullan
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.dirname(dbPath), table: 'sessions' }),
    secret: 'bu-sifre-daha-da-gizli-olmali-artik',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // Oturum cookie'si 30 gün
}));

// --- Rotalar ---
app.get('/', (req, res) => { res.render('login', { error: null }); });

app.post('/login', (req, res) => {
    const userKey = req.body.key;
    if (userKey === ADMIN_KEY) {
        req.session.isLoggedIn = true;
        req.session.isAdmin = true;
        return res.redirect('/viewer');
    }

    const db = new sqlite3.Database(dbPath);
    db.get("SELECT first_used_at, device_fingerprint FROM access_keys WHERE key = ?", [userKey], (err, row) => {
        if (err || !row) {
            db.close();
            return res.render('login', { error: 'Geçersiz anahtar.' });
        }

        const userFingerprint = req.cookies.device_fp;

        // 1. KONTROL: Anahtar daha önce başka bir cihaza kilitlenmiş mi?
        if (row.device_fingerprint !== null && row.device_fingerprint !== userFingerprint) {
            db.close();
            return res.render('login', { error: 'Bu anahtar başka bir cihaza kilitlenmiştir.' });
        }
        
        // 2. KONTROL: Süre dolmuş mu? (Sadece ilk kullanım değilse)
        if (row.first_used_at !== null) {
            const firstUsedDate = new Date(row.first_used_at);
            const expiryDate = new Date(firstUsedDate);
            expiryDate.setDate(firstUsedDate.getDate() + 30);
            if (new Date() > expiryDate) {
                db.close();
                return res.render('login', { error: 'Bu anahtarın 1 aylık kullanım süresi dolmuştur.' });
            }
        }
        
        // Giriş başarılı, oturumu başlat
        req.session.isLoggedIn = true;
        req.session.isAdmin = false;
        req.session.userKey = userKey;

        // 3. EYLEM: Eğer ilk kullanım ise, cihaza kilitle
        if (row.device_fingerprint === null) {
            const newFingerprint = crypto.randomBytes(16).toString('hex');
            res.cookie('device_fp', newFingerprint, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'strict' });
            
            db.run("UPDATE access_keys SET first_used_at = ?, device_fingerprint = ? WHERE key = ?", [new Date().toISOString(), newFingerprint, userKey], (updateErr) => {
                db.close();
                if (updateErr) { return res.render('login', { error: 'Veritabanı güncellenirken bir hata oluştu.' }); }
                res.redirect('/viewer');
            });
        } else {
            // Cihaz zaten kilitli ve doğru, sadece giriş yap
            db.close();
            res.redirect('/viewer');
        }
    });
});

app.get('/viewer', async (req, res) => {
    if (!req.session.isLoggedIn) { return res.redirect('/'); }
    const db = new sqlite3.Database(dbPath);
    db.get("SELECT setting_value FROM settings WHERE setting_key = 'copy_text'", [], async (err, row) => {
        db.close();
        if (err) { return res.status(500).send("Ayar okuma hatası"); }
        const copyText = row ? row.setting_value : '';
        const latestEmail = await getLatestEmail();
        res.render('viewer', { email: latestEmail, isAdmin: req.session.isAdmin, copyText: copyText });
    });
});

app.post('/update-copy-text', (req, res) => {
    if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); }
    const newText = req.body.new_text;
    const db = new sqlite3.Database(dbPath);
    db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'copy_text'", [newText], (err) => {
        db.close();
        if (err) { return res.status(500).send("Ayar kaydetme hatası"); }
        res.redirect('/viewer');
    });
});

app.get('/logout', (req, res) => {
    res.clearCookie('device_fp'); // Parmak izi cookie'sini de temizle
    req.session.destroy(() => { res.redirect('/'); });
});

app.listen(PORT, () => { console.log(`Sunucu ${PORT} numaralı portta başarıyla başlatıldı.`); });

// Kodun tamamını yapıştırmak için aynı kalan fonksiyonlar
async function getMsGraphToken() { if (msGraphToken.accessToken && Date.now() < msGraphToken.expiresAt) { return msGraphToken.accessToken; } if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) { console.log("Azure ayarları .env dosyasında eksik."); return null; } const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`; const params = new URLSearchParams(); params.append('grant_type', 'client_credentials'); params.append('client_id', CLIENT_ID); params.append('client_secret', CLIENT_SECRET); params.append('scope', 'https://graph.microsoft.com/.default'); try { const response = await axios.post(tokenUrl, params); msGraphToken.accessToken = response.data.access_token; msGraphToken.expiresAt = Date.now() + (response.data.expires_in - 300) * 1000; console.log("Yeni bir Microsoft Graph API token'ı alındı."); return msGraphToken.accessToken; } catch (error) { console.error("HATA: Microsoft'tan token alınamadı.", error.response?.data); return null; } }
async function getLatestEmail() { const accessToken = await getMsGraphToken(); if (!accessToken) return { error: 'API token alınamadı. .env dosyasını kontrol edin.' }; if (!TARGET_USER_ID) return { error: 'Hedef mail adresi .env dosyasında ayarlanmamış.' }; const graphUrl = `https://graph.microsoft.com/v1.0/users/${TARGET_USER_ID}/messages?$filter=from/emailAddress/address eq 'no-reply@account.capcut.com'&$orderby=receivedDateTime desc&$top=1&$select=subject,from,receivedDateTime,body`; try { const response = await axios.get(graphUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } }); return response.data.value.length > 0 ? response.data.value[0] : null; } catch (error) { return { error: `Mail çekilemedi: ${error.response?.data?.error?.message}` }; } }