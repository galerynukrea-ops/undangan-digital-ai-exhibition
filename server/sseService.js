// Server-Sent Events (SSE) manager for live display
let clients = [];

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
    for (const client of clients) {
        try {
            client.res.write(`data: ${dataString}\n\n`);
        } catch (err) {
            console.error(`[SSE] Gagal kirim ke client ${client.id}:`, err.message);
        }
    }
}

module.exports = {
    addClient,
    broadcastEvent
};
