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

const { db, generateToken, resetAttendanceOnly, seedDatabase } = require('./db');
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

// 1. Get all institutions with query filters
app.get('/api/guests', (req, res) => {
    try {
        const { search, category, status } = req.query;
        let query = `
            SELECT g.*, m.message, m.sentiment, m.score, m.emotion, m.keywords
            FROM guests g
            LEFT JOIN guest_messages m ON g.id = m.guest_id
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (g.institution LIKE ? OR g.qr_token LIKE ? OR g.category LIKE ?)`;
            const searchParam = `%${search.trim()}%`;
            params.push(searchParam, searchParam, searchParam);
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

// 2. Add single institution
app.post('/api/guests', (req, res) => {
    try {
        const { institution, category } = req.body;
        if (!institution || institution.trim() === '') {
            return res.status(400).json({ success: false, error: 'Nama instansi/perusahaan wajib diisi' });
        }

        const id = uuidv4();
        const token = generateToken();
        const finalCategory = category && category.trim() !== '' ? category.trim() : 'Mitra Tambahan';

        const stmt = db.prepare(`
            INSERT INTO guests (id, institution, category, qr_token, status)
            VALUES (?, ?, ?, ?, 'pending')
        `);

        stmt.run(id, institution.trim(), finalCategory, token);

        const newGuest = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
        res.status(201).json({ success: true, message: 'Instansi berhasil ditambahkan', data: newGuest });
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
app.all(['/api/admin/reset', '/api/reset'], (req, res) => {
    try {
        const mode = (req.body?.mode || req.query?.mode || 'attendance').toLowerCase();
        
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
// REST API: Check-In & AI Guestbook (Supports on-the-spot additional institutions)
// -------------------------------------------------------------

app.post('/api/checkin/submit', async (req, res) => {
    try {
        const { token, institution, newInstitution, category, message } = req.body;

        let guest = null;
        if (token) {
            guest = db.prepare('SELECT * FROM guests WHERE qr_token = ?').get(token.trim().toUpperCase());
        }
        if (!guest && institution && institution !== '__NEW__') {
            guest = db.prepare('SELECT * FROM guests WHERE institution = ?').get(institution.trim());
        }

        // Handle additional institution (not yet pre-registered in DB)
        if (!guest) {
            const targetName = (newInstitution || institution || '').trim();
            if (!targetName || targetName === '__NEW__') {
                return res.status(400).json({ success: false, error: 'Nama instansi/perusahaan wajib diisi' });
            }

            // Check if it already exists under this name
            const existingByName = db.prepare('SELECT * FROM guests WHERE institution = ?').get(targetName);
            if (existingByName) {
                guest = existingByName;
            } else {
                const id = uuidv4();
                const newToken = generateToken();
                const finalCategory = (category && category.trim()) ? category.trim() : 'Mitra Tambahan';
                db.prepare(`
                    INSERT INTO guests (id, institution, category, qr_token, status, created_at)
                    VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
                `).run(id, targetName, finalCategory, newToken);
                guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
                console.log(`[CHECKIN] Instansi baru otomatis terdaftar di venue: ${targetName}`);
            }
        }

        // 1. Mark as checked in
        const now = new Date().toISOString();
        db.prepare(`
            UPDATE guests 
            SET status = 'checked_in', checked_in_at = ? 
            WHERE id = ?
        `).run(now, guest.id);

        // 2. Analyze sentiment with Gemini API / Local Fallback
        const guestMessage = (message && message.trim()) || 'Selamat dan sukses atas pameran karya kolaborasi talenta muda AI di Waroeng Latte!';
        const aiResult = await analyzeSentiment(guestMessage);

        // 3. Store message & sentiment
        const existing = db.prepare('SELECT id FROM guest_messages WHERE guest_id = ?').get(guest.id);
        const msgId = existing ? existing.id : uuidv4();

        if (existing) {
            db.prepare(`
                UPDATE guest_messages 
                SET message = ?, sentiment = ?, score = ?, emotion = ?, keywords = ?, created_at = ?
                WHERE id = ?
            `).run(guestMessage, aiResult.sentiment, aiResult.score, aiResult.emotion, JSON.stringify(aiResult.keywords), now, msgId);
        } else {
            db.prepare(`
                INSERT INTO guest_messages (id, guest_id, message, sentiment, score, emotion, keywords, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(msgId, guest.id, guestMessage, aiResult.sentiment, aiResult.score, aiResult.emotion, JSON.stringify(aiResult.keywords), now);
        }

        const payload = {
            guest: {
                id: guest.id,
                institution: guest.institution,
                category: guest.category,
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

        // 4. Real-time broadcast to all connected Live Walls via SSE
        broadcastEvent('guest_checked_in', payload);

        res.json({
            success: true,
            message: `Verifikasi kedatangan berhasil untuk ${guest.institution}`,
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
        const totalGuests = db.prepare('SELECT COUNT(*) as count FROM guests').get().count;
        const checkedInCount = db.prepare("SELECT COUNT(*) as count FROM guests WHERE status = 'checked_in'").get().count;
        const pendingCount = totalGuests - checkedInCount;
        const attendanceRate = totalGuests > 0 ? Math.round((checkedInCount / totalGuests) * 100) : 0;

        // Breakdown by category
        const categories = db.prepare(`
            SELECT category, 
                   COUNT(*) as total, 
                   SUM(CASE WHEN status = 'checked_in' THEN 1 ELSE 0 END) as checked_in
            FROM guests 
            GROUP BY category
        `).all();

        // Emotions breakdown
        const emotions = db.prepare(`
            SELECT emotion, COUNT(*) as count 
            FROM guest_messages 
            GROUP BY emotion
            ORDER BY count DESC
        `).all();

        // Recent checked-in institutions
        const recentCheckins = db.prepare(`
            SELECT g.id, g.institution, g.category, g.checked_in_at,
                   m.message, m.sentiment, m.score, m.emotion, m.keywords
            FROM guests g
            INNER JOIN guest_messages m ON g.id = m.guest_id
            WHERE g.status = 'checked_in'
            ORDER BY g.checked_in_at DESC
            LIMIT 10
        `).all();

        // Aggregate keywords
        const allKeywordsRaw = db.prepare('SELECT keywords FROM guest_messages').all();
        const keywordCounts = {};
        for (const row of allKeywordsRaw) {
            try {
                const kws = JSON.parse(row.keywords || '[]');
                for (const kw of kws) {
                    const clean = kw.toUpperCase();
                    keywordCounts[clean] = (keywordCounts[clean] || 0) + 1;
                }
            } catch (e) {}
        }

        const sortedKeywords = Object.entries(keywordCounts)
            .map(([word, count]) => ({ word, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 12);

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
