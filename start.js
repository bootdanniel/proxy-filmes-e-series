import './server.js';
import { setTunnelUrl, logTunnel } from './server.js';
import { spawn } from 'child_process';

console.log("Iniciando Cloudflare Tunnel...");
const tunnel = spawn('cloudflared', [
    'tunnel', '--no-autoupdate', '--protocol', 'http2',
    '--edge-ip-version', '4',
    '--ha-connections', '3',   // TESTE 3: Múltiplas conexões para evitar queda por flap
    '--url', 'http://localhost:3000', '--metrics', '127.0.0.1:20241'
]);

tunnel.on('error', (err) => { console.error('[tunnel] FALHA:', err.message); logTunnel(`ERRO_SPAWN: ${err.message}`); });
tunnel.on('exit', (code, sig) => { console.error(`[tunnel] cloudflared saiu code=${code} sig=${sig}`); logTunnel(`EXIT code=${code} sig=${sig}`); });

let urlEncontrada = false;
function capturar(s) {
    if (!urlEncontrada) {
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) { setTunnelUrl(m[0]); urlEncontrada = true; console.log(`[TUNEL ATIVO] ${m[0]}`); }
    }
}

tunnel.stdout.on('data', d => { const s = String(d); console.log(`[tunnel]: ${s.trim()}`); logTunnel(s); capturar(s); });
tunnel.stderr.on('data', d => { const s = String(d); console.error(`[tunnel]: ${s.trim()}`); logTunnel(s); capturar(s); });
