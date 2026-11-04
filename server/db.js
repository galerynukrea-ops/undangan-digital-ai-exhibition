const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('node:crypto');

const dbDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'undangan.db');

// In Vercel, copy existing data/undangan.db to /tmp/undangan.db if available
if (process.env.VERCEL && !fs.existsSync(dbPath)) {
    const seedSrc = path.join(__dirname, '..', 'data', 'undangan.db');
    if (fs.existsSync(seedSrc)) {
        try {
            fs.copyFileSync(seedSrc, dbPath);
        } catch (e) {
            console.warn('[DB] Failed to copy seed db, will initialize fresh:', e.message);
        }
    }
}

const db = new DatabaseSync(dbPath);

// Initialize Tables
db.exec(`
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

function seedDatabase() {
    db.prepare('DELETE FROM guest_messages').run();
    db.prepare('DELETE FROM guests').run();

    const insertStmt = db.prepare(`
        INSERT INTO guests (id, institution, category, qr_token, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `);

    for (const g of sampleInstitutions) {
        insertStmt.run(uuidv4(), g.institution, g.category, generateToken());
    }
    console.log(`[DB] Berhasil memperbarui database dengan 10 instansi terverifikasi di Kota Madiun.`);
}

// Check and seed if count < 10
const count = db.prepare('SELECT COUNT(*) as count FROM guests').get().count;
if (count !== 10) {
    seedDatabase();
}

module.exports = {
    db,
    generateToken,
    seedDatabase
};
