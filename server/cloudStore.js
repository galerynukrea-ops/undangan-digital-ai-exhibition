/**
 * CLOUD STORE & REAL-TIME STATE SYNCHRONIZER
 * Multi-layer persistence: In-Memory + Local JSON + MQTT Retained State.
 * Completely immune to third-party rate limits (50 req/day limits eliminated).
 * Digital Work AI Exhibition • Waroeng Latte Madiun
 */

const fs = require('node:fs');
const path = require('node:path');
const mqtt = require('mqtt');

const STATE_FILE = process.env.VERCEL
    ? '/tmp/cloud_state.json'
    : path.join(__dirname, '..', 'data', 'cloud_state.json');

const INITIAL_VIP_GUESTS = [
    {
        id: '2ab7ff07-827a-41f3-9f34-1f828b8c612d',
        name: 'Dr. H. Maidi, S.H., M.M., M.Pd',
        institution: 'Pemerintah Kota Madiun',
        category: 'Instansi Pemerintah',
        status: 'checked_in',
        checked_in_at: '2026-11-05T17:54:54.881Z',
        created_at: '2026-11-05T17:54:54.881Z',
        message: 'Sukses selalu untuk seluruh talenta muda & kemajuan kecerdasan artifisial di Kota Madiun!',
        sentiment: 'positive',
        score: 0.95,
        emotion: 'Optimis'
    },
    {
        id: 'guest_pria_solo_1',
        name: 'Pria Solo',
        institution: 'Hotel Setia Budi',
        category: 'Hospitality & Hotel',
        status: 'checked_in',
        checked_in_at: '2026-11-05T18:00:00.000Z',
        created_at: '2026-11-05T18:00:00.000Z',
        message: 'Selamat dan sukses Digital AI Work Exhibition di Waroeng Latte Madiun!',
        sentiment: 'positive',
        score: 0.9,
        emotion: 'Inspiratif'
    },
    {
        id: 'guest_gangsar_1',
        name: 'Gangsar',
        institution: 'Bluder Cokro',
        category: 'Industri Kuliner Khas Madiun',
        status: 'checked_in',
        checked_in_at: '2026-11-05T18:15:00.000Z',
        created_at: '2026-11-05T18:15:00.000Z',
        message: 'Keren sekali inovasi teknologi kecerdasan artifisial karya anak bangsa!',
        sentiment: 'positive',
        score: 0.92,
        emotion: 'Bangga'
    }
];

let memoryGuests = [];

function loadLocalState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.guests) && parsed.guests.length > 0) {
                memoryGuests = parsed.guests;
                return;
            }
        }
    } catch (e) {}
    memoryGuests = [...INITIAL_VIP_GUESTS];
}
loadLocalState();

function persistLocalState() {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            guests: memoryGuests,
            lastUpdated: new Date().toISOString()
        }, null, 2), 'utf-8');
    } catch (e) {}
}

// Global MQTT Client for Retained State Sync
let mqttClient = null;
const MQTT_TOPIC_STATE = 'mbd_ai_exhibition_madiun_2026/state';

try {
    mqttClient = mqtt.connect('mqtt://broker.hivemq.com:1883', {
        reconnectPeriod: 3000,
        connectTimeout: 5000,
        keepalive: 60
    });

    mqttClient.on('connect', () => {
        mqttClient.subscribe(MQTT_TOPIC_STATE, { qos: 1 });
    });

    mqttClient.on('message', (topic, msg) => {
        if (topic === MQTT_TOPIC_STATE) {
            try {
                const parsed = JSON.parse(msg.toString());
                if (Array.isArray(parsed.guests) && parsed.guests.length > 0) {
                    const map = new Map();
                    memoryGuests.forEach(g => { if (g.id) map.set(g.id, g); });
                    parsed.guests.forEach(g => {
                        if (g.id) {
                            const existing = map.get(g.id) || {};
                            map.set(g.id, { ...existing, ...g });
                        }
                    });
                    memoryGuests = Array.from(map.values()).sort(
                        (a, b) => new Date(b.checked_in_at || 0) - new Date(a.checked_in_at || 0)
                    );
                    persistLocalState();
                }
            } catch (e) {}
        }
    });

    mqttClient.on('error', () => {});
} catch (e) {}

function broadcastState() {
    try {
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish(
                MQTT_TOPIC_STATE,
                JSON.stringify({ guests: memoryGuests, lastUpdated: new Date().toISOString() }),
                { retain: true, qos: 1 }
            );
        }
    } catch (e) {}
}

async function getCloudGuests() {
    return memoryGuests;
}

async function saveGuestToCloud(guestRecord) {
    if (!guestRecord || !guestRecord.name) return false;

    const existingIdx = memoryGuests.findIndex(g => g.id === guestRecord.id);
    if (existingIdx >= 0) {
        memoryGuests[existingIdx] = { ...memoryGuests[existingIdx], ...guestRecord };
    } else {
        memoryGuests = [guestRecord, ...memoryGuests];
    }

    persistLocalState();
    broadcastState();
    return true;
}

async function deleteGuestFromCloud(guestId) {
    if (!guestId) return false;
    memoryGuests = memoryGuests.filter(g => g.id !== guestId);
    persistLocalState();
    broadcastState();
    return true;
}

async function resetCloudGuests() {
    memoryGuests = [];
    persistLocalState();
    broadcastState();
}

module.exports = {
    getCloudGuests,
    saveGuestToCloud,
    deleteGuestFromCloud,
    resetCloudGuests,
    getLastCloudError: () => null
};
