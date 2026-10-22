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
            if (r.data && r.data.status === 1) { console.log(`✅ URL publicada no textdb`); return true; }
        } catch (e) {}
        if (t < 3) await sleep(2000);
    }
    return false;
}

async function runBot() {
    console.log('🤖 Iniciando Bot Akash (Modo Ingress Direto)...');
    for (const key of API_KEYS) {
        try {
            const h = { 'x-api-key': key };
            const deps = await axios.get(`${API_BASE}/deployments`, { headers: h });
            for (const d of (Array.isArray(deps.data?.data) ? deps.data.data : [])) {
                if (d.state !== 'closed') {
                    await axios.delete(`${API_BASE}/deployments/${d.dseq}`, { headers: h });
                    console.log(`🧹 Deploy ${d.dseq} removido`);
                }
            }
        } catch (e) {}
    }
    await sleep(8000);

    const sdl = `
---
version: "2.0"
services:
  proxy:
    image: ghcr.io/bootdanniel/proxy-filmes-e-series:v5
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

    let chosenKey = null, maxBalance = 0;
    for (const key of API_KEYS) {
        try {
            const res = await axios.get(`${API_BASE}/balances`, { headers: { 'x-api-key': key } });
            const b = Number(res.data?.data?.balance || 0) / 1000000;
            if (b > maxBalance) { maxBalance = b; chosenKey = key; }
        } catch (e) {}
    }
    
    if (!chosenKey || maxBalance < 0.15) { 
        console.log('❌ Sem saldo líquido. Aguardando escrow...'); 
        process.exit(0); 
    }
    
    console.log(`💰 Usando conta com ${maxBalance.toFixed(3)} AKT`);
    const headers = { 'x-api-key': chosenKey, 'Content-Type': 'application/json' };

    let createRes;
    try {
        createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl } }, { headers });
    } catch (e) {
        console.log('❌ Erro ao criar deploy:', e.response?.data?.message || e.message);
        process.exit(0); 
    }
    
    const dseq = createRes.data?.data?.dseq;
    const manifest = createRes.data?.data?.manifest;
    console.log(`✅ Deploy criado! DSEQ: ${dseq}`);
    if (!dseq || !manifest) { process.exit(1); }

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
    validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));
    
    try {
        await axios.post(`${API_BASE}/leases`, { manifest, leases: [{ dseq, gseq: 1, oseq: 1, provider: validBids[0].provider }] }, { headers });
        console.log(`✅ Lease criado no provedor ${validBids[0].provider.substring(0, 10)}...`);
    } catch (e) {
        console.log('❌ Falha ao criar lease.');
        process.exit(0);
    }

    let isReady = false, providerUri = null;
    for (let i = 0; i < 36; i++) {
        await sleep(5000);
        try {
            const r = await axios.get(`${API_BASE}/deployments/${dseq}`, { headers });
            const lease = (r.data?.data?.leases || [])[0];
            const raw = JSON.stringify(lease?.status || {});
            if (FAIL_RE.test(raw)) { break; }
            const svcs = lease?.status?.services || {};
            for (const svc of (Array.isArray(svcs) ? svcs : Object.values(svcs))) {
                const ready = (Number(svc.ready_replicas) || Number(svc.available) || 0) >= 1;
                const uris = svc.uris || svc.uri || [];
                if (ready && uris.length) { isReady = true; providerUri = uris[0]; break; }
            }
            if (isReady) break;
        } catch (e) {}
    }

    if (!isReady) {
        console.log(`❌ Container nao subiu. Abortando.`);
        process.exit(1);
    }

    // AQUI ESTÁ A MÁGICA: Pegamos a URL ingress da Akash e testamos ela
    const baseUrl = providerUri.startsWith('http') ? providerUri : `https://${providerUri}`;
    console.log(`✅ Container rodando! Testando Ingress: ${baseUrl}`);
    
    let urlFinal = null;
    for (let i = 0; i < 20 && !urlFinal; i++) {
        try {
            // Faz um GET na raiz do nosso proxy pra ver se ele responde
            const resp = await axios.get(`${baseUrl}/debug-tunnel`, { timeout: 10000, httpsAgent });
            if (resp.status === 200) { urlFinal = baseUrl; break; }
        } catch (e) {}
        if (i % 4 === 0) console.log(`[${i*5}s] Aguardando Ingress da Akash propagar...`);
        await sleep(5000);
    }

    if (urlFinal) {
        console.log(`🎉 PROXY ONLINE E ESTÁVEL: ${urlFinal}`);
        await publicarNoTextDb(urlFinal);
        console.log(`\n✅ Bot concluido com sucesso.`);
        process.exit(0);
    } else {
        console.log(`⚠️ Ingress não respondeu a tempo. O container continuará rodando. Tente rodar o bot de novo em 5 minutos.`);
        process.exit(0); 
    }
}
runBot();
