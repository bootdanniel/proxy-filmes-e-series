import express from 'express';
import { Readable } from 'node:stream';

const app = express();
const PORT = 3000;
let tunnelUrl = null;

export function setTunnelUrl(url) {
    tunnelUrl = url;
    console.log(`[server] URL do tunel salva: ${url}`);
}

// O BOT vai ler esta URL
app.get('/tunnel-url', (req, res) => {
    if (tunnelUrl) res.json({ url: tunnelUrl });
    else res.status(404).json({ error: 'URL ainda nao disponivel' });
});

// Rota que o seu Site 2 vai chamar: /stream/movie/45904 ou /stream/series/4164?season=1&episode=1
app.get('/stream/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { season = '1', episode = '1' } = req.query;

    if (!['movie', 'series'].includes(type)) return res.status(400).send('Tipo invalido');

    try {
        // 1. Pega o HTML do iframe original (onde fica o token)
        const iframeUrl = `https://bionicserver.cu.ma/wumv/w/${type}/${id}?season=${season}&episode=${episode}`;
        const htmlRes = await fetch(iframeUrl, {
            headers: { 
                'Referer': 'https://wuembed.dpdns.org/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const html = await htmlRes.text();
        
        // 2. Extrai o Token do JSON escondido
        const match = html.match(/"t"\s*:\s*"([^"]+)"/);
        if (!match) return res.status(500).send('Token nao encontrado no HTML');
        const token = match[1];

        // 3. Monta a URL REAL do MP4
        const mp4Url = `https://bionicserver.cu.ma/stream?s=${token}`;

        // 4. Faz o proxy do MP4 para o site 2 (Suporta Range/Seek para o video rodar liso)
        const range = req.headers.range;
        const headers = {
            'Referer': 'https://wuembed.dpdns.org/',
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
        res.setHeader('Access-Control-Allow-Headers', '*');
        
        if (videoRes.body) {
            Readable.fromWeb(videoRes.body).pipe(res);
        } else {
            res.end();
        }

    } catch (e) {
        console.error(e);
        res.status(500).send('Erro no Proxy: ' + e.message);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Proxy de Filmes rodando na porta ${PORT}`));
