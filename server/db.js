const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const uuidv4 = () => crypto.randomUUID();

function generateToken() {
    const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `MBD-${randomHex.slice(0, 4)}-${randomHex.slice(4)}`;
}

// 10 Kumpulan Instansi Resmi Kota Madiun (Daftar Preset untuk Registrasi)
const sampleInstitutions = [
    { institution: 'Dinas KUKM', category: 'Instansi Pemerintah (Pembina UMKM)' },
    { institution: 'Votel Kartika', category: 'Hospitality & Hotel' },
    { institution: 'Bluder Cokro', category: 'Industri Kuliner Khas Madiun' },
    { institution: 'Jiwan Oli', category: 'Bengkel Otomotif & Perawatan Mobil' },
    { institution: 'MPOINT', category: 'Bengkel & Servis Motor' },
    { institution: 'Kelurahan Josenan', category: 'Pemerintahan Daerah (Kelurahan)' },
    { institution: 'Maju Hardware', category: 'Pusat Retail Komputer & Gadget IT' },
    { institution: 'Hotel Setia Budi', category: 'Hospitality & Hotel' },
    { institution: 'Yessles (Yesless)', category: 'Lembaga Bimbingan Belajar & Les Privat' },
    { institution: 'Neo Kramik', category: 'Pusat Grosir Granit Keramik & Bangunan' }
];

let dbInstance = null;

// Try native node:sqlite
try {
    const { DatabaseSync } = require('node:sqlite');
    const dbDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = path.join(dbDir, 'undangan.db');

    const sqliteDb = new DatabaseSync(dbPath);
    sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS guests (
            id TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            institution TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'Mitra / Instansi',
            qr_token TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            checked_in_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guest_messages (
            id TEXT PRIMARY KEY,
            guest_id TEXT NOT NULL,
            message TEXT NOT NULL,
            sentiment TEXT NOT NULL DEFAULT 'neutral',
            score REAL NOT NULL DEFAULT 0.5,
            emotion TEXT DEFAULT 'Inspiratif',
            keywords TEXT DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(guest_id) REFERENCES guests(id) ON DELETE CASCADE
        );
    `);

    // Ensure 'name' column exists
    try {
        sqliteDb.exec("ALTER TABLE guests ADD COLUMN name TEXT DEFAULT ''");
    } catch (e) {}

    dbInstance = sqliteDb;
    console.log('[DB] Using native node:sqlite DatabaseSync.');
} catch (err) {
    console.warn('[DB] node:sqlite unavailable in this environment, activating In-Memory / JSON DB fallback:', err.message);

    // Bulletproof Fallback Store
    const fallbackStoreFile = process.env.VERCEL 
        ? '/tmp/undangan_memory.json' 
        : path.join(__dirname, '..', 'data', 'undangan_memory.json');

    let store = {
        guests: [],
        messages: []
    };

    function saveStore() {
        try {
            fs.writeFileSync(fallbackStoreFile, JSON.stringify(store, null, 2), 'utf-8');
        } catch (e) {}
    }

    if (fs.existsSync(fallbackStoreFile)) {
        try {
            store = JSON.parse(fs.readFileSync(fallbackStoreFile, 'utf-8'));
        } catch (e) {}
    }

    dbInstance = {
        exec: (sql) => {},
        prepare: (sql) => {
            const s = sql.trim().toUpperCase();
            return {
                run: (...params) => {
                    if (s.startsWith('DELETE FROM GUEST_MESSAGES')) {
                        store.messages = [];
                        saveStore();
                        return { changes: 1 };
                    }
                    if (s.includes('DELETE FROM GUESTS WHERE CATEGORY = ?')) {
                        const cat = params[0] || 'Mitra Tambahan';
                        const prev = store.guests.length;
                        store.guests = store.guests.filter(g => g.category !== cat);
                        saveStore();
                        return { changes: prev - store.guests.length };
                    }
                    if (s.startsWith('DELETE FROM GUESTS WHERE ID = ?')) {
                        const id = params[0];
                        const prev = store.guests.length;
                        store.guests = store.guests.filter(g => g.id !== id);
                        store.messages = store.messages.filter(m => m.guest_id !== id);
                        saveStore();
                        return { changes: prev - store.guests.length };
                    }
                    if (s.startsWith('DELETE FROM GUESTS')) {
                        store.guests = [];
                        saveStore();
                        return { changes: 1 };
                    }
                    if (s.includes('UPDATE GUESTS SET STATUS = \'PENDING\'') || s.includes('SET STATUS = \'PENDING\'')) {
                        store.guests.forEach(g => {
                            g.status = 'pending';
                            g.checked_in_at = null;
                        });
                        saveStore();
                        return { changes: store.guests.length };
                    }
                    if (s.includes('INTO GUESTS')) {
                        let id, name, institution, category, qr_token, status, checked_in_at, created_at;
                        if (params.length >= 8) {
                            [id, name, institution, category, qr_token, status, checked_in_at, created_at] = params;
                        } else if (params.length === 5) {
                            [id, name, institution, category, qr_token] = params;
                        } else {
                            [id, institution, category, qr_token] = params;
                            name = '';
                        }
                        const existingIdx = store.guests.findIndex(g => g.id === id);
                        const guestObj = {
                            id,
                            name: name || '',
                            institution,
                            category: category || 'Mitra Tambahan',
                            qr_token: qr_token || generateToken(),
                            status: status || 'pending',
                            checked_in_at: checked_in_at || null,
                            created_at: created_at || new Date().toISOString()
                        };
                        if (existingIdx >= 0) {
                            store.guests[existingIdx] = { ...store.guests[existingIdx], ...guestObj };
                        } else {
                            store.guests.push(guestObj);
                        }
                        saveStore();
                        return { changes: 1 };
                    }
                    if (s.startsWith('UPDATE GUESTS SET STATUS = ?')) {
                        const [status, checked_in_at, id] = params;
                        const g = store.guests.find(x => x.id === id);
                        if (g) {
                            g.status = status;
                            g.checked_in_at = checked_in_at;
                            saveStore();
                        }
                        return { changes: 1 };
                    }
                    if (s.startsWith('UPDATE GUESTS SET NAME =') || s.includes('SET NAME =')) {
                        const [nameVal, id] = params;
                        const g = store.guests.find(x => x.id === id);
                        if (g) {
                            if (nameVal) g.name = nameVal;
                            g.status = 'checked_in';
                            g.checked_in_at = new Date().toISOString();
                            saveStore();
                        }
                        return { changes: 1 };
                    }
                    if (s.includes('INTO GUEST_MESSAGES')) {
                        const [id, guest_id, message, sentiment, score, emotion, keywords, created_at] = params;
                        const existingIdx = store.messages.findIndex(m => m.id === id || m.guest_id === guest_id);
                        const msgObj = {
                            id: id || uuidv4(),
                            guest_id,
                            message,
                            sentiment: sentiment || 'neutral',
                            score: score !== undefined ? score : 0.5,
                            emotion: emotion || 'Optimis',
                            keywords: keywords || '[]',
                            created_at: created_at || new Date().toISOString()
                        };
                        if (existingIdx >= 0) {
                            store.messages[existingIdx] = msgObj;
                        } else {
                            store.messages.push(msgObj);
                        }
                        saveStore();
                        return { changes: 1 };
                    }
                    return { changes: 0 };
                },
                get: (...params) => {
                    if (s.includes('COUNT(*)')) {
                        if (s.includes("STATUS = 'CHECKED_IN'")) {
                            return { count: store.guests.filter(g => g.status === 'checked_in').length };
                        }
                        if (s.includes("STATUS = 'PENDING'")) {
                            return { count: store.guests.filter(g => g.status === 'pending').length };
                        }
                        return { count: store.guests.length };
                    }
                    if (s.includes('AVG(SCORE)')) {
                        if (store.messages.length === 0) return { avg_score: 0.5 };
                        const sum = store.messages.reduce((acc, m) => acc + (m.score || 0.5), 0);
                        return { avg_score: sum / store.messages.length };
                    }
                    if (s.includes('FROM GUESTS WHERE ID = ?')) {
                        return store.guests.find(g => g.id === params[0]) || null;
                    }
                    if (s.includes('FROM GUESTS WHERE QR_TOKEN = ?')) {
                        return store.guests.find(g => g.qr_token === params[0]) || null;
                    }
                    if (s.includes('FROM GUESTS WHERE INSTITUTION = ?')) {
                        return store.guests.find(g => g.institution.toLowerCase() === String(params[0]).toLowerCase()) || null;
                    }
                    if (s.includes('FROM GUEST_MESSAGES WHERE GUEST_ID = ?')) {
                        return store.messages.find(m => m.guest_id === params[0]) || null;
                    }
                    return null;
                },
                all: (...params) => {
                    if (s.includes('GROUP BY CATEGORY')) {
                        const cats = {};
                        store.guests.forEach(g => {
                            if (!cats[g.category]) cats[g.category] = { category: g.category, total: 0, checked_in: 0 };
                            cats[g.category].total++;
                            if (g.status === 'checked_in') cats[g.category].checked_in++;
                        });
                        return Object.values(cats);
                    }
                    if (s.includes('GROUP BY EMOTION')) {
                        const emos = {};
                        store.messages.forEach(m => {
                            if (!m.emotion) return;
                            emos[m.emotion] = (emos[m.emotion] || 0) + 1;
                        });
                        return Object.entries(emos).map(([emotion, count]) => ({ emotion, count }));
                    }
                    if (s.includes('SELECT KEYWORDS FROM GUEST_MESSAGES')) {
                        return store.messages.map(m => ({ keywords: m.keywords }));
                    }
                    if (s.includes('WHERE STATUS = \'CHECKED_IN\' ORDER BY CHECKED_IN_AT DESC')) {
                        return store.guests
                            .filter(g => g.status === 'checked_in')
                            .map(g => {
                                const m = store.messages.find(x => x.guest_id === g.id) || {};
                                return {
                                    ...g,
                                    message: m.message || null,
                                    sentiment: m.sentiment || null,
                                    score: m.score !== undefined ? m.score : null,
                                    emotion: m.emotion || null,
                                    keywords: m.keywords || null
                                };
                            })
                            .sort((a, b) => new Date(b.checked_in_at) - new Date(a.checked_in_at));
                    }
                    if (s.includes('SELECT DISTINCT INSTITUTION')) {
                        const distinct = [];
                        const seen = new Set();
                        store.guests.forEach(g => {
                            if (g.institution && !seen.has(g.institution.toLowerCase())) {
                                seen.add(g.institution.toLowerCase());
                                distinct.push({ institution: g.institution, category: g.category });
                            }
                        });
                        return distinct;
                    }

                    let list = store.guests.map(g => {
                        const m = store.messages.find(x => x.guest_id === g.id) || {};
                        return {
                            ...g,
                            message: m.message || null,
                            sentiment: m.sentiment || null,
                            score: m.score !== undefined ? m.score : null,
                            emotion: m.emotion || null,
                            keywords: m.keywords || null
                        };
                    });

                    if (params.length > 0) {
                        const p0 = String(params[0] || '').replace(/%/g, '').toLowerCase();
                        if (p0) {
                            list = list.filter(g => 
                                (g.name && g.name.toLowerCase().includes(p0)) ||
                                g.institution.toLowerCase().includes(p0) || 
                                g.qr_token.toLowerCase().includes(p0) || 
                                g.category.toLowerCase().includes(p0)
                            );
                        }
                    }
                    return list;
                }
            };
        }
    };
}

function resetAttendanceOnly() {
    dbInstance.prepare('DELETE FROM guest_messages').run();
    try {
        dbInstance.prepare("UPDATE guests SET status = 'pending', checked_in_at = NULL").run();
    } catch (e) {
        console.warn('[DB] Reset attendance warning:', e.message);
    }
    console.log('[DB] Kehadiran tamu berhasil direset.');
}

// Reset / Kosongkan Database Awal (0 Tamu di Dashboard)
function seedDatabase() {
    dbInstance.prepare('DELETE FROM guest_messages').run();
    dbInstance.prepare('DELETE FROM guests').run();
    console.log('[DB] Database dibersihkan (0 tamu terdaftar). Dashboard siap menerima registrasi tamu.');
}

module.exports = {
    db: dbInstance,
    generateToken,
    seedDatabase,
    resetAttendanceOnly,
    sampleInstitutions
};
