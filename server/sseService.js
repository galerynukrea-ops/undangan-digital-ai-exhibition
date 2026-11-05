// Server-Sent Events (SSE) & Global Real-time MQTT Manager for Live Display
const mqtt = require('mqtt');
let clients = [];
let mqttClient = null;

try {
    mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
        reconnectPeriod: 2500,
        connectTimeout: 5000
    });
    mqttClient.on('connect', () => {
        console.log('[MQTT] Server connected to global real-time broker.');
    });
    mqttClient.on('error', (err) => {
        console.warn('[MQTT] Broker connection notice:', err.message);
    });
} catch (e) {
    console.warn('[MQTT] Could not initialize server MQTT client:', e.message);
}

function addClient(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const clientId = Date.now() + '-' + Math.random().toString(36).substring(2, 9);
    const newClient = { id: clientId, res };
    clients.push(newClient);

    // Initial keepalive ping
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
}

function broadcastEvent(eventType, payload) {
    const dataString = JSON.stringify({ type: eventType, data: payload, timestamp: new Date().toISOString() });

    // 1. Local Server-Sent Events
    for (const client of clients) {
        try {
            client.res.write(`data: ${dataString}\n\n`);
        } catch (err) {}
    }

    // 2. Global Real-time MQTT Broadcast across all Vercel containers & devices
    try {
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish('mbd_ai_exhibition_madiun_2026/events', dataString);
        }
    } catch (e) {}
}

module.exports = {
    addClient,
    broadcastEvent
};
