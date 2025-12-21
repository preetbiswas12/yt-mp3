import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- MODIFIED: Split keys into an array ---
const apiKeys = process.env.API_KEYS.split(','); 
const { apiHost, apiUrl, progUrl } = process.env;

// --- NEW: Helper function to rotate keys on failure ---
async function fetchWithRotation(config) {
    let lastError;
    for (const key of apiKeys) {
        try {
            return await axios({
                ...config,
                headers: { ...config.headers, 'x-rapidapi-key': key, 'x-rapidapi-host': apiHost }
            });
        } catch (e) {
            lastError = e;
            // If error is 429 (Too many requests) or 403 (Quota), try next key
            if (e.response && (e.response.status === 429 || e.response.status === 403)) {
                console.log(`Key failed, rotating to next...`);
                continue;
            }
            throw e; // If it's a different error (like 400), stop and show it
        }
    }
    throw lastError;
}

// --- STEP 1: START ---
app.post('/api/start', async (req, res) => {
    try {
        const videoIdMatch = req.body.url.match(/(?:v=|\/|youtu\.be\/)([0-9A-Za-z_-]{11})/);
        if (!videoIdMatch) return res.status(400).json({ error: 'Invalid URL' });

        // MODIFIED: Use fetchWithRotation instead of axios.get
        const response = await fetchWithRotation({
            method: 'GET',
            url: apiUrl,
            params: { format: 'mp3', id: videoIdMatch[1], audioQuality: '128' }
        });

        if (response.data.progressId) {
            console.log({title: response.data.title, link: req.body.url });
            res.json({ success: true, pid: response.data.progressId, title: response.data.title });
        } else {
            res.status(500).json({ error: 'No ID returned' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STEP 2: CHECK STATUS (POLLING) ---
app.get('/api/status', async (req, res) => {
    try {
        // MODIFIED: Use fetchWithRotation instead of axios.get
        const { data } = await fetchWithRotation({
            method: 'GET',
            url: `${progUrl}?id=${req.query.id}`
        });
        res.json(data); 
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STEP 3: STREAM FILE (Remains the same) ---
app.post('/api/stream', async (req, res) => {
    const { downloadUrl, title } = req.body;
    try {
        const stream = await axios({ method: 'GET', url: downloadUrl, responseType: 'stream' });
        const safeTitle = (title || 'audio').replace(/[^\w\s]/gi, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        stream.data.pipe(res);
    } catch (e) { 
        console.error(e);
        res.send("Error fetching file stream."); 
    }
});
app.get('/', (req, res) => res.render("index"));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));