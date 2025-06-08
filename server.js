// server.js (NORMAL ÇALIŞAN FİNAL SÜRÜM - SÜRE 30 GÜN)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const SQLiteStore = require('connect-sqlite3')(session);
const app = express();

const PORT = process.env.PORT || 8000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'BDaP5924';

const dbPath = path.join(process.env.RENDER_DISK_MOUNT_PATH || '.', 'keys.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error("Veritabanı ana bağlantı hatası:", err.message); } 
    else { console.log(`Veritabanı ana bağlantısı başarılı: ${dbPath}`); }
});

let settings = {};

function loadSettings(callback) {
    db.all("SELECT setting_key, setting_value FROM settings", [], (err, rows) => {
        if (err) { console.error("AYARLAR YÜKLENEMEDİ:", err.message); return callback(err); }
        rows.forEach(row => { settings[row.setting_key] = row.setting_value; });
        console.log("Ayarlar veritabanından başarıyla yüklendi.");
        callback(null);
    });
}

// --- Microsoft Graph API Fonksiyonları ---
let msGraphToken = { accessToken: null, expiresAt: 0 };
async function getMsGraphToken() { if (msGraphToken.accessToken && Date.now() < msGraphToken.expiresAt) { return msGraphToken.accessToken; } if (!settings.tenant_id || !settings.client_id || !settings.client_secret) { console.log("Azure ayarları eksik, token alınamıyor."); return null; } const tokenUrl = `https://login.microsoftonline.com/${settings.tenant_id}/oauth2/v2.0/token`; const params = new URLSearchParams(); params.append('grant_type', 'client_credentials'); params.append('client_id', settings.client_id); params.append('client_secret', settings.client_secret); params.append('scope', 'https://graph.microsoft.com/.default'); try { const response = await axios.post(tokenUrl, params); msGraphToken.accessToken = response.data.access_token; msGraphToken.expiresAt = Date.now() + (response.data.expires_in - 300) * 1000; console.log("Yeni bir Microsoft Graph API token'ı alındı."); return msGraphToken.accessToken; } catch (error) { console.error("HATA: Microsoft'tan token alınamadı.", error.response?.data); return null; } }
async function getLatestEmail() { const accessToken = await getMsGraphToken(); if (!accessToken) return { error: 'API token alınamadı. Lütfen admin panelinden Azure ayarlarını kontrol edin.' }; if (!settings.target_user_id) return { error: 'Hedef mail adresi admin panelinde ayarlanmamış.' }; const graphUrl = `https://graph.microsoft.com/v1.0/users/${settings.target_user_id}/messages?$filter=from/emailAddress/address eq 'no-reply@account.capcut.com'&$top=20&$select=subject,from,receivedDateTime,body`; try { const response = await axios.get(graphUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } }); const messages = response.data.value; if (messages && messages.length > 0) { messages.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime)); return messages[0]; } else { return null; } } catch (error) { const errorMessage = error.response?.data?.error?.message || error.message; return { error: `Mail çekilemedi: ${errorMessage}` }; } }

// --- Express Ayarları ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: path.dirname(dbPath),
        table: 'sessions'
    }),
    secret: 'klavyemden-cıkan-cok-gizli-kelimeler-2',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
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
    db.get("SELECT first_used_at FROM access_keys WHERE key = ?", [userKey], (err, row) => {
        if (err) { return res.render('login', { error: 'Bir veritabanı hatası oluştu.' }); }
        if (row) {
            req.session.isAdmin = false;
            if (row.first_used_at === null) {
                const now = new Date().toISOString();
                db.run("UPDATE access_keys SET first_used_at = ? WHERE key = ?", [now, userKey], (updateErr) => {
                    if (updateErr) { return res.render('login', { error: 'Veritabanı güncellenirken bir hata oluştu.' }); }
                    req.session.isLoggedIn = true; res.redirect('/viewer');
                });
            } else {
                const firstUsedDate = new Date(row.first_used_at); 
                const expiryDate = new Date(firstUsedDate);
                // -------> TEKRAR NORMAL HALİNE DÖNDÜ <-------
                expiryDate.setDate(firstUsedDate.getDate() + 30); 
                if (expiryDate > new Date()) { 
                    req.session.isLoggedIn = true; res.redirect('/viewer'); 
                } else { 
                    res.render('login', { error: 'Girdiğiniz anahtarın 1 aylık kullanım süresi dolmuş.' }); 
                }
            }
        } else { res.render('login', { error: 'Geçersiz anahtar.' }); }
    });
});

app.get('/viewer', async (req, res) => {
    if (!req.session.isLoggedIn) { return res.redirect('/'); }
    const latestEmail = await getLatestEmail();
    res.render('viewer', { email: latestEmail, isAdmin: req.session.isAdmin, settings: settings });
});

app.post('/update-copy-text', (req, res) => {
    if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); }
    const newText = req.body.new_text;
    db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'copy_text'", [newText], (err) => {
        if (err) { return res.status(500).send("Ayar kaydetme hatası"); }
        settings.copy_text = newText;
        res.redirect('/viewer');
    });
});

app.post('/update-azure-settings', (req, res) => {
    if (!req.session.isAdmin) { return res.status(403).send("Yetkiniz yok."); }
    const { tenant_id, client_id, client_secret, target_user_id } = req.body;
    const stmt = db.prepare("UPDATE settings SET setting_value = ? WHERE setting_key = ?");
    stmt.run(tenant_id, 'tenant_id');
    stmt.run(client_id, 'client_id');
    stmt.run(client_secret, 'client_secret');
    stmt.run(target_user_id, 'target_user_id');
    stmt.finalize((err) => {
        if (err) { return res.status(500).send("Azure ayarları kaydedilemedi."); }
        loadSettings(() => {
            msGraphToken = { accessToken: null, expiresAt: 0 };
            res.redirect('/viewer');
        });
    });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// Sunucuyu başlatmadan önce ayarları yükle
loadSettings((err) => {
    if (err) {
        console.error("Sunucu başlatılamadı, ayarlar yüklenemedi.");
        process.exit(1);
    }
    app.listen(PORT, () => { console.log(`Sunucu ${PORT} numaralı portta başarıyla başlatıldı.`); });
});