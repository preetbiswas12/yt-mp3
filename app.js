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
const apiKeys = process.env.API_KEYS.split(',').map(k => k.trim()); 
const apiHost = process.env.apiHost?.trim();
const apiUrl = process.env.apiUrl?.trim();

console.log('Loaded Config:', { apiKeysCount: apiKeys.length, apiHost, apiUrl });

// --- NEW: Helper function to rotate keys on failure ---
async function fetchWithRotation(videoId) {
    let lastError;
    for (const key of apiKeys) {
        try {
            // youtube-mp36 API endpoint format: /dl?id={videoId}
            const downloadUrl = `${apiUrl}/dl?id=${videoId}`;
            console.log(`Trying key with URL:`, downloadUrl);
            return await axios({
                method: 'GET',
                url: downloadUrl,
                headers: { 
                    'x-rapidapi-key': key.trim(), 
                    'x-rapidapi-host': apiHost.trim() 
                },
                maxRedirects: 10,
                timeout: 10000
            });
        } catch (e) {
            lastError = e;
            console.log(`Key failed with status ${e.response?.status}:`, e.response?.data?.message || e.message);
            // If error is 429 (Too many requests) or 403 (Quota), try next key
            if (e.response && (e.response.status === 429 || e.response.status === 403)) {
                console.log(`Rotating to next key...`);
                continue;
            }
            throw e; // If it's a different error, stop and show it
        }
    }
    throw lastError;
}

// Store ongoing downloads in memory
const downloadMap = new Map();

// --- STEP 1: START ---
app.post('/api/start', async (req, res) => {
    try {
        const videoUrl = req.body.url;
        if (!videoUrl) return res.status(400).json({ error: 'URL required' });

        // Extract video ID from URL
        const videoIdMatch = videoUrl.match(/(?:v=|\/|youtu\.be\/)([0-9A-Za-z_-]{11})/);
        if (!videoIdMatch) return res.status(400).json({ error: 'Invalid YouTube URL' });
        
        const videoId = videoIdMatch[1];

        // Fetch download info from youtube-mp36 API
        const response = await fetchWithRotation(videoId);
        
        // Extract download URL from response
        const downloadLink = response.data.link;
        const title = response.data.title || 'audio';
        
        // Store the download info for polling
        downloadMap.set(videoId, { downloadUrl: downloadLink, title: title });
        
        console.log({videoId, title, downloadLink});
        res.json({ 
            success: true, 
            pid: videoId,
            title: title,
            downloadUrl: downloadLink
        });
    } catch (e) { 
        console.error('Start error:', e.message);
        res.status(500).json({ error: e.message }); 
    }
});

// --- STEP 2: CHECK STATUS (POLLING) ---
app.get('/api/status', async (req, res) => {
    try {
        const videoId = req.query.id;
        const downloadInfo = downloadMap.get(videoId);
        
        if (downloadInfo) {
            // Return immediately with 100% progress since our API is fast
            res.json({ 
                progress: 1000,
                downloadUrl: downloadInfo.downloadUrl,
                status: 'ready'
            });
        } else {
            res.json({ progress: 0, status: 'waiting' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STEP 3: STREAM FILE ---
app.post('/api/stream', async (req, res) => {
    const { downloadUrl, title } = req.body;
    try {
        console.log('Streaming from:', downloadUrl);
        
        // Make request to download the MP3 with proper headers
        const response = await axios({ 
            method: 'GET', 
            url: downloadUrl, 
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive'
            },
            maxRedirects: 10,
            timeout: 60000
        });
        
        const safeTitle = (title || 'audio').replace(/[^\w\s]/gi, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        
        console.log('Starting download with title:', safeTitle);
        
        response.data.on('error', (err) => {
            console.error('Stream error:', err);
            if (!res.headersSent) {
                res.status(500).send('Error downloading file');
            }
        });
        
        res.on('error', (err) => {
            console.error('Response error:', err);
        });
        
        response.data.pipe(res);
    } catch (e) { 
        console.error('Stream error:', e.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error fetching file: ' + e.message }); 
        }
    }
});
app.get('/', (req, res) => res.render("index"));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));