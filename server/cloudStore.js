/**
 * CLOUD STORE & REAL-TIME STATE SYNCHRONIZER (With Distributed Consensus & Reset Epoch)
 * Multi-layer persistence: In-Memory + Local JSON + MQTT Retained State.
 * Prevents split-brain, disappearing guests, and phantom resurrection across Vercel serverless containers.
 * Digital Work AI Exhibition • Waroeng Latte Madiun
 */

const fs = require('node:fs');
const path = require('node:path');
const mqtt = require('mqtt');

const STATE_FILE = process.env.VERCEL
    ? '/tmp/cloud_state.json'
    : path.join(__dirname, '..', 'data', 'cloud_state.json');

const BUNDLED_STATE_FILE = path.join(__dirname, '..', 'data', 'cloud_state.json');

const INITIAL_VIP_GUESTS = [];

let memoryGuests = [];
let deletedGuestIds = new Set();
let hasLoadedRetained = false;
let resetEpoch = 0; // Epoch timestamp (ms): any guest created before this is completely void

function loadLocalState() {
    try {
        const fileToRead = fs.existsSync(STATE_FILE)
            ? STATE_FILE
            : (fs.existsSync(BUNDLED_STATE_FILE) ? BUNDLED_STATE_FILE : null);

        if (fileToRead) {
            const raw = fs.readFileSync(fileToRead, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.resetEpoch) {
                resetEpoch = typeof parsed.resetEpoch === 'number' 
                    ? parsed.resetEpoch 
                    : new Date(parsed.resetEpoch).getTime() || 0;
            }
            if (Array.isArray(parsed.deletedIds)) {
                deletedGuestIds = new Set(parsed.deletedIds);
            }
            if (Array.isArray(parsed.guests) && parsed.guests.length > 0) {
                memoryGuests = parsed.guests.filter(g => {
                    if (!g || !g.id || deletedGuestIds.has(g.id)) return false;
                    const gTime = new Date(g.created_at || g.checked_in_at || 0).getTime();
                    return !resetEpoch || gTime >= resetEpoch;
                });
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
            resetEpoch,
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
                    
                    const incomingEpoch = parsed.resetEpoch
                        ? (typeof parsed.resetEpoch === 'number' ? parsed.resetEpoch : new Date(parsed.resetEpoch).getTime())
                        : 0;

                    // If a newer reset occurred anywhere, wipe local memory immediately
                    if (incomingEpoch && incomingEpoch > resetEpoch) {
                        resetEpoch = incomingEpoch;
                        memoryGuests = [];
                        deletedGuestIds.clear();
                    }

                    if (Array.isArray(parsed.deletedIds)) {
                        parsed.deletedIds.forEach(id => deletedGuestIds.add(id));
                    }

                    if (Array.isArray(parsed.guests)) {
                        if (parsed.guests.length === 0) {
                            // Authoritative reset: wipe memory list completely!
                            memoryGuests = [];
                        } else {
                            const map = new Map();
                            parsed.guests.forEach(g => {
                                if (g && g.id && !deletedGuestIds.has(g.id)) {
                                    const gTime = new Date(g.created_at || g.checked_in_at || 0).getTime();
                                    if (!resetEpoch || gTime >= resetEpoch) {
                                        map.set(g.id, g);
                                    }
                                }
                            });
                            memoryGuests = Array.from(map.values()).sort(
                                (a, b) => new Date(b.checked_in_at || 0) - new Date(a.checked_in_at || 0)
                            );
                        }
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
                resetEpoch,
                lastUpdated: new Date().toISOString()
            });
            await new Promise((resolve) => {
                client.publish(MQTT_TOPIC_STATE, payload, { retain: true, qos: 1 }, () => resolve());
            });
        }
    } catch (e) {}
}

async function getCloudGuests() {
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
    return memoryGuests.filter(g => {
        if (!g || !g.id || deletedGuestIds.has(g.id)) return false;
        const gTime = new Date(g.created_at || g.checked_in_at || 0).getTime();
        return !resetEpoch || gTime >= resetEpoch;
    });
}

function isGuestDeleted(guestId) {
    return deletedGuestIds.has(guestId);
}

function getDeletedGuestIds() {
    return deletedGuestIds;
}

function getResetEpoch() {
    return resetEpoch;
}

function isBeforeResetEpoch(isoOrTimestamp) {
    if (!resetEpoch || !isoOrTimestamp) return false;
    const t = new Date(isoOrTimestamp).getTime();
    return !isNaN(t) && t < resetEpoch;
}

async function saveGuestToCloud(guestRecord) {
    if (!guestRecord || !guestRecord.name) return false;
    if (deletedGuestIds.has(guestRecord.id)) return false;

    // Do not save old guests that were created prior to the reset epoch
    const recordTime = new Date(guestRecord.created_at || guestRecord.checked_in_at || 0).getTime();
    if (resetEpoch && recordTime < resetEpoch) return false;

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

async function resetCloudGuests(customEpochIso) {
    resetEpoch = customEpochIso ? new Date(customEpochIso).getTime() : Date.now();
    memoryGuests = [];
    deletedGuestIds.clear();
    persistLocalState();
    try {
        const client = await ensureMqttConnected();
        if (client && client.connected) {
            const emptyPayload = JSON.stringify({
                guests: [],
                deletedIds: [],
                resetEpoch,
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
    getResetEpoch,
    isBeforeResetEpoch,
    getLastCloudError: () => null
};
