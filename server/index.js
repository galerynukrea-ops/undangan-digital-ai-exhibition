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
const { getCloudGuests, saveGuestToCloud, resetCloudGuests } = require('./cloudStore');
const { analyzeSentiment } = require('./aiService');
const { generateVenueStandeePdf, PALETTE, EVENT_DETAILS } = require('./pdfService');
const { addClient, broadcastEvent } = require('./sseService');

const app = express();
const PORT = process.env.PORT || 3000;

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
        liveUrl: `${baseUrl}/live`,
        standeeUrl: `${baseUrl}/standee`
    });
});

// -------------------------------------------------------------
// REST API: Guests (Institutions) Management
// -------------------------------------------------------------

// 1. Get all institutions with query filters (Synced with Cloud Store across all Vercel instances)
app.get('/api/guests', async (req, res) => {
    try {
        const { search, category, status } = req.query;

        // Auto-hydrate from Cloud Store if available
        try {
            const cloudGuests = await getCloudGuests();
            if (Array.isArray(cloudGuests) && cloudGuests.length > 0) {
                const insertGuest = db.prepare(`
                    INSERT OR REPLACE INTO guests (id, name, institution, category, qr_token, status, checked_in_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const insertMsg = db.prepare(`
                    INSERT OR REPLACE INTO guest_messages (id, guest_id, message, sentiment, score, emotion, keywords, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);
                for (const g of cloudGuests) {
                    if (!g.id || !g.name) continue;
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
                        if (g.message) {
                            insertMsg.run(
                                uuidv4(),
                                g.id,
                                g.message,
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
        } catch (e) {}

        let query = `
            SELECT g.*, m.message, m.sentiment, m.score, m.emotion, m.keywords
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

        query += ` ORDER BY g.created_at ASC`;

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
            if (!g.id || !g.institution) continue;
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

// 4. Delete institution
app.delete('/api/guests/:id', (req, res) => {
    try {
        const { id } = req.params;
        const info = db.prepare('DELETE FROM guests WHERE id = ?').run(id);
        if (info.changes === 0) {
            return res.status(404).json({ success: false, error: 'Instansi tidak ditemukan' });
        }
        res.json({ success: true, message: 'Data instansi berhasil dihapus' });
    } catch (err) {
        console.error('[API] Error delete guest:', err.message);
        res.status(500).json({ success: false, error: 'Gagal menghapus data instansi' });
    }
});

// 5. Reset Testing & Attendance Data (Supports mode: 'attendance' | 'factory')
app.all(['/api/admin/reset', '/api/reset'], async (req, res) => {
    try {
        const mode = (req.body?.mode || req.query?.mode || 'attendance').toLowerCase();
        
        // Reset local DB & Global Cloud Store
        await resetCloudGuests();

        if (mode === 'factory') {
            seedDatabase();
            broadcastEvent('database_reset', { mode: 'factory', timestamp: new Date().toISOString() });
            return res.json({
                success: true,
                mode: 'factory',
                message: 'Database berhasil di-reset penuh ke 10 instansi awal (kondisi pabrik).'
            });
        }

        // Default: attendance reset
        resetAttendanceOnly();
        broadcastEvent('database_reset', { mode: 'attendance', timestamp: new Date().toISOString() });
        return res.json({
            success: true,
            mode: 'attendance',
            message: 'Status kehadiran berhasil dibersihkan (0 hadir). 10 mitra resmi siap digunakan kembali.'
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
        const { token, name, institution, newInstitution, category, message } = req.body || {};

        let targetInst = (newInstitution || institution || '').trim();
        if (targetInst === '__NEW__') targetInst = '';
        if (!targetInst) {
            targetInst = 'Tamu Undangan';
        }

        let targetName = (name || '').trim();
        if (!targetName) {
            targetName = targetInst !== 'Tamu Undangan' ? targetInst : 'Tamu Kehormatan';
        }

        let finalCategory = (category && category.trim()) ? category.trim() : 'Mitra / Tamu';

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

        // Analyze sentiment (fast fail-safe)
        const guestMessage = (message && message.trim()) || 'Sukses selalu untuk seluruh talenta muda & kemajuan kecerdasan artifisial di Kota Madiun!';
        const aiResult = await analyzeSentiment(guestMessage);

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
        try {
            await saveGuestToCloud({
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
            console.warn('[Checkin] Cloud save warning:', e.message);
        }

        res.json({
            success: true,
            message: `Verifikasi kedatangan berhasil untuk ${targetName}`,
            data: payload
        });
    } catch (err) {
        console.error('[API] Check-in error:', err.message);
        res.status(500).json({ success: false, error: 'Gagal memproses verifikasi kedatangan' });
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

app.get('/api/stats', (req, res) => {
    try {
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

        // Recent checked-in institutions
        const recentCheckins = allGuests
            .filter(g => g.status === 'checked_in')
            .sort((a, b) => new Date(b.checked_in_at || 0) - new Date(a.checked_in_at || 0))
            .slice(0, 10)
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

        res.json({
            success: true,
            data: {
                totalGuests,
                checkedInCount,
                pendingCount,
                attendanceRate,
                categories,
                emotions,
                keywords: sortedKeywords,
                recentCheckins
            }
        });
    } catch (err) {
        console.error('[API] Stats error:', err.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil data statistik' });
    }
});

// Dual-Engine TTS: Gemini 3.8 Flash Lite TTS with fallback
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'Teks suara wajib diisi' });
        }

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
                        text: text.trim(),
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
