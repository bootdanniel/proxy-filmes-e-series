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
            if (r.data && r.data.status === 1) {
                console.log(`✅ URL publicada no textdb`);
                return true;
            }
        } catch (e) {}
        if (t < 3) await sleep(2000);
    }
    return false;
}

async function runBot() {
    console.log('🤖 Iniciando Bot Akash...');
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
    image: ghcr.io/bootdanniel/proxy-filmes-e-series:v1
    expose:
      - port: 3000
        as: 80
        to:
          - global: true
profiles:
  compute:
    proxy:
      resources:
        cpu: { units: 2.0 }
        memory: { size: 4Gi }
        storage: { size: 4Gi }
  placement:
    akash:
      pricing:
        proxy: { denom: uakt, amount: 80000 }
deployment:
  proxy:
    akash: { profile: proxy, count: 1 }
`;

    const provedoresFalhos = new Set();
    let sucesso = false;

    for (let tentativa = 1; tentativa <= 3 && !sucesso; tentativa++) {
        console.log(`\n=== TENTATIVA ${tentativa} DE 3 ===`);

        // AQUI ESTÁ A CORREÇÃO DO SALDO: Escolhe a conta NOVAMENTE a cada tentativa
        let chosenKey = null, maxBalance = 0;
        for (const key of API_KEYS) {
            try {
                const res = await axios.get(`${API_BASE}/balances`, { headers: { 'x-api-key': key } });
                const b = Number(res.data?.data?.balance || 0) / 1000000;
                if (b > maxBalance) { maxBalance = b; chosenKey = key; }
            } catch (e) {}
        }
        
        if (!chosenKey || maxBalance < 0.40) { 
            console.log('❌ Sem saldo líquido. Aguardando escrow...'); 
            await sleep(45000); 
            continue; 
        }
        
        console.log(`💰 Usando conta com ${maxBalance.toFixed(3)} AKT`);
        const headers = { 'x-api-key': chosenKey, 'Content-Type': 'application/json' };

        let createRes;
        try {
            createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl } }, { headers });
        } catch (e) {
            console.log('❌ Erro ao criar deploy:', e.response?.data?.message || e.message);
            await sleep(45000); // Espera se for erro de saldo
            continue;
        }
        
        const dseq = createRes.data?.data?.dseq;
        const manifest = createRes.data?.data?.manifest;
        console.log(`✅ Deploy criado! DSEQ: ${dseq}`);
        if (!dseq || !manifest) { continue; }

        let bids = [];
        for (let i = 0; i < 20; i++) {
            await sleep(3000);
            try {
                const r = await axios.get(`${API_BASE}/bids?dseq=${dseq}`, { headers });
                bids = r.data?.data || [];
                if (bids.length) { console.log(`✅ ${bids.length} bid(s)`); break; }
            } catch (e) {}
        }
        
        if (!bids.length) { 
            await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }).catch(() => {}); 
            await sleep(5000);
            continue; 
        }

        const validBids = bids.map(it => {
            const b = it.bid || it;
            return { provider: b.id?.provider || b.provider, price: b.price };
        }).filter(b => b.provider && b.price?.amount);
        validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));
        const chosenBid = validBids.filter(b => !provedoresFalhos.has(b.provider))[0] || validBids[0];
        
        try {
            await axios.post(`${API_BASE}/leases`, { manifest, leases: [{ dseq, gseq: 1, oseq: 1, provider: chosenBid.provider }] }, { headers });
            console.log(`✅ Lease criado no provedor ${chosenBid.provider.substring(0, 10)}...`);
        } catch (e) {
            console.log('❌ Falha ao criar lease');
            provedoresFalhos.add(chosenBid.provider);
            await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }).catch(() => {});
            await sleep(5000);
            continue;
        }

        let isReady = false, providerUri = null, falha = null;
        for (let i = 0; i < 36; i++) {
            await sleep(5000);
            try {
                const r = await axios.get(`${API_BASE}/deployments/${dseq}`, { headers });
                const lease = (r.data?.data?.leases || [])[0];
                const raw = JSON.stringify(lease?.status || {});
                if (FAIL_RE.test(raw)) { falha = raw.slice(0, 200); break; }
                const svcs = lease?.status?.services || {};
                for (const svc of (Array.isArray(svcs) ? svcs : Object.values(svcs))) {
                    const ready = (Number(svc.ready_replicas) || Number(svc.available) || 0) >= 1;
                    const uris = svc.uris || svc.uri || [];
                    if (ready && uris.length) { isReady = true; providerUri = uris[0]; break; }
                }
                if (isReady) break;
            } catch (e) {}
        }

        if (falha || !isReady) {
            console.log(`❌ Container nao subiu neste provedor.`);
            provedoresFalhos.add(chosenBid.provider);
            await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }).catch(() => {});
            await sleep(5000);
            continue;
        }

        console.log(`✅ Container rodando! URI: ${providerUri}`);
        const baseUrl = providerUri.startsWith('http') ? providerUri : `https://${providerUri}`;
        
        let urlTunel = null;
        for (let i = 0; i < 20 && !urlTunel; i++) {
            try {
                const resp = await axios.get(`${baseUrl}/tunnel-url`, { timeout: 10000, httpsAgent });
                if (resp.data?.url) { urlTunel = resp.data.url; break; }
            } catch (e) {
                // Ingress ainda propagando
            }
            
            // Se estourou as tentativas, puxa o debug
            if (i === 19) {
                try {
                    const dbg = await axios.get(`${baseUrl}/debug-tunnel`, { timeout: 10000, httpsAgent });
                    console.log('🔍 DEBUG TUNEL:', JSON.stringify(dbg.data.ultimasLinhas).slice(0, 1000));
                } catch (e2) { console.log('🔍 /debug-tunnel falhou'); }
            }
            await sleep(5000);
        }

        if (urlTunel) {
            console.log(`🎉 TUNEL: ${urlTunel}`);
            await publicarNoTextDb(urlTunel);
            sucesso = true;
            break;
        }
    }

    if (!sucesso) { console.error('\n❌ Todas as tentativas falharam.'); process.exit(1); }
    console.log('\n✅ Bot concluido com sucesso.');
    process.exit(0);
}
runBot();
