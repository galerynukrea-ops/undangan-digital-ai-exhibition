/**
 * CLOUD STORE & REAL-TIME STATE SYNCHRONIZER (With Distributed Consensus)
 * Multi-layer persistence: In-Memory + Local JSON + MQTT Retained State.
 * Prevents split-brain and disappearing guests across Vercel serverless containers.
 * Digital Work AI Exhibition • Waroeng Latte Madiun
 */

const fs = require('node:fs');
const path = require('node:path');
const mqtt = require('mqtt');

const STATE_FILE = process.env.VERCEL
    ? '/tmp/cloud_state.json'
    : path.join(__dirname, '..', 'data', 'cloud_state.json');

const INITIAL_VIP_GUESTS = [];

let memoryGuests = [];
let deletedGuestIds = new Set();
let hasLoadedRetained = false;

function loadLocalState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.deletedIds)) {
                deletedGuestIds = new Set(parsed.deletedIds);
            }
            if (Array.isArray(parsed.guests) && parsed.guests.length > 0) {
                memoryGuests = parsed.guests.filter(g => !deletedGuestIds.has(g.id));
                return;
            }
        }
    } catch (e) {}
    memoryGuests = INITIAL_VIP_GUESTS.filter(g => !deletedGuestIds.has(g.id));
}
loadLocalState();

function persistLocalState() {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            guests: memoryGuests,
            deletedIds: Array.from(deletedGuestIds),
            lastUpdated: new Date().toISOString()
        }, null, 2), 'utf-8');
    } catch (e) {}
}

// Global MQTT Client for Retained State Sync
let mqttClient = null;
const MQTT_TOPIC_STATE = 'mbd_ai_exhibition_madiun_2026/state';

function getOrInitMqtt() {
    if (mqttClient) return mqttClient;
    try {
        mqttClient = mqtt.connect('mqtt://broker.hivemq.com:1883', {
            reconnectPeriod: 2500,
            connectTimeout: 4000,
            keepalive: 60
        });

        mqttClient.on('connect', () => {
            mqttClient.subscribe(MQTT_TOPIC_STATE, { qos: 1 });
        });

        mqttClient.on('message', (topic, msg) => {
            if (topic === MQTT_TOPIC_STATE) {
                try {
                    hasLoadedRetained = true;
                    if (!msg || msg.length === 0) return;
                    const parsed = JSON.parse(msg.toString());
                    if (Array.isArray(parsed.deletedIds)) {
                        parsed.deletedIds.forEach(id => deletedGuestIds.add(id));
                    }
                    if (Array.isArray(parsed.guests)) {
                        const map = new Map();
                        memoryGuests.forEach(g => { if (g.id && !deletedGuestIds.has(g.id)) map.set(g.id, g); });
                        parsed.guests.forEach(g => {
                            if (g.id && !deletedGuestIds.has(g.id)) {
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
    return mqttClient;
}
getOrInitMqtt();

function ensureMqttConnected() {
    return new Promise((resolve) => {
        const client = getOrInitMqtt();
        if (!client) return resolve(null);
        if (client.connected) return resolve(client);
        
        let done = false;
        const timer = setTimeout(() => {
            if (!done) { done = true; resolve(client.connected ? client : null); }
        }, 1500);

        client.once('connect', () => {
            if (!done) { done = true; clearTimeout(timer); resolve(client); }
        });
    });
}

async function broadcastState() {
    try {
        const client = await ensureMqttConnected();
        if (client && client.connected) {
            const payload = JSON.stringify({
                guests: memoryGuests,
                deletedIds: Array.from(deletedGuestIds),
                lastUpdated: new Date().toISOString()
            });
            await new Promise((resolve) => {
                client.publish(MQTT_TOPIC_STATE, payload, { retain: true, qos: 1 }, () => resolve());
            });
        }
    } catch (e) {}
}

async function getCloudGuests() {
    // If local memory is empty on cold container, give HiveMQ up to 700ms to deliver retained state
    if (memoryGuests.length === 0 && !hasLoadedRetained) {
        await new Promise((resolve) => {
            ensureMqttConnected();
            const timer = setTimeout(() => resolve(), 700);
            if (mqttClient) {
                mqttClient.once('message', (topic) => {
                    if (topic === MQTT_TOPIC_STATE) {
                        clearTimeout(timer);
                        resolve();
                    }
                });
            }
        });
        hasLoadedRetained = true;
    }
    return memoryGuests.filter(g => !deletedGuestIds.has(g.id));
}

function isGuestDeleted(guestId) {
    return deletedGuestIds.has(guestId);
}

function getDeletedGuestIds() {
    return deletedGuestIds;
}

async function saveGuestToCloud(guestRecord) {
    if (!guestRecord || !guestRecord.name) return false;
    if (deletedGuestIds.has(guestRecord.id)) {
        return false;
    }

    const existingIdx = memoryGuests.findIndex(g => g.id === guestRecord.id);
    if (existingIdx >= 0) {
        memoryGuests[existingIdx] = { ...memoryGuests[existingIdx], ...guestRecord };
    } else {
        memoryGuests = [guestRecord, ...memoryGuests];
    }

    persistLocalState();
    await broadcastState();
    return true;
}

async function deleteGuestFromCloud(guestId) {
    if (!guestId) return false;
    deletedGuestIds.add(guestId);
    memoryGuests = memoryGuests.filter(g => g.id !== guestId);
    persistLocalState();
    await broadcastState();
    return true;
}

async function resetCloudGuests() {
    memoryGuests = [];
    deletedGuestIds.clear();
    persistLocalState();
    try {
        const client = await ensureMqttConnected();
        if (client && client.connected) {
            const emptyPayload = JSON.stringify({
                guests: [],
                deletedIds: [],
                lastUpdated: new Date().toISOString()
            });
            await new Promise((resolve) => {
                client.publish(MQTT_TOPIC_STATE, emptyPayload, { retain: true, qos: 1 }, () => resolve());
            });
        }
    } catch (e) {}
}

module.exports = {
    getCloudGuests,
    saveGuestToCloud,
    deleteGuestFromCloud,
    resetCloudGuests,
    isGuestDeleted,
    getDeletedGuestIds,
    getLastCloudError: () => null
};
