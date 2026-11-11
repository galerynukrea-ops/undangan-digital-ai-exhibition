require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const multer = require('multer');
const csv = require('csv-parser');
const QRCode = require('qrcode');
const crypto = require('node:crypto');
const uuidv4 = () => crypto.randomUUID();

const { db, generateToken, resetAttendanceOnly, seedDatabase, sampleInstitutions } = require('./db');
const { getCloudGuests, saveGuestToCloud, deleteGuestFromCloud, resetCloudGuests, getLastCloudError, isGuestDeleted, getDeletedGuestIds, getResetEpoch, isBeforeResetEpoch } = require('./cloudStore');
const { analyzeSentiment, localAnalyzeSentiment } = require('./aiService');
const { generateVenueStandeePdf, PALETTE, EVENT_DETAILS } = require('./pdfService');
const { addClient, broadcastEvent } = require('./sseService');
const { checkProfanity, censorProfanity, sanitizeInput, checkRateLimit } = require('./securityFilter');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || 'admin111126';

// Middleware for Admin PIN Verification (Guards reset, delete, and emergency operations)
function requireAdmin(req, res, next) {
    const providedPin = req.headers['x-admin-pin'] || req.body?.pin || req.query?.pin;
    if (providedPin === ADMIN_PIN) {
        return next();
    }
    return res.status(401).json({
        success: false,
        error: 'Akses ditolak: PIN Admin salah atau belum diautentikasi.'
    });
}

// Helper to get local network IPv4 address for smartphone access
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

// Middleware
app.use(cors());

// Strict No-Cache headers for all API routes to prevent Vercel CDN & browser edge caching glitches
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Multer setup for CSV upload (Use /tmp on Vercel to prevent EROFS read-only filesystem crash)
const uploadsDir = process.env.VERCEL ? '/tmp/uploads' : path.join(__dirname, '..', 'data', 'uploads');
try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
} catch (e) {
    console.warn('[Uploads] Safe fallback for uploads directory:', e.message);
}
const upload = multer({ dest: uploadsDir });

// Helper to resolve check-in URL dynamically (Domain on Vercel vs LAN IP on Local)
function resolveCheckinUrl(req) {
    if (req.query.url && req.query.url.trim() !== '') {
        return req.query.url.trim();
    }
    if (req.query.ip && req.query.ip.trim() !== '') {
        const ip = req.query.ip.trim();
        if (ip.startsWith('http://') || ip.startsWith('https://')) {
            return ip;
        }
        return `http://${ip}:${PORT}/checkin`;
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    if (process.env.VERCEL || (host && !host.includes('localhost') && !host.includes('127.0.0.1'))) {
        return `https://${host || 'bukutamuexhibition.vercel.app'}/checkin`;
    }
    return `http://${getLocalIpAddress()}:${PORT}/checkin`;
}

// Helper to resolve post-event feedback URL dynamically
function resolveFeedbackUrl(req) {
    if (req.query.url && req.query.url.trim() !== '') {
        return req.query.url.trim();
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    if (process.env.VERCEL || (host && !host.includes('localhost') && !host.includes('127.0.0.1'))) {
        return `https://${host || 'bukutamuexhibition.vercel.app'}/feedback`;
    }
    return `http://${getLocalIpAddress()}:${PORT}/feedback`;
}

// -------------------------------------------------------------
// REST API: Network Info for Smartphone Testing
// -------------------------------------------------------------
app.get('/api/network-info', (req, res) => {
    const isVercel = !!process.env.VERCEL;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const isPublicHost = host && !host.includes('localhost') && !host.includes('127.0.0.1');
    const baseUrl = (isVercel || isPublicHost) ? `${proto}://${host || 'bukutamuexhibition.vercel.app'}` : `http://${getLocalIpAddress()}:${PORT}`;
    const localIp = getLocalIpAddress();

    res.json({
        success: true,
        isVercel,
        host,
        localIp,
        port: PORT,
        baseUrl,
        checkinUrl: `${baseUrl}/checkin`,
        feedbackUrl: `${baseUrl}/feedback`,
        feedbackPrintUrl: `${baseUrl}/feedback/print`,
        liveUrl: `${baseUrl}/live`,
        standeeUrl: `${baseUrl}/standee`
    });
});

// Bi-directional Consensus Synchronizer (Zero Data-Loss, Accretive Safe with Tombstones & Reset Epoch Guard)
async function syncLocalDbWithCloud() {
    try {
        const deletedIds = getDeletedGuestIds();
        if (deletedIds && deletedIds.size > 0) {
            for (const dId of deletedIds) {
                try {
                    db.prepare('DELETE FROM guests WHERE id = ?').run(dId);
                    db.prepare('DELETE FROM guest_messages WHERE guest_id = ?').run(dId);
                } catch (e) {}
            }
        }

        // 1. Purge any stale local SQLite records that belong to before the latest reset epoch
        const allLocal = db.prepare('SELECT id, created_at, checked_in_at FROM guests').all() || [];
        for (const row of allLocal) {
            const time = row.created_at || row.checked_in_at;
            if (isBeforeResetEpoch(time)) {
                try {
                    db.prepare('DELETE FROM guests WHERE id = ?').run(row.id);
                    db.prepare('DELETE FROM guest_messages WHERE guest_id = ?').run(row.id);
                } catch (e) {}
            }
        }

        const cloudGuests = await getCloudGuests();
        if (Array.isArray(cloudGuests) && cloudGuests.length > 0) {
            // Insert or update records from Cloud Store into local SQLite
            const insertGuest = db.prepare(`
                INSERT OR REPLACE INTO guests (id, name, institution, category, qr_token, status, checked_in_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertMsg = db.prepare(`
                INSERT OR REPLACE INTO guest_messages (id, guest_id, message, impression, feedback, sentiment, score, emotion, keywords, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const g of cloudGuests) {
                if (!g.id || !g.name || isGuestDeleted(g.id)) continue;
                if (isBeforeResetEpoch(g.created_at || g.checked_in_at)) continue;
                try {
                    insertGuest.run(
                        g.id,
                        g.name || '',
                        g.institution || 'Tamu Undangan',
                        g.category || 'Mitra / Tamu',
                        g.qr_token || generateToken(),
                        g.status || 'checked_in',
                        g.checked_in_at || g.created_at || new Date().toISOString(),
                        g.created_at || new Date().toISOString()
                    );
                    if (g.message || g.impression || g.feedback) {
                        insertMsg.run(
                            uuidv4(),
                            g.id,
                            g.message || '',
                            g.impression || '',
                            g.feedback || '',
                            g.sentiment || 'positive',
                            g.score !== undefined ? g.score : 0.8,
                            g.emotion || 'Optimis',
                            '[]',
                            g.checked_in_at || new Date().toISOString()
                        );
                    }
                } catch (e) {}
            }
        }

        // If local DB has new guests that Cloud Store doesn't have yet, push them to Cloud Store
        if (Array.isArray(cloudGuests)) {
            const cloudIds = new Set(cloudGuests.map(g => g.id));
            const localGuests = db.prepare(`
                SELECT g.*, m.message, m.impression, m.feedback, m.sentiment, m.score, m.emotion 
                FROM guests g 
                LEFT JOIN guest_messages m ON g.id = m.guest_id
            `).all() || [];

            for (const lg of localGuests) {
                if (isBeforeResetEpoch(lg.created_at || lg.checked_in_at)) {
                    // Stale guest from before reset: purge from sqlite, NEVER upload!
                    try {
                        db.prepare('DELETE FROM guests WHERE id = ?').run(lg.id);
                        db.prepare('DELETE FROM guest_messages WHERE guest_id = ?').run(lg.id);
                    } catch (e) {}
                    continue;
                }
                if (lg.id && lg.name && !cloudIds.has(lg.id) && !isGuestDeleted(lg.id)) {
                    await saveGuestToCloud(lg);
                }
            }
        }
        return cloudGuests;
    } catch (err) {
        console.warn('[Sync] Cloud sync notice:', err.message);
    }
    return null;
}

// -------------------------------------------------------------
// REST API: Guests (Institutions) Management
// -------------------------------------------------------------

// 1. Get all institutions with query filters (Synced with Cloud Store across all Vercel instances)
app.get('/api/guests', async (req, res) => {
    try {
        const { search, category, status } = req.query;

        // Auto-hydrate from authoritative Cloud Store
        await syncLocalDbWithCloud();

        let query = `
            SELECT g.*, m.message, m.sentiment, m.score, m.emotion, m.keywords, m.impression, m.feedback
            FROM guests g
            LEFT JOIN guest_messages m ON g.id = m.guest_id
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (g.name LIKE ? OR g.institution LIKE ? OR g.qr_token LIKE ? OR g.category LIKE ?)`;
            const searchParam = `%${search.trim()}%`;
            params.push(searchParam, searchParam, searchParam, searchParam);
        }

        if (category && category !== 'all') {
            query += ` AND g.category = ?`;
            params.push(category);
        }

        if (status && status !== 'all') {
            query += ` AND g.status = ?`;
            params.push(status);
        }

        query += ` ORDER BY CASE WHEN g.status = 'checked_in' THEN 0 ELSE 1 END, g.checked_in_at DESC, g.created_at DESC`;

        const guests = db.prepare(query).all(...params);
        res.json({ success: true, count: guests.length, data: guests });
    } catch (err) {
        console.error('[API] Error get guests:', err.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil data instansi tamu' });
    }
});

// 1b. Self-Healing Sync: Restore known guests if container was newly spawned
app.post('/api/guests/sync', (req, res) => {
    try {
        const { guests } = req.body;
        if (!Array.isArray(guests) || guests.length === 0) {
            return res.json({ success: true, message: 'No guests to sync' });
        }

        const insertGuest = db.prepare(`
            INSERT OR REPLACE INTO guests (id, name, institution, category, qr_token, status, checked_in_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMsg = db.prepare(`
            INSERT OR REPLACE INTO guest_messages (id, guest_id, message, sentiment, score, emotion, keywords, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const g of guests) {
            if (!g.id || !g.institution || isGuestDeleted(g.id)) continue;
            try {
                insertGuest.run(
                    g.id,
                    g.name || '',
                    g.institution,
                    g.category || 'Mitra Tambahan',
                    g.qr_token || generateToken(),
                    g.status || 'checked_in',
                    g.checked_in_at || new Date().toISOString(),
                    g.created_at || new Date().toISOString()
                );

                if (g.message) {
                    insertMsg.run(
                        uuidv4(),
                        g.id,
                        g.message,
                        g.sentiment || 'positive',
                        g.score !== undefined ? g.score : 0.8,
                        g.emotion || 'Optimis',
                        g.keywords || '[]',
                        g.checked_in_at || new Date().toISOString()
                    );
                }
            } catch (err) {}
        }

        const all = db.prepare('SELECT * FROM guests').all();
        res.json({ success: true, count: all.length });
    } catch (err) {
        console.error('[API] Sync error:', err.message);
        res.status(500).json({ success: false, error: 'Gagal sinkronisasi data tamu' });
    }
});

// 2. Add single institution / guest
app.post('/api/guests', (req, res) => {
    try {
        const { name, institution, category } = req.body;
        if (!institution || institution.trim() === '') {
            return res.status(400).json({ success: false, error: 'Nama instansi/perusahaan wajib diisi' });
        }

        const id = uuidv4();
        const token = generateToken();
        const finalCategory = category && category.trim() !== '' ? category.trim() : 'Mitra Tambahan';
        const finalName = name ? name.trim() : '';

        const stmt = db.prepare(`
            INSERT INTO guests (id, name, institution, category, qr_token, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
        `);

        stmt.run(id, finalName, institution.trim(), finalCategory, token);

        const newGuest = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
        res.status(201).json({ success: true, message: 'Tamu / Instansi berhasil ditambahkan', data: newGuest });
    } catch (err) {
        console.error('[API] Error create guest:', err.message);
        res.status(500).json({ success: false, error: 'Gagal menambahkan data instansi' });
    }
});

// 3. Import institutions from CSV
app.post('/api/guests/import', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'File CSV tidak ditemukan' });
    }

    const filePath = req.file.path;
    const importedGuests = [];

    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
            const institution = row.institution || row.INSTANSI || row.Instansi || row.perusahaan || row.name || row.Nama;
            if (institution && institution.trim()) {
                importedGuests.push({
                    institution: institution.trim(),
                    category: (row.category || row.Kategori || row.KATEGORI || 'Mitra / Instansi').trim()
                });
            }
        })
        .on('end', () => {
            try {
                fs.unlinkSync(filePath);
                if (importedGuests.length === 0) {
                    return res.status(400).json({ success: false, error: 'Tidak ada data valid yang ditemukan di CSV' });
                }

                const insertStmt = db.prepare(`
                    INSERT INTO guests (id, institution, category, qr_token, status)
                    VALUES (?, ?, ?, ?, 'pending')
                `);

                let inserted = 0;
                for (const g of importedGuests) {
                    insertStmt.run(uuidv4(), g.institution, g.category, generateToken());
                    inserted++;
                }

                res.json({ success: true, message: `Berhasil mengimpor ${inserted} instansi/perusahaan`, count: inserted });
            } catch (dbErr) {
                console.error('[API] DB error during import:', dbErr.message);
                res.status(500).json({ success: false, error: 'Gagal menyimpan data import ke database' });
            }
        })
        .on('error', (err) => {
            console.error('[API] CSV parse error:', err.message);
            res.status(500).json({ success: false, error: 'Gagal memproses file CSV' });
        });
});

// 3b. Export guest data to CSV file (RFC 4180 with UTF-8 BOM for Excel compatibility)
app.get(['/api/guests/export/csv', '/api/guests/export'], async (req, res) => {
    try {
        await syncLocalDbWithCloud();

        const guests = db.prepare('SELECT * FROM guests ORDER BY checked_in_at DESC, created_at DESC').all() || [];
        const messages = db.prepare('SELECT * FROM guest_messages').all() || [];

        const formatField = (val) => {
            if (val === null || val === undefined) return '""';
            const str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        };

        const headers = [
            'No',
            'Nama Tamu',
            'Instansi / Perusahaan',
            'Kategori',
            'Status Kehadiran',
            'Waktu Kehadiran (WIB)',
            'Pesan & Kesan',
            'Kritik & Saran',
            'Sentimen Pesan',
            'Emosi Terdeteksi',
            'Kode Token QR'
        ];

        const rows = guests.map((g, idx) => {
            const m = messages.find(x => x.guest_id === g.id) || {};

            let timeStr = '-';
            if (g.checked_in_at) {
                try {
                    const d = new Date(g.checked_in_at);
                    timeStr = d.toLocaleString('id-ID', {
                        timeZone: 'Asia/Jakarta',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    }) + ' WIB';
                } catch (e) {
                    timeStr = g.checked_in_at;
                }
            }

            const statusStr = g.status === 'checked_in' ? 'Hadir (Terverifikasi)' : 'Belum Hadir';

            return [
                idx + 1,
                g.name || '-',
                g.institution || '-',
                g.category || 'Mitra / Tamu',
                statusStr,
                timeStr,
                m.impression || (m.message && m.message !== '-' ? m.message : '-'),
                m.feedback || '-',
                m.sentiment ? m.sentiment.toUpperCase() : '-',
                m.emotion || '-',
                g.qr_token || '-'
            ].map(formatField).join(',');
        });

        const csvContent = '\uFEFF' + [headers.map(formatField).join(','), ...rows].join('\r\n');

        const nowTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `Data_Tamu_Exhibition_Madiun_${nowTag}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.send(csvContent);
    } catch (err) {
        console.error('[API] Error exporting CSV:', err.message);
        res.status(500).send('Gagal mengekspor data tamu ke file CSV');
    }
});

// 4. Delete institution (Supports DELETE, POST /:id/delete, and POST /delete for firewall resilience)
async function handleDeleteGuest(id, res) {
    if (!id) {
        return res.status(400).json({ success: false, error: 'ID instansi diperlukan' });
    }
    try {
        const guestToDelete = db.prepare('SELECT name FROM guests WHERE id = ?').get(id);
        const guestName = guestToDelete ? guestToDelete.name : null;

        await deleteGuestFromCloud(id);
        db.prepare('DELETE FROM guests WHERE id = ?').run(id);
        db.prepare('DELETE FROM guest_messages WHERE guest_id = ?').run(id);
        broadcastEvent('guest_deleted', { id, name: guestName, timestamp: new Date().toISOString() });
        res.json({ success: true, message: 'Data instansi berhasil dihapus', id, name: guestName });
    } catch (err) {
        console.error('[API] Error delete guest:', err.message);
        res.status(500).json({ success: false, error: 'Gagal menghapus data instansi' });
    }
}

app.delete('/api/guests/:id', requireAdmin, async (req, res) => {
    await handleDeleteGuest(req.params.id, res);
});

app.post('/api/guests/:id/delete', requireAdmin, async (req, res) => {
    await handleDeleteGuest(req.params.id, res);
});

app.post('/api/guests/delete', requireAdmin, async (req, res) => {
    const id = req.body?.id || req.query?.id;
    await handleDeleteGuest(id, res);
});

// Admin PIN Verification Endpoint
app.post('/api/admin/verify', (req, res) => {
    const pin = req.body?.pin || req.headers['x-admin-pin'];
    if (pin === ADMIN_PIN) {
        return res.json({ success: true, message: 'Autentikasi PIN Berhasil' });
    }
    return res.status(401).json({ success: false, error: 'PIN Admin tidak sesuai' });
});

// -------------------------------------------------------------
// EMERGENCY CONTROL API (Dikendalikan dari Dashboard Admin untuk Layar Live)
// -------------------------------------------------------------

// 1. Darurat: Sembunyikan Pop-Up Sambutan di Layar Live
app.post('/api/emergency/hide', requireAdmin, (req, res) => {
    broadcastEvent('emergency_hide', { timestamp: new Date().toISOString() });
    res.json({ success: true, message: 'Perintah darurat: Pop-up di layar live berhasil disembunyikan.' });
});

// 2. Darurat: Mute / Unmute Suara Robot AI di Layar Live
app.post('/api/emergency/mute', requireAdmin, (req, res) => {
    const muted = req.body?.muted !== false;
    broadcastEvent('emergency_mute', { muted, timestamp: new Date().toISOString() });
    res.json({ 
        success: true, 
        muted, 
        message: muted ? 'Perintah darurat: Suara Robot AI di layar live dibisukan (MUTE).' : 'Suara Robot AI diaktifkan kembali.' 
    });
});

// 3. Darurat: Hapus Tamu Terakhir & Bersihkan dari Layar / Running Text
app.post('/api/emergency/remove-last', requireAdmin, async (req, res) => {
    try {
        const lastGuest = db.prepare(`SELECT * FROM guests WHERE status = 'checked_in' ORDER BY checked_in_at DESC LIMIT 1`).get();
        if (!lastGuest) {
            return res.status(404).json({ success: false, error: 'Tidak ada tamu yang hadir saat ini untuk dihapus.' });
        }
        await deleteGuestFromCloud(lastGuest.id);
        db.prepare('DELETE FROM guests WHERE id = ?').run(lastGuest.id);
        db.prepare('DELETE FROM guest_messages WHERE guest_id = ?').run(lastGuest.id);
        
        broadcastEvent('guest_deleted', { id: lastGuest.id, name: lastGuest.name, timestamp: new Date().toISOString() });
        broadcastEvent('emergency_hide', { targetId: lastGuest.id, name: lastGuest.name, timestamp: new Date().toISOString() });
        
        return res.json({
            success: true,
            removedGuest: lastGuest.name,
            message: `Tamu "${lastGuest.name}" berhasil dihapus dan dibersihkan dari layar live.`
        });
    } catch (err) {
        console.error('[Emergency] Error removing last guest:', err.message);
        res.status(500).json({ success: false, error: 'Gagal mengeksekusi penghapusan darurat' });
    }
});

// 5. Reset Testing & Attendance Data (Authoritative wipe: 0 guests across all containers & screens)
app.all(['/api/admin/reset', '/api/reset'], requireAdmin, async (req, res) => {
    try {
        const mode = (req.body?.mode || req.query?.mode || 'factory').toLowerCase();
        const resetTimestamp = new Date().toISOString();
        
        // Reset local DB & Global Cloud Store with authoritative Reset Epoch
        await resetCloudGuests(resetTimestamp);
        seedDatabase();

        broadcastEvent('database_reset', { 
            mode, 
            resetTimestamp, 
            timestamp: resetTimestamp 
        });

        return res.json({
            success: true,
            mode,
            resetTimestamp,
            message: 'Seluruh data tamu dan masukan evaluasi berhasil dibersihkan permanen (0 tamu).'
        });
    } catch (err) {
        console.error('[API] Error reset database:', err.message);
        res.status(500).json({ success: false, error: 'Gagal melakukan reset data' });
    }
});

// -------------------------------------------------------------
// REST API: 1 Master Barcode Venue (PDF & PNG)
// -------------------------------------------------------------

// 1. Download Standee Barcode Depan Venue (PDF Siap Cetak A4/A5)
app.get('/api/venue/standee/pdf', async (req, res) => {
    try {
        const checkinUrl = resolveCheckinUrl(req);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="Standee_Barcode_Depan_Venue_A4.pdf"');

        await generateVenueStandeePdf(checkinUrl, res);
    } catch (err) {
        console.error('[PDF] Error generating standee PDF:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Gagal men-generate file PDF Standee Barcode.');
        }
    }
});

// 3. PNG Stream for the 1 Master Barcode Venue (Encodes Local LAN IP or Production Domain)
app.get('/api/venue/barcode/png', async (req, res) => {
    try {
        const checkinUrl = resolveCheckinUrl(req);

        const qrBuffer = await QRCode.toBuffer(checkinUrl, {
            errorCorrectionLevel: 'H',
            width: 500,
            margin: 1,
            color: {
                dark: '#112250',
                light: '#F5F4F0'
            }
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(qrBuffer);
    } catch (err) {
        console.error('[QR] Error generating buffer:', err.message);
        res.status(500).send('Gagal membuat Barcode Venue');
    }
});

// 4. PNG Stream for Post-Event Feedback Barcode (Points to /feedback)
app.get('/api/venue/feedback-barcode/png', async (req, res) => {
    try {
        const feedbackUrl = resolveFeedbackUrl(req);

        const qrBuffer = await QRCode.toBuffer(feedbackUrl, {
            errorCorrectionLevel: 'H',
            width: 500,
            margin: 1,
            color: {
                dark: '#070D1E',
                light: '#FFFFFF'
            }
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(qrBuffer);
    } catch (err) {
        console.error('[QR] Error generating feedback barcode:', err.message);
        res.status(500).send('Gagal membuat Barcode Feedback');
    }
});

// -------------------------------------------------------------
// REST API: Get Preset Institutions List (10 Instansi Resmi Madiun)
// -------------------------------------------------------------
app.get('/api/institutions', (req, res) => {
    try {
        const rows = db.prepare('SELECT DISTINCT institution, category FROM guests WHERE institution IS NOT NULL AND institution != ""').all();
        const seen = new Set(sampleInstitutions.map(s => s.institution.toLowerCase()));
        const combined = [...sampleInstitutions];

        if (Array.isArray(rows)) {
            rows.forEach(r => {
                if (r.institution && !seen.has(r.institution.toLowerCase())) {
                    seen.add(r.institution.toLowerCase());
                    combined.push({ institution: r.institution, category: r.category || 'Mitra Tambahan' });
                }
            });
        }
        res.json({ success: true, count: combined.length, data: combined });
    } catch (e) {
        res.json({ success: true, count: sampleInstitutions.length, data: sampleInstitutions });
    }
});

// -------------------------------------------------------------
// REST API: Check-In & AI Guestbook (Never Rejects, Always Enters Dashboard)
// -------------------------------------------------------------

app.post('/api/checkin/submit', async (req, res) => {
    try {
        const body = req.body || {};

        // 1. Honeypot Anti-Bot Trap (Bila terisi bot otomatis didrop)
        if (body.hp_website || body.bot_trap) {
            console.warn('[Security] Bot trap triggered, discarding submission silently.');
            return res.json({ success: true, message: 'Verifikasi berhasil' });
        }

        // 2. Rate Limiting: Maksimal 2 registrasi per 15 detik per IP/perangkat
        const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
        const rateStatus = checkRateLimit(clientIp, 2, 15000);
        if (!rateStatus.allowed) {
            return res.status(429).json({
                success: false,
                error: 'Terlalu banyak permintaan. Mohon tunggu beberapa detik sebelum melakukan konfirmasi berikutnya.'
            });
        }

        const token = body.token;
        const rawName = (body.name || body.guest_name || '').trim();
        const rawInst = (body.newInstitution || body.institution || '').trim();
        const rawCategory = (body.category || '').trim();
        const rawMessage = (body.message || body.guest_message || '').trim();

        // 3. Sanitasi Input Ketat (Strip script/HTML, batasi karakter)
        let targetName = sanitizeInput(rawName, 50);
        let targetInst = sanitizeInput(rawInst, 50);
        if (targetInst === '__NEW__') targetInst = '';
        if (!targetInst) targetInst = 'Tamu Undangan';
        if (!targetName) targetName = targetInst !== 'Tamu Undangan' ? targetInst : 'Tamu Kehormatan';
        let finalCategory = sanitizeInput(rawCategory, 40) || 'Mitra / Tamu';
        let guestMessage = sanitizeInput(rawMessage, 300) || 'Sukses selalu untuk seluruh talenta muda & kemajuan kecerdasan artifisial di Kota Madiun!';

        // 4. Sensor Kata Kotor / Profanity Filter
        const profanityName = checkProfanity(targetName);
        const profanityInst = checkProfanity(targetInst);
        if (profanityName.isProfane || profanityInst.isProfane) {
            return res.status(400).json({
                success: false,
                error: 'Mohon gunakan nama atau instansi yang santun untuk ditampilkan di layar acara.'
            });
        }
        if (checkProfanity(guestMessage).isProfane) {
            guestMessage = censorProfanity(guestMessage);
        }

        let guest = null;
        if (token) {
            guest = db.prepare('SELECT * FROM guests WHERE qr_token = ?').get(token.trim().toUpperCase());
        }

        const now = new Date().toISOString();

        if (guest) {
            // Update existing pre-registered guest record with their personalized token
            try {
                db.prepare(`
                    UPDATE guests 
                    SET name = ?, status = 'checked_in', checked_in_at = ? 
                    WHERE id = ?
                `).run(targetName, now, guest.id);
            } catch (e) {}
            guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guest.id);
        } else {
            // Standard Event Check-in: Always create a distinct individual guest entry
            const id = uuidv4();
            const newToken = generateToken();
            db.prepare(`
                INSERT INTO guests (id, name, institution, category, qr_token, status, checked_in_at, created_at)
                VALUES (?, ?, ?, ?, ?, 'checked_in', ?, ?)
            `).run(id, targetName, targetInst, finalCategory, newToken, now, now);
            guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
        }

        // Fast instant sentiment analysis via local Indonesian lexicon (<1ms, zero network latency, zero timeout risk)
        const aiResult = localAnalyzeSentiment(guestMessage);

        const msgId = uuidv4();
        db.prepare(`
            INSERT INTO guest_messages (id, guest_id, message, sentiment, score, emotion, keywords, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            msgId,
            guest.id,
            guestMessage,
            aiResult.sentiment,
            aiResult.score,
            aiResult.emotion,
            JSON.stringify(aiResult.keywords)
        );

        // Optional background Gemini refinement (fire-and-forget, non-blocking)
        if (process.env.GEMINI_API_KEY) {
            analyzeSentiment(guestMessage).then(refined => {
                if (refined && refined.provider === 'gemini') {
                    try {
                        db.prepare(`
                            UPDATE guest_messages 
                            SET sentiment = ?, score = ?, emotion = ?, keywords = ?
                            WHERE id = ?
                        `).run(refined.sentiment, refined.score, refined.emotion, JSON.stringify(refined.keywords), msgId);
                    } catch (e) {}
                }
            }).catch(() => {});
        }

        const payload = {
            guest: {
                id: guest.id,
                name: targetName,
                institution: targetInst,
                category: guest.category || finalCategory,
                checked_in_at: now
            },
            message: {
                text: guestMessage,
                sentiment: aiResult.sentiment,
                score: aiResult.score,
                emotion: aiResult.emotion,
                keywords: aiResult.keywords,
                provider: aiResult.provider
            }
        };

        // Real-time broadcast to all connected Live Walls & Dashboard via SSE
        broadcastEvent('guest_checked_in', payload);

        // Save to Global Cloud Store so all Vercel containers stay 100% in sync
        let cloudSaved = false;
        let cloudError = null;
        try {
            cloudSaved = await saveGuestToCloud({
                id: guest.id,
                name: targetName,
                institution: targetInst,
                category: guest.category || finalCategory,
                qr_token: guest.qr_token,
                status: 'checked_in',
                checked_in_at: now,
                created_at: now,
                message: guestMessage,
                sentiment: aiResult.sentiment,
                score: aiResult.score,
                emotion: aiResult.emotion
            });
        } catch (e) {
            cloudError = e.message;
            console.warn('[Checkin] Cloud save warning:', e.message);
        }

        res.json({
            success: true,
            message: `Verifikasi kedatangan berhasil untuk ${targetName}`,
            cloudSaved,
            cloudError: cloudError || getLastCloudError(),
            data: payload
        });
    } catch (err) {
        console.error('[API] Check-in error:', err.message);
        res.status(500).json({ success: false, error: 'Gagal memproses verifikasi kedatangan' });
    }
});

// Post-Event Feedback: Pesan & Kesan serta Kritik & Saran (Diisi via Barcode saat acara selesai)
app.post('/api/checkin/feedback', async (req, res) => {
    try {
        const body = req.body || {};

        // 1. Honeypot check
        if (body.hp_website || body.bot_trap) {
            return res.json({ success: true, message: 'Masukan berhasil dikirim' });
        }

        // 2. Anti-Spam Rate Limiting (Keyed per user/device to never block multiple guests on same venue Wi-Fi)
        const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
        const guestFingerprint = body.guestId || body.guestName || body.name || 'anon';
        const userRateStatus = checkRateLimit(`fb_guest_${clientIp}_${guestFingerprint}`, 4, 15000);
        if (!userRateStatus.allowed) {
            return res.status(429).json({
                success: false,
                error: 'Terlalu banyak permintaan dari perangkat Anda. Mohon tunggu beberapa detik.'
            });
        }
        // Generous venue burst limit: up to 60 distinct feedback submissions per minute
        const venueRateStatus = checkRateLimit(`fb_venue_${clientIp}`, 60, 60000);
        if (!venueRateStatus.allowed) {
            return res.status(429).json({
                success: false,
                error: 'Sistem sedang memproses antrean data tamu. Mohon coba lagi sebentar.'
            });
        }

        const guestId = body.guestId || body.guest_id;
        let impression = sanitizeInput(body.impression || body.pesanKesan || '', 300);
        let feedback = sanitizeInput(body.feedback || body.kritikSaran || '', 300);

        // 3. Sensor kata kotor
        if (checkProfanity(impression).isProfane) impression = censorProfanity(impression);
        if (checkProfanity(feedback).isProfane) feedback = censorProfanity(feedback);

        let guest = null;
        if (guestId && guestId !== '__MANUAL__') {
            guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
        }

        if (!guest && (body.guestName || body.name)) {
            const rawName = sanitizeInput(body.guestName || body.name, 50);
            if (rawName) {
                if (checkProfanity(rawName).isProfane) {
                    return res.status(400).json({ success: false, error: 'Mohon gunakan nama yang santun.' });
                }
                guest = db.prepare('SELECT * FROM guests WHERE LOWER(name) = LOWER(?)').get(rawName);
                if (!guest) {
                    const newId = uuidv4();
                    const inst = sanitizeInput(body.guestInstitution || body.institution || 'Tamu Undangan', 50);
                    const nowIso = new Date().toISOString();
                    db.prepare(`
                        INSERT INTO guests (id, name, institution, category, qr_token, status, checked_in_at, created_at)
                        VALUES (?, ?, ?, ?, ?, 'checked_in', ?, ?)
                    `).run(newId, rawName, inst, 'Mitra Undangan', generateToken(), nowIso, nowIso);
                    guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(newId);
                }
            }
        }

        if (!guest) {
            return res.status(400).json({ success: false, error: 'Silakan pilih nama Anda atau masukkan nama lengkap Anda.' });
        }

        const combinedText = [impression, feedback].filter(Boolean).join(' | ') || 'Pesan dan saran terkirim';
        const aiResult = localAnalyzeSentiment(combinedText);

        const existingMsg = db.prepare('SELECT * FROM guest_messages WHERE guest_id = ?').get(guest.id);
        if (existingMsg) {
            db.prepare(`
                UPDATE guest_messages 
                SET message = ?, impression = ?, feedback = ?, sentiment = ?, score = ?, emotion = ?, keywords = ?
                WHERE id = ?
            `).run(
                combinedText,
                impression,
                feedback,
                aiResult.sentiment,
                aiResult.score,
                aiResult.emotion,
                JSON.stringify(aiResult.keywords),
                existingMsg.id
            );
        } else {
            const msgId = uuidv4();
            db.prepare(`
                INSERT INTO guest_messages (id, guest_id, message, impression, feedback, sentiment, score, emotion, keywords, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(
                msgId,
                guest.id,
                combinedText,
                impression,
                feedback,
                aiResult.sentiment,
                aiResult.score,
                aiResult.emotion,
                JSON.stringify(aiResult.keywords)
            );
        }

        // Update in persistent Cloud Store
        await saveGuestToCloud({
            id: guest.id,
            name: guest.name,
            institution: guest.institution,
            category: guest.category,
            qr_token: guest.qr_token,
            status: guest.status,
            checked_in_at: guest.checked_in_at,
            created_at: guest.created_at,
            message: combinedText,
            impression,
            feedback,
            sentiment: aiResult.sentiment,
            score: aiResult.score,
            emotion: aiResult.emotion
        });

        const feedbackId = body.feedbackId || `fb_${Date.now()}_${uuidv4().slice(0, 8)}`;

        broadcastEvent('guest_feedback', {
            feedbackId,
            guestId: guest.id,
            name: guest.name,
            institution: guest.institution,
            impression,
            feedback,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'Terima kasih! Pesan, kesan, kritik, dan saran Anda berhasil disimpan.'
        });
    } catch (err) {
        console.error('[API] Error submit feedback:', err.message);
        res.status(500).json({ success: false, error: 'Gagal menyimpan pesan dan saran' });
    }
});

// Lookup by token or institution
app.get('/api/checkin/lookup/:token', (req, res) => {
    try {
        const { token } = req.params;
        const guest = db.prepare('SELECT * FROM guests WHERE qr_token = ? OR institution = ?').get(token.trim(), token.trim());
        if (!guest) {
            return res.status(404).json({ success: false, error: 'Instansi tidak ditemukan' });
        }

        const messageRecord = db.prepare('SELECT * FROM guest_messages WHERE guest_id = ?').get(guest.id);

        res.json({
            success: true,
            data: {
                ...guest,
                existingMessage: messageRecord || null
            }
        });
    } catch (err) {
        console.error('[API] Error lookup token:', err.message);
        res.status(500).json({ success: false, error: 'Gagal memeriksa instansi' });
    }
});

// -------------------------------------------------------------
// REST API: Live Wall & Exhibition Analytics
// -------------------------------------------------------------

app.get('/api/stats', async (req, res) => {
    try {
        // Synchronize with persistent global cloud store so all Vercel instances have unified stats
        await syncLocalDbWithCloud();

        const allGuests = db.prepare('SELECT * FROM guests').all() || [];
        const totalGuests = allGuests.length;
        const checkedInCount = allGuests.filter(g => g.status === 'checked_in').length;
        const pendingCount = totalGuests - checkedInCount;
        const attendanceRate = totalGuests > 0 ? Math.round((checkedInCount / totalGuests) * 100) : 0;

        // Breakdown by category
        const catMap = {};
        allGuests.forEach(g => {
            const cat = g.category || 'Mitra / Instansi';
            if (!catMap[cat]) catMap[cat] = { category: cat, total: 0, checked_in: 0 };
            catMap[cat].total++;
            if (g.status === 'checked_in') catMap[cat].checked_in++;
        });
        const categories = Object.values(catMap);

        // Emotions breakdown & keywords from messages
        let allMessages = [];
        try {
            allMessages = db.prepare('SELECT * FROM guest_messages').all() || [];
        } catch (e) {}

        const emoMap = {};
        const keywordCounts = {};

        for (const m of allMessages) {
            if (m.emotion) {
                emoMap[m.emotion] = (emoMap[m.emotion] || 0) + 1;
            }
            try {
                const kws = JSON.parse(m.keywords || '[]');
                for (const kw of kws) {
                    const clean = String(kw).toUpperCase();
                    keywordCounts[clean] = (keywordCounts[clean] || 0) + 1;
                }
            } catch (e) {}
        }

        const emotions = Object.entries(emoMap)
            .map(([emotion, count]) => ({ emotion, count }))
            .sort((a, b) => b.count - a.count);

        const sortedKeywords = Object.entries(keywordCounts)
            .map(([word, count]) => ({ word, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 12);

        // All and Recent checked-in institutions
        const allCheckins = allGuests
            .filter(g => g.status === 'checked_in')
            .sort((a, b) => new Date(b.checked_in_at || 0) - new Date(a.checked_in_at || 0))
            .map(g => {
                const m = allMessages.find(x => x.guest_id === g.id) || {};
                return {
                    id: g.id,
                    name: g.name,
                    institution: g.institution,
                    category: g.category,
                    checked_in_at: g.checked_in_at,
                    message: m.message || null,
                    sentiment: m.sentiment || null,
                    score: m.score !== undefined ? m.score : null,
                    emotion: m.emotion || null,
                    keywords: m.keywords || null
                };
            });

        const recentCheckins = allCheckins.slice(0, 15);

        res.json({
            success: true,
            data: {
                totalGuests,
                checkedInCount: allCheckins.length,
                pendingCount,
                attendanceRate,
                categories,
                emotions,
                keywords: sortedKeywords,
                recentCheckins,
                allCheckins
            }
        });
    } catch (err) {
        console.error('[API] Stats error:', err.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil data statistik' });
    }
});

// Dual-Engine TTS Phonetic Expander (Converts abbreviations: bpk -> Bapak, dr -> Dokter, etc.)
function expandSpeechText(text) {
    if (!text) return '';
    let t = text;

    const replaceWord = (pattern, replacement) => {
        const re = new RegExp('(^|[\\s(])' + pattern + '(\\.|(?=[\\s,)]|$))', 'gi');
        t = t.replace(re, (match, prefix) => prefix + replacement);
    };

    replaceWord('bpk', 'Bapak');
    replaceWord('bu', 'Ibu');
    replaceWord('sdr', 'Saudara');
    replaceWord('sdri', 'Saudari');
    replaceWord('k\\.?h', 'Kiai Haji');
    replaceWord('kh', 'Kiai Haji');
    replaceWord('prof', 'Profesor');
    replaceWord('ir', 'Insinyur');
    replaceWord('drg', 'Dokter Gigi');
    replaceWord('dr', 'Dokter');
    replaceWord('drs', 'Doktorandus');
    replaceWord('dra', 'Doktoranda');
    replaceWord('ust', 'Ustadz');
    replaceWord('h', 'Haji');
    replaceWord('hj', 'Hajjah');

    replaceWord('s\\.?h', 'Sarjana Hukum');
    replaceWord('sh', 'Sarjana Hukum');
    replaceWord('s\\.?kom', 'Sarjana Komputer');
    replaceWord('skom', 'Sarjana Komputer');
    replaceWord('s\\.?e', 'Sarjana Ekonomi');
    replaceWord('se', 'Sarjana Ekonomi');
    replaceWord('s\\.?pd', 'Sarjana Pendidikan');
    replaceWord('spd', 'Sarjana Pendidikan');
    replaceWord('s\\.?t', 'Sarjana Teknik');
    replaceWord('st', 'Sarjana Teknik');
    replaceWord('s\\.?sos', 'Sarjana Sosial');
    replaceWord('ssos', 'Sarjana Sosial');
    replaceWord('s\\.?si', 'Sarjana Sains');
    replaceWord('ssi', 'Sarjana Sains');
    replaceWord('m\\.?m', 'Magister Manajemen');
    replaceWord('mm', 'Magister Manajemen');
    replaceWord('m\\.?pd', 'Magister Pendidikan');
    replaceWord('mpd', 'Magister Pendidikan');
    replaceWord('m\\.?kom', 'Magister Komputer');
    replaceWord('mkom', 'Magister Komputer');
    replaceWord('m\\.?t', 'Magister Teknik');
    replaceWord('mt', 'Magister Teknik');
    replaceWord('m\\.?si', 'Magister Sains');
    replaceWord('msi', 'Magister Sains');
    replaceWord('m\\.?h', 'Magister Hukum');
    replaceWord('mh', 'Magister Hukum');

    replaceWord('pt', 'P T');
    replaceWord('cv', 'C V');
    replaceWord('kab', 'Kabupaten');
    replaceWord('kec', 'Kecamatan');
    replaceWord('kel', 'Kelurahan');

    return t.replace(/\s+/g, ' ').trim();
}

// Dual-Engine TTS: Gemini 3.8 Flash Lite TTS with fallback
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'Teks suara wajib diisi' });
        }

        const spokenText = expandSpeechText(text.trim());

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.json({
                fallback: true,
                reason: 'GEMINI_API_KEY belum dikonfigurasi, menggunakan Web Speech API.'
            });
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [{
                        text: spokenText,
                        speechMetadata: {
                            style: 'Warm, articulate Indonesian exhibition host'
                        }
                    }]
                }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: 'Kore' }
                        }
                    }
                }
            })
        });

        if (response.ok) {
            const data = await response.json();
            const base64Audio = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
                return res.json({
                    fallback: false,
                    audioBase64: base64Audio,
                    mimeType: 'audio/wav'
                });
            }
        }

        res.json({
            fallback: true,
            reason: 'Gemini audio format fallback'
        });
    } catch (err) {
        console.warn('[TTS] Fallback to browser speech synthesis:', err.message);
        res.json({
            fallback: true,
            reason: err.message
        });
    }
});

// Admin re-greet trigger for Robot Greeter
app.post('/api/admin/greet', (req, res) => {
    try {
        const { guestId } = req.body;
        const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
        if (!guest) {
            return res.status(404).json({ success: false, error: 'Data tamu tidak ditemukan' });
        }

        const msgRecord = db.prepare('SELECT * FROM guest_messages WHERE guest_id = ?').get(guest.id);
        const payload = {
            guest: {
                id: guest.id,
                name: guest.name || '',
                institution: guest.institution,
                category: guest.category,
                checked_in_at: guest.checked_in_at || new Date().toISOString()
            },
            message: msgRecord ? {
                text: msgRecord.message,
                sentiment: msgRecord.sentiment,
                score: msgRecord.score,
                emotion: msgRecord.emotion,
                keywords: msgRecord.keywords ? JSON.parse(msgRecord.keywords) : []
            } : {
                text: 'Selamat dan sukses atas pameran karya kolaborasi talenta muda AI di Waroeng Latte!',
                sentiment: 'neutral',
                score: 0.5,
                emotion: 'Inspiratif',
                keywords: ['AI', 'MADIUN']
            }
        };

        broadcastEvent('guest_checked_in', payload);
        res.json({ success: true, message: `Robot menyapa ulang ${guest.name ? guest.name + ' - ' : ''}${guest.institution}` });
    } catch (err) {
        console.error('[API] Re-greet error:', err.message);
        res.status(500).json({ success: false, error: 'Gagal memicu sapaan robot' });
    }
});

// SSE Endpoint for Live Wall
app.get('/api/live/stream', (req, res) => {
    addClient(req, res);
});

// HTML Page Routes
app.get('/standee', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'standee.html'));
});

app.get('/checkin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'self-checkin.html'));
});

app.get('/live', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'live.html'));
});

app.get('/scanner', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'scanner.html'));
});

app.get('/feedback', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'feedback.html'));
});

app.get('/feedback/print', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'feedback-print.html'));
});

app.get('/feedback/barcode', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'feedback-print.html'));
});

app.get('/standee-feedback', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'feedback-print.html'));
});

// Start Server (Only listen if not in serverless Vercel environment)
if (!process.env.VERCEL) {
    app.listen(PORT, '0.0.0.0', () => {
        const localIp = getLocalIpAddress();
        console.log(`================================================================`);
        console.log(`  Digital Work AI Exhibition : MENEMBUS BATAS DIGITAL           `);
        console.log(`  Waroeng Latte Madiun • 11 November 2026, 10.00 WIB            `);
        console.log(`================================================================`);
        console.log(`  💻 Akses Laptop Admin : http://localhost:${PORT}`);
        console.log(`  📱 Akses HP (Satu WiFi): http://${localIp}:${PORT}/checkin`);
        console.log(`  🖨️  Standee 1 Barcode   : http://localhost:${PORT}/standee`);
        console.log(`  🖥️  Live Wall Proyektor : http://localhost:${PORT}/live`);
        console.log(`================================================================`);
    });
}

module.exports = app;
