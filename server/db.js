const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const uuidv4 = () => crypto.randomUUID();

function generateToken() {
    const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `MBD-${randomHex.slice(0, 4)}-${randomHex.slice(4)}`;
}

// 10 Real Verified Institutions in Madiun
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

    if (process.env.VERCEL && !fs.existsSync(dbPath)) {
        const seedSrc = path.join(__dirname, '..', 'data', 'undangan.db');
        if (fs.existsSync(seedSrc)) {
            try {
                fs.copyFileSync(seedSrc, dbPath);
            } catch (e) {}
        }
    }

    const sqliteDb = new DatabaseSync(dbPath);
    sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS guests (
            id TEXT PRIMARY KEY,
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

    dbInstance = sqliteDb;
    console.log('[DB] Using native node:sqlite DatabaseSync.');
} catch (err) {
    console.warn('[DB] node:sqlite unavailable in this environment, activating In-Memory / JSON DB fallback:', err.message);

    // Bulletproof Fallback Store
    const store = {
        guests: [],
        messages: []
    };

    const persistFile = process.env.VERCEL ? '/tmp/guestbook_store.json' : path.join(__dirname, '..', 'data', 'guestbook_store.json');
    if (fs.existsSync(persistFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(persistFile, 'utf-8'));
            store.guests = data.guests || [];
            store.messages = data.messages || [];
        } catch (e) {}
    }

    function saveStore() {
        try {
            fs.writeFileSync(persistFile, JSON.stringify(store));
        } catch (e) {}
    }

    dbInstance = {
        exec: () => {},
        prepare: (sql) => {
            const trimmed = sql.trim();
            const s = trimmed.toUpperCase();

            return {
                run: (...params) => {
                    if (s.startsWith('DELETE FROM GUEST_MESSAGES')) {
                        store.messages = [];
                        saveStore();
                        return;
                    }
                    if (s.startsWith('DELETE FROM GUESTS WHERE ID = ?')) {
                        const id = params[0];
                        store.guests = store.guests.filter(g => g.id !== id);
                        store.messages = store.messages.filter(m => m.guest_id !== id);
                        saveStore();
                        return;
                    }
                    if (s.startsWith('DELETE FROM GUESTS')) {
                        store.guests = [];
                        saveStore();
                        return;
                    }
                    if (s.startsWith('INSERT INTO GUESTS')) {
                        const [id, institution, category, qr_token] = params;
                        store.guests.push({
                            id,
                            institution,
                            category: category || 'Mitra / Instansi',
                            qr_token,
                            status: 'pending',
                            checked_in_at: null,
                            created_at: new Date().toISOString()
                        });
                        saveStore();
                        return;
                    }
                    if (s.startsWith('UPDATE GUESTS SET STATUS = \'CHECKED_IN\'')) {
                        const id = params[0];
                        const g = store.guests.find(x => x.id === id);
                        if (g) {
                            g.status = 'checked_in';
                            g.checked_in_at = new Date().toISOString();
                            saveStore();
                        }
                        return;
                    }
                    if (s.startsWith('INSERT INTO GUEST_MESSAGES')) {
                        const [id, guest_id, message, sentiment, score, emotion, keywords] = params;
                        store.messages.push({
                            id,
                            guest_id,
                            message,
                            sentiment: sentiment || 'neutral',
                            score: score !== undefined ? score : 0.5,
                            emotion: emotion || 'Inspiratif',
                            keywords: typeof keywords === 'string' ? keywords : JSON.stringify(keywords || []),
                            created_at: new Date().toISOString()
                        });
                        saveStore();
                        return;
                    }
                },
                get: (...params) => {
                    if (s.includes('COUNT(*) AS COUNT FROM GUESTS')) {
                        return { count: store.guests.length };
                    }
                    if (s.includes('COUNT(*) AS TOTAL FROM GUESTS')) {
                        return { total: store.guests.length };
                    }
                    if (s.includes('COUNT(*) AS CHECKED FROM GUESTS')) {
                        return { checked: store.guests.filter(g => g.status === 'checked_in').length };
                    }
                    if (s.startsWith('SELECT * FROM GUESTS WHERE ID = ?')) {
                        const id = params[0];
                        return store.guests.find(g => g.id === id);
                    }
                    if (s.includes('WHERE QR_TOKEN = ? OR INSTITUTION LIKE ?')) {
                        const token = params[0];
                        const instLike = (params[1] || '').replace(/%/g, '').toLowerCase();
                        return store.guests.find(g => g.qr_token === token || (instLike && g.institution.toLowerCase().includes(instLike)));
                    }
                    if (s.includes('WHERE QR_TOKEN = ?')) {
                        const token = params[0];
                        return store.guests.find(g => g.qr_token === token);
                    }
                    return null;
                },
                all: (...params) => {
                    if (s.includes('CATEGORY, COUNT(*) AS COUNT FROM GUESTS')) {
                        const map = {};
                        store.guests.forEach(g => {
                            map[g.category] = (map[g.category] || 0) + 1;
                        });
                        return Object.entries(map).map(([category, count]) => ({ category, count }));
                    }
                    if (s.includes('EMOTION, COUNT(*) AS COUNT FROM GUEST_MESSAGES')) {
                        const map = {};
                        store.messages.forEach(m => {
                            map[m.emotion] = (map[m.emotion] || 0) + 1;
                        });
                        return Object.entries(map).map(([emotion, count]) => ({ emotion, count }));
                    }
                    if (s.includes('SELECT KEYWORDS FROM GUEST_MESSAGES')) {
                        return store.messages.map(m => ({ keywords: m.keywords }));
                    }
                    if (s.includes('WHERE G.STATUS = \'CHECKED_IN\'')) {
                        return store.guests
                            .filter(g => g.status === 'checked_in')
                            .sort((a, b) => new Date(b.checked_in_at || 0) - new Date(a.checked_in_at || 0))
                            .slice(0, 10)
                            .map(g => {
                                const m = store.messages.find(x => x.guest_id === g.id) || {};
                                return {
                                    ...g,
                                    message: m.message,
                                    emotion: m.emotion,
                                    keywords: m.keywords
                                };
                            });
                    }
                    // Main guest list query
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

function seedDatabase() {
    dbInstance.prepare('DELETE FROM guest_messages').run();
    dbInstance.prepare('DELETE FROM guests').run();

    const insertStmt = dbInstance.prepare(`
        INSERT INTO guests (id, institution, category, qr_token, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `);

    for (const g of sampleInstitutions) {
        insertStmt.run(uuidv4(), g.institution, g.category, generateToken());
    }
    console.log(`[DB] Berhasil memperbarui database dengan 10 instansi terverifikasi di Kota Madiun.`);
}

try {
    const res = dbInstance.prepare('SELECT COUNT(*) as count FROM guests').get();
    if (!res || res.count < 10) {
        seedDatabase();
    }
} catch (e) {
    seedDatabase();
}

module.exports = {
    db: dbInstance,
    generateToken,
    seedDatabase
};
