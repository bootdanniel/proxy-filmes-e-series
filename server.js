import express from 'express';
import { Readable } from 'node:stream';

const app = express();
const PORT = 3000;
let tunnelUrl = null;
const tunnelLog = []; // Buffer de logs

export function setTunnelUrl(url) {
    tunnelUrl = url;
    console.log(`[server] URL do tunel salva: ${url}`);
}

export function logTunnel(linha) {
    tunnelLog.push(linha);
    if (tunnelLog.length > 200) tunnelLog.shift();
}

app.get('/tunnel-url', (req, res) => {
    if (tunnelUrl) res.json({ url: tunnelUrl });
    else res.status(404).json({ error: 'URL ainda nao disponivel' });
});

app.get('/debug-tunnel', (req, res) => {
    res.json({
        temUrl: !!tunnelUrl,
        url: tunnelUrl,
        ultimasLinhas: tunnelLog.slice(-40)
    });
});

app.get('/stream/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { season = '1', episode = '1' } = req.query;
    if (!['movie', 'series'].includes(type)) return res.status(400).send('Tipo invalido');

    try {
        const iframeUrl = `https://bionicserver.cu.ma/wumv/w/${type}/${id}?season=${season}&episode=${episode}`;
        const htmlRes = await fetch(iframeUrl, {
            headers: { 
                'Referer': 'https://wuembed.dpdns.org/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const html = await htmlRes.text();
        const match = html.match(/"t"\s*:\s*"([^"]+)"/);
        if (!match) return res.status(500).send('Token nao encontrado');
        const token = match[1];
        const mp4Url = `https://bionicserver.cu.ma/stream?s=${token}`;

        const range = req.headers.range;
        const headers = {
            'Referer': 'https://wuembed.dpdns.org/',
            'Origin': 'https://wuembed.dpdns.org', // <-- ADICIONADO AQUI
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        if (range) headers['Range'] = range;

        const videoRes = await fetch(mp4Url, { headers });
        res.status(videoRes.status);
        videoRes.headers.forEach((value, key) => {
            if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (videoRes.body) Readable.fromWeb(videoRes.body).pipe(res);
        else res.end();
    } catch (e) {
        console.error(e);
        res.status(500).send('Erro no Proxy: ' + e.message);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Proxy rodando na porta ${PORT}`));
