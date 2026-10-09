// index.js - Server Backend (Express, Socket.io, SNMP Trap, MikroTik Auto-Sync)
const path = require('path');
const express = require('express');
const http = require('http');
const dgram = require('dgram');
const { Server } = require('socket.io');
const RouterOSAPI = require('node-routeros').RouterOSAPI;
const config = require('./config');
const { scanSemuaOlt } = require('./oltService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Route Website
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/nms', (req, res) => res.sendFile(path.join(__dirname, 'nms.html')));

// Receiver SNMP Trap UDP Port 162
const trapReceiver = dgram.createSocket('udp4');

trapReceiver.on('listening', () => {
    console.log(`📡 [NMS TRAP] Receiver SNMP aktif di Port UDP 162`);
});

trapReceiver.on('message', (msg, rinfo) => {
    const rawText = msg.toString('utf-8');
    const rawHex = msg.toString('hex');
    const oltIp = rinfo.address;

    let oltName = `OLT (${oltIp})`;
    Object.values(config.servers).forEach(srv => {
        srv.olts.forEach(olt => {
            if (olt.ip === oltIp) oltName = `${olt.label} [${srv.label}]`;
        });
    });

    let type = 'UNKNOWN';
    let message = 'Status OLT Berubah';

    if (rawText.toLowerCase().includes('dying') || rawText.toLowerCase().includes('gasp') || rawHex.includes('06082b06010401')) {
        type = 'DYING_GASP';
        message = '⚡ MATI LISTRIK (Dying Gasp)';
    } else if (rawText.toLowerCase().includes('laser') || rawText.toLowerCase().includes('los') || rawText.toLowerCase().includes('offline') || rawText.toLowerCase().includes('linkdown')) {
        type = 'LOS';
        message = '🚨 LOSE KONEKSI (Laser Out / LOS)';
    } else if (rawText.toLowerCase().includes('linkup') || rawText.toLowerCase().includes('online')) {
        type = 'ONLINE';
        message = '✅ RECOVERY / ONLINE';
    }

    console.log(`⚠️ [TRAP RECEIVED] ${oltName} -> ${message}`);

    io.emit('nms_olt_event', {
        oltIp,
        oltName,
        type,
        message,
        time: new Date().toLocaleTimeString('id-ID')
    });
});

try {
    trapReceiver.bind(162);
} catch (err) {
    console.log(`⚠️ Gagal bind port 162 UDP:`, err.message);
}

// ==========================================
// 🔄 API AUTO-SYNC PELANGGAN DARI MIKROTIK (PARALEL)
// ==========================================
app.get('/api/customers', async (req, res) => {
    try {
        const serverKeys = Object.keys(config.servers);
        
        // Jalankan query ke semua MikroTik secara BERSAMAAN
        const results = await Promise.allSettled(serverKeys.map(async (srvKey) => {
            let nodeCustomers = [];
            let api;
            try {
                const { api: mikrotikApi, targetServer } = await connectMikrotik(srvKey);
                api = mikrotikApi;
                
                // Ambil secret dan user aktif
                const secrets = await getUserSecrets(api);
                const activeUsers = await getActiveUsers(api);

                secrets.forEach(sec => {
                    if (sec.name) {
                        const act = activeUsers.find(a => a.name && a.name.toLowerCase() === sec.name.toLowerCase());
                        nodeCustomers.push({
                            name: sec.name,
                            node: `${targetServer.label}`,
                            status: act ? 'ONLINE' : 'OFFLINE',
                            mac: act ? (act['caller-id'] || sec['caller-id'] || '-') : (sec['caller-id'] || '-'),
                            ip: act ? act.address : (sec['remote-address'] || 'Dynamic')
                        });
                    }
                });
            } catch (err) {
                console.log(`⚠️ Gagal sync dari MikroTik ${srvKey}:`, err.message);
            } finally {
                // Pastikan koneksi selalu ditutup
                if (api) await safeCloseMikrotik(api);
            }
            return nodeCustomers;
        }));

        // Gabungkan hasil dari semua server yang sukses merespon
        const allCustomers = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        res.json({ success: true, customers: allCustomers });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
async function getUserSecrets(api) {
    try { return await withTimeout(api.write('/ppp/secret/print'), 10000, 'Timeout Secret'); } catch (e) { return []; }
}
async function getActiveUsers(api) {
    try { return await withTimeout(api.write('/ppp/active/print'), 10000, 'Timeout Active'); } catch (e) { return []; }
}

// ==========================================
// 🔄 API GET OLT & PON PORT BERDASARKAN SERVER
// ==========================================
app.get('/api/server-olt/:serverLabel', (req, res) => {
    const serverLabel = req.params.serverLabel.toLowerCase();
    let foundServerKey = Object.keys(config.servers).find(
        key => config.servers[key].label.toLowerCase() === serverLabel
    );
    
    if (!foundServerKey) {
        return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }
    
    res.json({ 
        success: true, 
        serverKey: foundServerKey,
        serverLabel: config.servers[foundServerKey].label, 
        olts: config.servers[foundServerKey].olts || [] 
    });
});

// ==========================================
// 🔄 API SCAN MAC ADDRESS DI PON SPESIFIK (CARA 2)
// ==========================================
app.post('/api/scan-pon', async (req, res) => {
    const { serverKey, oltIp, pon } = req.body;
    if (!serverKey || !oltIp || !pon) return res.status(400).json({ error: 'Parameter tidak lengkap' });

    const targetServer = config.servers[serverKey];
    if (!targetServer) return res.status(404).json({ error: 'Server tidak ditemukan' });

    const result = await enqueueTask(async () => {
        console.log(`[SCAN PON] Membaca ONU di OLT ${oltIp} PON ${pon}...`);
        
        let foundMacs = [];
        
        // Cari objek OLT yang sesuai dengan IP di server tersebut
        const targetOlt = targetServer.olts.find(o => o.ip === oltIp);
        if (!targetOlt) throw new Error('Konfigurasi OLT tidak ditemukan');

        // Panggil fungsi scan dari oltService untuk mengambil MAC list pada PON tersebut
        // (Pastikan fungsi ini mengambil MAC dari OLT berdasarkan nomor PON)
        await scanSemuaOlt([targetOlt], null, async (teksHasil, macList) => {
            if (macList && Array.isArray(macList)) {
                foundMacs = macList;
            }
        }, pon); // Kirim parameter PON jika didukung oltService

        return { serverKey, oltIp, pon, macs: foundMacs };
    }, 'SYSTEM_SCAN', targetServer.label);
    
    res.json(result);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🌐 WEB DASHBOARD RUNNING ON PORT ${PORT}`));

function withTimeout(promise, ms, errMsg) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errMsg)), ms);
    });
    return Promise.race([promise.finally(() => clearTimeout(timeoutId)), timeoutPromise]);
}

async function connectMikrotik(serverKey) {
    const targetServer = config.servers[serverKey];
    if (!targetServer) throw new Error(`Server "${serverKey}" tidak ditemukan`);
    const api = new RouterOSAPI({
        host: targetServer.mikrotik.host,
        port: targetServer.mikrotik.port,
        user: targetServer.mikrotik.user,
        password: targetServer.mikrotik.pass,
        timeout: 15
    });
    try {
        await withTimeout(api.connect(), 15000, `Timeout koneksi ke MikroTik ${targetServer.label}.`);
        return { api, targetServer };
    } catch (err) {
        safeCloseMikrotik(api).catch(() => {});
        throw new Error(`Gagal konek MikroTik ${targetServer.label}.`);
    }
}

async function getUserFromMikrotik(api, username) {
    let secrets = await withTimeout(api.write('/ppp/secret/print', [`?name=${username}`]), 25000, 'Timeout Query Secret.');
    let userObj = secrets.find(x => x.name && x.name.trim().toLowerCase() === username.trim().toLowerCase());
    if (userObj) return userObj;
    secrets = await withTimeout(api.write('/ppp/secret/print'), 25000, 'Timeout Query Secret Full Scan.');
    userObj = secrets.find(x => x.name && x.name.trim().toLowerCase() === username.trim().toLowerCase());
    if (!userObj) throw new Error(`User "${username}" tidak ditemukan`);
    return userObj;
}

async function getActiveUserFromMikrotik(api, username) {
    let activeUsers = await withTimeout(api.write('/ppp/active/print', [`?name=${username}`]), 25000, 'Timeout Query Active.');
    let found = activeUsers.find(x => x.name && x.name.trim().toLowerCase() === username.trim().toLowerCase());
    if (found) return found;
    activeUsers = await withTimeout(api.write('/ppp/active/print'), 25000, 'Timeout Query Active Full Scan.');
    return activeUsers.find(x => x.name && x.name.trim().toLowerCase() === username.trim().toLowerCase());
}

async function safeCloseMikrotik(api) {
    if (!api) return;
    try { await withTimeout(api.close(), 5000, 'Close timeout'); } catch (e) {}
}

const requestQueue = [];
let isProcessingQueue = false;
let currentTask = null;
const queueResults = new Map();

async function enqueueTask(taskFn, username, serverLabel) {
    const queueId = Date.now() + Math.random().toString(36).substr(2, 9);
    if (isProcessingQueue) {
        const position = requestQueue.length + 1;
        requestQueue.push({ execute: taskFn, username, server: serverLabel, queueId });
        queueResults.set(queueId, { status: 'pending', position });
        return { queued: true, position, queueId, estimatedWait: position * 90 };
    } else {
        isProcessingQueue = true;
        currentTask = { username, server: serverLabel };
        try {
            const result = await taskFn();
            queueResults.set(queueId, { status: 'done', data: result });
            return { success: true, data: result, queueId };
        } catch (err) {
            queueResults.set(queueId, { status: 'error', error: err.message });
            return { success: false, error: err.message, queueId };
        } finally {
            currentTask = null;
            processNextInQueue();
        }
    }
}

async function processNextInQueue() {
    if (requestQueue.length > 0) {
        const next = requestQueue.shift();
        currentTask = { username: next.username, server: next.server };
        try {
            const result = await next.execute();
            queueResults.set(next.queueId, { status: 'done', data: result });
        } catch (err) {
            queueResults.set(next.queueId, { status: 'error', error: err.message });
        } finally {
            currentTask = null;
            processNextInQueue();
        }
    } else {
        isProcessingQueue = false;
    }
}

app.get('/api/servers', (req, res) => {
    const servers = Object.keys(config.servers).map(key => ({ key, label: config.servers[key].label }));
    res.json({ servers });
});

app.get('/api/queue-result/:queueId', (req, res) => {
    const { queueId } = req.params;
    const result = queueResults.get(queueId);
    if (!result) return res.json({ status: 'not_found' });
    if (result.status === 'pending') return res.json({ status: 'pending', position: result.position });
    if (result.status === 'done') { queueResults.delete(queueId); return res.json({ status: 'done', success: true, data: result.data }); }
    if (result.status === 'error') { queueResults.delete(queueId); return res.json({ status: 'error', success: false, error: result.error }); }
});

app.post('/api/cek-redaman', async (req, res) => {
    const { serverKey, username } = req.body;
    if (!serverKey || !username) return res.status(400).json({ error: 'Server dan username wajib diisi' });
    let api;
    const result = await enqueueTask(async () => {
        const { api: mikrotikApi, targetServer } = await connectMikrotik(serverKey);
        api = mikrotikApi;
        const userObj = await getUserFromMikrotik(api, username);
        let rawMac = userObj['caller-id'] || 'Any';
        const activeUser = await getActiveUserFromMikrotik(api, username);
        if (activeUser) rawMac = activeUser['caller-id'] || rawMac;
        if (!rawMac || rawMac === 'Any') throw new Error('MAC Address tidak terbaca');
        const mac = rawMac.trim().toLowerCase();
        let oltText = 'ONU tidak ditemukan di OLT manapun';
        await scanSemuaOlt(targetServer.olts, mac, async (teksHasil) => { oltText = teksHasil; });
        return { username, server: targetServer.label, mac, olt: oltText };
    }, username, config.servers[serverKey]?.label || 'Unknown');
    
    await safeCloseMikrotik(api);
    res.json(result);
});

app.post('/api/aktivasi', async (req, res) => {
    const { serverKey, username } = req.body;
    if (!serverKey || !username) return res.status(400).json({ error: 'Server dan username wajib diisi' });
    let api;
    const result = await enqueueTask(async () => {
        const { api: mikrotikApi, targetServer } = await connectMikrotik(serverKey);
        api = mikrotikApi;
        const userObj = await getUserFromMikrotik(api, username);
        if (userObj.disabled === 'true') {
            await api.write(['/ppp/secret/enable', `=.id=${userObj['.id']}`]);
            await new Promise(r => setTimeout(r, 1000));
            await api.write(['/ppp/secret/set', `=.id=${userObj['.id']}`, '=disabled=no']);
            await new Promise(r => setTimeout(r, 3000));
        }

        const activeUser = await getActiveUserFromMikrotik(api, username);
        let ip = userObj['remote-address'] || 'Dynamic';
        let rawMac = userObj['caller-id'] || 'Any';
        const paket = userObj.profile || 'default';
        if (activeUser) { ip = activeUser.address || ip; rawMac = activeUser['caller-id'] || rawMac; }
        
        const response = { username, server: targetServer.label, paket, ip, mac: rawMac, status: 'BERHASIL', olt: null };
        if (rawMac && rawMac !== 'Any') {
            const mac = rawMac.trim().toLowerCase(); 
            response.mac = mac;
            let oltText = 'ONU tidak ditemukan di OLT manapun';
            await scanSemuaOlt(targetServer.olts, mac, async (teksHasil) => { oltText = teksHasil; });
            response.olt = oltText;
        }
        return response;
    }, username, config.servers[serverKey]?.label || 'Unknown');
    
    await safeCloseMikrotik(api);
    res.json(result);
});

process.on('unhandledRejection', err => console.error('❌ UNHANDLED:', err));
process.on('uncaughtException', err => { if (err.name === 'RosException' && err.message.includes('Timed out')) return; console.error('❌ UNCAUGHT:', err); });
