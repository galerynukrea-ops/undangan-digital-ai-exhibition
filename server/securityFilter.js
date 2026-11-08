// Security Guard, Profanity Filter, Sanitizer, and Anti-Spam Throttler
// AMATERASU Security Protocol v1.0 (SEC-01 through SEC-07)

// Comprehensive blacklist: Indonesian, Javanese slang, English vulgarities, and common spam patterns
const PROFANITY_WORDS = [
    // Bahasa Indonesia
    'anjing', 'babi', 'bangsat', 'kontol', 'memek', 'jembut', 'ngentot', 'pantek',
    'peler', 'pepek', 'tetek', 'itil', 'bego', 'goblok', 'tolol', 'lonte', 'perek',
    'pendo', 'bajingan', 'kampret', 'bokep', 'porno', 'ngocok', 'coli', 'sange',
    'toket', 'seks', 'vagina', 'penis', 'titit', 'tai', 'taek', 'brengsek', 'bejat',
    'idiot', 'puki', 'pukimak', 'kimak', 'pecun', 'jablay', 'bispak', 'entot',
    // Bahasa Jawa / Jawa Timuran
    'jancuk', 'jancok', 'dancuk', 'dancok', 'asu', 'celeng', 'bajindul', 'matamu',
    'ndasmu', 'mbokmu', 'jancukers', 'gateli', 'gatelo', 'tempik', 'pejuh', 'sempak',
    'modar', 'kopok', 'raimu',
    // English
    'fuck', 'fucker', 'fucking', 'shit', 'bitch', 'asshole', 'bastard', 'dick',
    'pussy', 'slut', 'whore', 'porn', 'cunt', 'cock', 'blowjob', 'nude', 'boobs'
];

// Normalize leetspeak and special characters for obfuscated evasion detection
function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove zero-width chars
        .replace(/0/g, 'o')
        .replace(/1/g, 'i')
        .replace(/3/g, 'e')
        .replace(/4/g, 'a')
        .replace(/5/g, 's')
        .replace(/8/g, 'b')
        .replace(/@/g, 'a')
        .replace(/\$/g, 's')
        .replace(/[._\-+*\/\\#]/g, ''); // strip punctuation used for splitting bad words (e.g., k.o.n.t.o.l)
}

/**
 * Checks if input contains banned profanity words
 * @param {string} text 
 * @returns {{ isProfane: boolean, matchedWord: string | null }}
 */
function checkProfanity(text) {
    if (!text || typeof text !== 'string') return { isProfane: false, matchedWord: null };
    
    const rawLower = text.toLowerCase();
    const normalized = normalizeText(text);

    for (const badWord of PROFANITY_WORDS) {
        // Direct word boundary test in raw string
        const regex = new RegExp(`\\b${badWord}\\b`, 'i');
        if (regex.test(rawLower)) {
            return { isProfane: true, matchedWord: badWord };
        }
        // Substring test in normalized string for words >= 4 chars (avoids false positives on 2-3 char words)
        if (badWord.length >= 4 && normalized.includes(badWord)) {
            return { isProfane: true, matchedWord: badWord };
        }
        // Specific short words with high precision
        if (['asu', 'tai', 'itil', 'babi'].includes(badWord)) {
            if (rawLower.split(/\s+/).includes(badWord)) {
                return { isProfane: true, matchedWord: badWord };
            }
        }
    }

    return { isProfane: false, matchedWord: null };
}

/**
 * Censors profanity words by replacing them with ***
 * @param {string} text 
 * @returns {string}
 */
function censorProfanity(text) {
    if (!text || typeof text !== 'string') return '';
    let result = text;
    for (const badWord of PROFANITY_WORDS) {
        const regex = new RegExp(`\\b${badWord}\\b`, 'gi');
        result = result.replace(regex, '***');
    }
    return result;
}

/**
 * Sanitizes input string: strips HTML, strips control chars, enforces max length
 * @param {string} text 
 * @param {number} maxLength 
 * @returns {string}
 */
function sanitizeInput(text, maxLength = 60) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/<[^>]*>?/gm, '') // Strip HTML tags
        .replace(/[^\w\s\d.,'’\-\/()&]/g, '') // Keep safe chars
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim()
        .slice(0, maxLength);
}

// In-Memory Rate Limiting Tracker
const requestLog = new Map();

/**
 * Rate Limiter: max submissions per client/IP within windowMs
 * @param {string} clientIp 
 * @param {number} maxAllowed 
 * @param {number} windowMs 
 * @returns {{ allowed: boolean, remainingMs: number }}
 */
function checkRateLimit(clientIp, maxAllowed = 2, windowMs = 15000) {
    if (!clientIp) return { allowed: true, remainingMs: 0 };
    const now = Date.now();
    const timestamps = requestLog.get(clientIp) || [];
    
    // Filter timestamps within current window
    const recent = timestamps.filter(t => (now - t) < windowMs);
    
    if (recent.length >= maxAllowed) {
        const oldestRecent = recent[0];
        const remainingMs = Math.max(0, windowMs - (now - oldestRecent));
        return { allowed: false, remainingMs };
    }

    recent.push(now);
    requestLog.set(clientIp, recent);

    // Periodic map cleanup (keep size < 1000)
    if (requestLog.size > 1000) {
        for (const [ip, list] of requestLog.entries()) {
            if (list.length === 0 || (now - list[list.length - 1]) > 60000) {
                requestLog.delete(ip);
            }
        }
    }

    return { allowed: true, remainingMs: 0 };
}

module.exports = {
    checkProfanity,
    censorProfanity,
    sanitizeInput,
    checkRateLimit
};
