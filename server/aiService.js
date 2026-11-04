// AI Service: Gemini API + Local Indonesian Lexicon Fallback
require('dotenv').config();

const INDONESIAN_STOPWORDS = new Set([
    'dan', 'di', 'ke', 'dari', 'yang', 'untuk', 'pada', 'dengan', 'adalah', 'ini',
    'itu', 'dalam', 'bisa', 'akan', 'saya', 'kami', 'kita', 'mereka', 'sangat',
    'juga', 'sudah', 'lebih', 'agar', 'karena', 'oleh', 'saat', 'para', 'bagi'
]);

const POSITIVE_LEXICON = [
    'hebat', 'luar biasa', 'keren', 'maju', 'sukses', 'bangga', 'inspiratif', 'solutif',
    'inovatif', 'terobosan', 'potensial', 'mantap', 'terbaik', 'senang', 'berkembang',
    'kreatif', 'modern', 'canggih', 'revolusioner', 'bagus', 'antusias', 'optimis',
    'cerdas', 'solutif', 'bersemangat', 'juara', 'berkarya', 'menembus', 'prestasi'
];

const EMOTION_MAPPING = {
    'Inspiratif': ['inspiratif', 'terobosan', 'revolusioner', 'karya', 'inovatif', 'luar biasa'],
    'Antusias': ['antusias', 'semangat', 'senang', 'bersemangat', 'keren', 'mantap'],
    'Optimis': ['optimis', 'maju', 'berkembang', 'potensial', 'masa depan', 'sukses'],
    'Bangga': ['bangga', 'prestasi', 'talenta', 'anak muda', 'juara', 'indonesia'],
    'Kreatif': ['kreatif', 'canggih', 'modern', 'cerdas', 'solutif', 'unik']
};

function localAnalyzeSentiment(text) {
    const lower = text.toLowerCase();
    const words = lower.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

    let positiveScore = 0;
    for (const word of words) {
        if (POSITIVE_LEXICON.some(lex => word.includes(lex) || lex.includes(word))) {
            positiveScore += 1;
        }
    }

    // Determine emotion
    let detectedEmotion = 'Antusias';
    let maxEmotionHits = 0;
    for (const [emotion, triggers] of Object.entries(EMOTION_MAPPING)) {
        let hits = 0;
        for (const trigger of triggers) {
            if (lower.includes(trigger)) hits++;
        }
        if (hits > maxEmotionHits) {
            maxEmotionHits = hits;
            detectedEmotion = emotion;
        }
    }

    // Normalized score
    const score = words.length > 0 ? Math.min(1.0, 0.5 + (positiveScore * 0.15)) : 0.5;
    const sentiment = score >= 0.65 ? 'positive' : (score <= 0.4 ? 'critical' : 'neutral');

    // Extract keywords (words >= 4 chars, not stopwords)
    const candidates = words.filter(w => w.length >= 4 && !INDONESIAN_STOPWORDS.has(w));
    const uniqueKeywords = Array.from(new Set(candidates)).slice(0, 4);

    return {
        sentiment,
        score: parseFloat(score.toFixed(2)),
        emotion: detectedEmotion,
        keywords: uniqueKeywords.length > 0 ? uniqueKeywords : ['Digital', 'AI', 'Inovasi'],
        provider: 'local_fallback'
    };
}

async function analyzeSentiment(text) {
    if (!text || text.trim() === '') {
        return {
            sentiment: 'neutral',
            score: 0.5,
            emotion: 'Netral',
            keywords: ['Hadir'],
            provider: 'default'
        };
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return localAnalyzeSentiment(text);
    }

    // Attempt Gemini API with 3.5s timeout for fast UI responsiveness
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    try {
        const prompt = `
Kamu adalah AI sentimen analyzer untuk buku tamu pameran digital "Menembus Batas Digital : Kolaborasi Talenta Muda dan Artificial Intelligence".
Analisis pesan tamu berikut:
"${text}"

Keluarkan HANYA JSON murni tanpa format markdown codeblock dengan struktur:
{
  "sentiment": "positive" | "neutral" | "negative",
  "score": 0.0 - 1.0,
  "emotion": "Inspiratif" | "Antusias" | "Optimis" | "Bangga" | "Kreatif",
  "keywords": ["kata1", "kata2", "kata3"]
}
`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    responseMimeType: "application/json"
                }
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`[AI] Gemini API error: ${response.statusText}, fallback ke lexicon lokal.`);
            return localAnalyzeSentiment(text);
        }

        const data = await response.json();
        const rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawJsonText) {
            return localAnalyzeSentiment(text);
        }

        const parsed = JSON.parse(rawJsonText);
        return {
            sentiment: parsed.sentiment || 'positive',
            score: typeof parsed.score === 'number' ? parsed.score : 0.85,
            emotion: parsed.emotion || 'Antusias',
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 4) : ['AI', 'Digital'],
            provider: 'gemini'
        };
    } catch (err) {
        clearTimeout(timeoutId);
        console.warn(`[AI] Gagal menghubungi Gemini API (${err.message}). Menggunakan analisis lokal.`);
        return localAnalyzeSentiment(text);
    }
}

module.exports = {
    analyzeSentiment,
    localAnalyzeSentiment
};
