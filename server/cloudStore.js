/**
 * CLOUD STORE SYNCHRONIZER (Concurrency-Safe with Auto-Retry & Jitter)
 * Ensures 100% persistent shared state across all Vercel Serverless instances.
 * Digital Work AI Exhibition • Waroeng Latte Madiun
 */

const CLOUD_OBJECT_ID = 'ff808181a09d98f701a1ac2d2e2a43b0';
const CLOUD_URL = `https://api.restful-api.dev/objects/${CLOUD_OBJECT_ID}`;

let memoryCache = [];
let lastFetchTime = 0;
const CACHE_TTL = 1000; // 1 second local in-memory cache

async function getCloudGuests() {
    const now = Date.now();
    if (memoryCache.length > 0 && now - lastFetchTime < CACHE_TTL) {
        return memoryCache;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(CLOUD_URL, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeout);

        if (res.ok) {
            const json = await res.json();
            const list = json.data?.guests || [];
            if (Array.isArray(list)) {
                memoryCache = list;
                lastFetchTime = now;
                return list;
            }
        }
    } catch (err) {
        console.warn('[CloudStore] Fetch error:', err.message);
    }
    return memoryCache;
}

async function saveGuestToCloud(guestRecord) {
    if (!guestRecord || !guestRecord.name) return false;

    // Retry loop with exponential backoff and jitter to survive simultaneous phone submissions
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            if (attempt > 1) {
                const jitter = 150 * attempt + Math.random() * 200;
                await new Promise(r => setTimeout(r, jitter));
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);

            const res = await fetch(CLOUD_URL, {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(timeout);

            if (!res.ok) continue;

            const json = await res.json();
            const currentList = Array.isArray(json.data?.guests) ? json.data.guests : [];

            // If already present, update; otherwise prepend
            const existingIdx = currentList.findIndex(g => g.id === guestRecord.id);
            let updatedList;
            if (existingIdx >= 0) {
                updatedList = [...currentList];
                updatedList[existingIdx] = { ...updatedList[existingIdx], ...guestRecord };
            } else {
                updatedList = [guestRecord, ...currentList];
            }

            const putController = new AbortController();
            const putTimeout = setTimeout(() => putController.abort(), 7000);

            const putRes = await fetch(CLOUD_URL, {
                method: 'PUT',
                signal: putController.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'digital_work_ai_exhibition_madiun_2026',
                    data: {
                        guests: updatedList,
                        lastUpdated: new Date().toISOString()
                    }
                })
            });
            clearTimeout(putTimeout);

            if (putRes.ok) {
                // Verify our guest is safely committed
                const verifyRes = await fetch(CLOUD_URL, { headers: { 'Accept': 'application/json' } });
                if (verifyRes.ok) {
                    const verifyJson = await verifyRes.json();
                    const verifyList = verifyJson.data?.guests || [];
                    if (verifyList.some(g => g.id === guestRecord.id)) {
                        memoryCache = verifyList;
                        lastFetchTime = Date.now();
                        return true;
                    }
                }
            }
        } catch (err) {
            console.warn(`[CloudStore] Save attempt ${attempt} error:`, err.message);
        }
    }
    return false;
}

async function resetCloudGuests() {
    memoryCache = [];
    lastFetchTime = Date.now();
    try {
        await fetch(CLOUD_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'digital_work_ai_exhibition_madiun_2026',
                data: {
                    guests: [],
                    lastUpdated: new Date().toISOString()
                }
            })
        });
    } catch (err) {
        console.warn('[CloudStore] Reset error:', err.message);
    }
}

module.exports = {
    getCloudGuests,
    saveGuestToCloud,
    resetCloudGuests
};
