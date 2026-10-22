import axios from 'axios';
import https from 'https';

const API_BASE = 'https://console-api.akash.network/v1';
const API_KEYS = JSON.parse(process.env.AKASH_API_KEYS || '[]');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FAIL_RE = /ImagePullBackOff|ErrImagePull|CrashLoopBackOff|CreateContainerConfigError|Back-off restarting|Failed to pull|exec format error|invalid image/i;

const TEXTDB_KEY = 'proxyfilmeseseries';
const TEXTDB_UPDATE = 'https://textdb.online/update/';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function publicarNoTextDb(url) {
    for (let t = 1; t <= 3; t++) {
        try {
            const r = await axios.get(`${TEXTDB_UPDATE}?key=${TEXTDB_KEY}&value=${url}`, { timeout: 15000 });
            if (r.data && r.data.status === 1) { console.log(`✅ URL publicada no textdb: ${url}`); return true; }
        } catch (e) {}
        if (t < 3) await sleep(2000);
    }
    return false;
}

async function runBot() {
    console.log('🤖 Iniciando Bot Akash (Modo Paciente v7)...');
    
    for (const key of API_KEYS) {
        try {
            const h = { 'x-api-key': key };
            const deps = await axios.get(`${API_BASE}/deployments`, { headers: h });
            const raw = deps.data?.data ?? deps.data;
            const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
            for (const d of list) {
                if (d.state !== 'closed') {
                    await axios.delete(`${API_BASE}/deployments/${d.dseq}`, { headers: h });
                    console.log(`🧹 Deploy ${d.dseq} removido`);
                }
            }
        } catch (e) {}
    }

    let chosenKey = null, maxBalance = 0;
    let tentativasSaldo = 0;
    
    while (tentativasSaldo < 15) {
        maxBalance = 0; chosenKey = null;
        for (const key of API_KEYS) {
            try {
                const res = await axios.get(`${API_BASE}/balances`, { headers: { 'x-api-key': key } });
                const b = Number(res.data?.data?.balance || 0) / 1000000;
                if (b > maxBalance) { maxBalance = b; chosenKey = key; }
            } catch (e) {}
        }
        
        if (maxBalance >= 0.15) {
            console.log(`💰 Saldo liberado! Usando conta com ${maxBalance.toFixed(3)} AKT.`);
            break;
        }
        
        console.log(`⏳ Saldo preso no escrow (${maxBalance.toFixed(3)} AKT). Aguardando 1 minuto... (${tentativasSaldo+1}/15)`);
        await sleep(60000);
        tentativasSaldo++;
    }

    if (!chosenKey || maxBalance < 0.15) { 
        console.log('❌ Desisti. O saldo não voltou a tempo.'); 
        process.exit(0); 
    }
    
    const headers = { 'x-api-key': chosenKey, 'Content-Type': 'application/json' };

    const sdl = `
---
version: "2.0"
services:
  proxy:
    image: ghcr.io/bootdanniel/proxy-filmes-e-series:v7
    expose:
      - port: 3000
        as: 80
        to:
          - global: true
profiles:
  compute:
    proxy:
      resources:
        cpu: { units: 0.5 }
        memory: { size: 1Gi }
        storage: { size: 1Gi }
  placement:
    akash:
      pricing:
        proxy: { denom: uakt, amount: 15000 }
deployment:
  proxy:
    akash: { profile: proxy, count: 1 }
`;

    let createRes;
    try {
        createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl } }, { headers });
    } catch (e) {
        console.log('❌ Erro ao criar deploy:', e.response?.data?.message || e.message);
        process.exit(0); 
    }
    
    const dseq = createRes.data?.data?.dseq;
    const manifest = createRes.data?.data?.manifest;
    console.log(`✅ Deploy v7 criado! DSEQ: ${dseq}`);
    
    let bids = [];
    for (let i = 0; i < 20; i++) {
        await sleep(3000);
        try {
            const r = await axios.get(`${API_BASE}/bids?dseq=${dseq}`, { headers });
            bids = r.data?.data || [];
            if (bids.length) { console.log(`✅ ${bids.length} bid(s)`); break; }
        } catch (e) {}
    }
    
    if (!bids.length) { process.exit(0); }

    const validBids = bids.map(it => {
        const b = it.bid || it;
        return { provider: b.id?.provider || b.provider, price: b.price };
    }).filter(b => b.provider && b.price?.amount);
    
    if (validBids.length === 0) { 
        console.log('❌ Nenhum provedor válido.');
        process.exit(0);
    }
    
    validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));
    const chosenBid = validBids[0];
    console.log(`🤝 Provedor: ${chosenBid.provider.substring(0, 15)}...`);

    try {
        await axios.post(`${API_BASE}/leases`, { manifest, leases: [{ dseq, gseq: 1, oseq: 1, provider: chosenBid.provider }] }, { headers });
    } catch (e) {
        console.log('❌ Falha ao criar lease.');
        process.exit(0);
    }

    let isReady = false, providerUri = null;
    for (let i = 0; i < 36; i++) {
        await sleep(5000);
        try {
            const r = await axios.get(`${API_BASE}/deployments/${dseq}`, { headers });
            const rawLeases = r.data?.data?.leases ?? r.data?.leases ?? [];
            const leases = Array.isArray(rawLeases) ? rawLeases : [];
            
            if (leases.length > 0) {
                const raw = JSON.stringify(leases[0].status || {});
                if (FAIL_RE.test(raw)) { break; }
                const svcs = leases[0].status?.services || {};
                const list = Array.isArray(svcs) ? svcs : Object.values(svcs);
                if (list.length > 0) {
                    const ready = (Number(list[0].ready_replicas) || Number(list[0].available) || 0) >= 1;
                    const uri = (list[0].uris || list[0].uri || [])[0];
                    if (ready && uri) { 
                        isReady = true; 
                        providerUri = uri.startsWith('http') ? uri : `https://${uri}`; 
                        break; 
                    }
                }
            }
        } catch (e) {}
    }

    if (!isReady) {
        console.log(`❌ Container nao subiu.`);
        process.exit(1);
    }

    console.log(`✅ Container v7 rodando! URI: ${providerUri}`);
    
    let urlTunel = null;
    for (let i = 0; i < 60 && !urlTunel; i++) {
        try {
            const resp = await axios.get(`${providerUri}/tunnel-url`, { timeout: 10000, httpsAgent });
            if (resp.data?.url) { urlTunel = resp.data.url; break; }
        } catch (e) {}
        
        if (i % 12 === 0 && i > 0) console.log(`[${i*5}s] Aguardando o Túnel subir...`);
        await sleep(5000);
    }

    if (urlTunel) {
        console.log(`🎉 TUNEL ENCONTRADO: ${urlTunel}`);
        await publicarNoTextDb(urlTunel);
        console.log(`\n✅ Bot concluido com sucesso.`);
        process.exit(0);
    } else {
        console.log(`⚠️ Ingress respondeu, mas o túnel não.`);
        process.exit(0); 
    }
}
runBot();
