/**
 * CLOUD STORE SYNCHRONIZER
 * Provides global persistence across ephemeral Vercel Serverless containers.
 * Digital Work AI Exhibition • Waroeng Latte Madiun
 */

const CLOUD_OBJECT_ID = 'ff808181a09d98f701a1ac2d2e2a43b0';
const CLOUD_URL = `https://api.restful-api.dev/objects/${CLOUD_OBJECT_ID}`;

let memoryCache = [];
let lastFetchTime = 0;
const CACHE_TTL = 1500; // 1.5 seconds local in-memory cache to reduce network latency

async function getCloudGuests() {
    const now = Date.now();
    if (memoryCache.length > 0 && now - lastFetchTime < CACHE_TTL) {
        return memoryCache;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);

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
        console.warn('[CloudStore] Fetch error (using cache):', err.message);
    }
    return memoryCache;
}

async function saveGuestToCloud(guestRecord) {
    if (!guestRecord || !guestRecord.name) return;

    try {
        const currentList = await getCloudGuests();
        const existingIdx = currentList.findIndex(g => g.id === guestRecord.id);

        let updatedList;
        if (existingIdx >= 0) {
            updatedList = [...currentList];
            updatedList[existingIdx] = { ...updatedList[existingIdx], ...guestRecord };
        } else {
            updatedList = [guestRecord, ...currentList];
        }

        memoryCache = updatedList;
        lastFetchTime = Date.now();

        // Push to cloud asynchronously
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        await fetch(CLOUD_URL, {
            method: 'PUT',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'digital_work_ai_exhibition_madiun_2026',
                data: {
                    guests: updatedList,
                    lastUpdated: new Date().toISOString()
                }
            })
        });
        clearTimeout(timeout);
    } catch (err) {
        console.warn('[CloudStore] Save error:', err.message);
    }
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
