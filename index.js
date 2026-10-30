// index.js - Server Backend (Express, Socket.io, SNMP Trap, MikroTik Auto-Sync & Telegram Interactive)
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
        time: new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })
    });
});

try {
    trapReceiver.bind(162);
} catch (err) {
    console.log(`⚠️ Gagal bind port 162 UDP:`, err.message);
}

// ==========================================
// 🔄 SISTEM CACHE & BACKGROUND SYNC PELANGGAN
// ==========================================
let globalCustomerCache = [];
let isFetchingCache = false;
let previousCustomerStatus = new Map(); // Penyimpan status untuk deteksi Telegram real-time

async function updateCustomerCache() {
    if (isFetchingCache) return;
    isFetchingCache = true;
    try {
        const serverKeys = Object.keys(config.servers);
        
        const results = await Promise.allSettled(serverKeys.map(async (srvKey) => {
            let nodeCustomers = [];
            let api;
            try {
                const { api: mikrotikApi, targetServer } = await connectMikrotik(srvKey);
                api = mikrotikApi;
                
                const [secrets, activeUsers] = await Promise.all([
                    getUserSecrets(api),
                    getActiveUsers(api)
                ]);

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
                // Abaikan error di background
            } finally {
                if (api) await safeCloseMikrotik(api);
            }
            return nodeCustomers;
        }));

        const newCache = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        if (newCache.length > 0) {
            
            // Map untuk mencatat waktu terakhir pelanggan dikirimi notif (Mencegah double/spam)
            if (!windowLastAlertTime) windowLastAlertTime = new Map();

            newCache.forEach(cust => {
                const uniqueKey = `${cust.node}_${cust.name}`;
                const oldStatus = previousCustomerStatus.get(uniqueKey);

                if (oldStatus && oldStatus !== cust.status) {
                    const nowTime = Date.now();
                    const lastAlert = windowLastAlertTime.get(uniqueKey) || 0;

                    // SYARAT: Kirim notif hanya jika status berubah DAN sudah lewat 60 detik dari notif terakhir pelanggan ini
                    if (nowTime - lastAlert > 60000) {
                        let icon = cust.status === 'ONLINE' ? '🟢' : '🔴';
                        let ket = cust.status === 'ONLINE' ? 'Koneksi Kembali Normal (ONLINE)' : 'Putus Koneksi / Offline (LOS)';
                        
                        let msg = `${icon} *STATUS PELANGGAN BERUBAH*\n\n` +
                                  `👤 *Nama:* ${cust.name}\n` +
                                  `📍 *Node:* ${cust.node}\n` +
                                  `📌 *Status:* ${ket}\n` +
                                  `⏱️ *Waktu:* ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`;

                        let replyMarkup = null;
                        if (cust.status === 'ONLINE') {
                            replyMarkup = {
                                inline_keyboard: [
                                    [
                                        {
                                            text: "📡 Cek Redaman OLT",
                                            callback_data: `cekredaman_${cust.node}_${cust.name}`
                                        }
                                    ]
                                ]
                            };
                        }

                        sendTelegramAlert(msg, replyMarkup);
                        windowLastAlertTime.set(uniqueKey, nowTime); // Catat waktu pengiriman
                    }
                }
                previousCustomerStatus.set(uniqueKey, cust.status);
            });

            globalCustomerCache = newCache;
        }
    } catch (e) {
        console.error("Error update cache:", e);
    } finally {
        isFetchingCache = false;
    }
}

// 1. Jalankan sync saat aplikasi pertama kali menyala
updateCustomerCache();

// 2. Lakukan update data di belakang layar setiap 20 detik
setInterval(updateCustomerCache, 20000);

// ==========================================
// 🔄 API GET CUSTOMERS (INSTAN)
// ==========================================
app.get('/api/customers', (req, res) => {
    res.json({ success: true, customers: globalCustomerCache });
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
        timeout: 5
    });
    try {
        await withTimeout(api.connect(), 5000, `Timeout koneksi ke MikroTik ${targetServer.label}.`);
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
    const position = requestQueue.length + 1;
    
    requestQueue.push({ execute: taskFn, username, server: serverLabel, queueId });
    queueResults.set(queueId, { status: 'pending', position });
    
    if (!isProcessingQueue) {
        isProcessingQueue = true;
        setTimeout(processNextInQueue, 0);
    }
    
    return { queued: true, position, queueId, estimatedWait: position * 90 };
}

async function processNextInQueue() {
    if (requestQueue.length > 0) {
        const next = requestQueue.shift();
        currentTask = { username: next.username, server: next.server };
        
        queueResults.set(next.queueId, { status: 'processing' });
        
        requestQueue.forEach((task, index) => {
            const res = queueResults.get(task.queueId);
            if (res && res.status === 'pending') res.position = index + 1;
        });

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

app.get('/api/queue-result/:queueId', (req, res) => {
    const { queueId } = req.params;
    const result = queueResults.get(queueId);
    
    if (!result) return res.json({ status: 'not_found' });
    if (result.status === 'pending') return res.json({ status: 'pending', position: result.position });
    if (result.status === 'processing') return res.json({ status: 'processing' });
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
        await scanSemuaOlt(targetServer.olts, mac, async (teksHasil) => { 
            oltText = teksHasil; 
            io.emit('realtime_redaman_result', { username, redamanText: teksHasil });
        });
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

app.post('/api/reboot-ont', async (req, res) => {
    const { serverKey, username, mac } = req.body;
    if (!serverKey || !username) return res.status(400).json({ error: 'Server dan username wajib diisi' });

    let api;
    const result = await enqueueTask(async () => {
        const { api: mikrotikApi, targetServer } = await connectMikrotik(serverKey);
        api = mikrotikApi;

        const activeUser = await getActiveUserFromMikrotik(api, username);
        if (activeUser && activeUser['.id']) {
            await api.write(['/ppp/active/remove', `=.id=${activeUser['.id']}`]);
        }

        return { 
            username, 
            server: targetServer.label, 
            mac: mac || 'Unknown', 
            status: 'BERHASIL', 
            message: `Session PPPoE ${username} berhasil di-reset / disconnect.` 
        };
    }, username, config.servers[serverKey]?.label || 'Unknown');
    
    await safeCloseMikrotik(api);
    res.json(result);
});

// ==========================================
// 📱 KONFIGURASI TELEGRAM BOT & NOTIFIKASI
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8588037946:AAFNGG91vPYphabCGZQ2UUpv2JDeAlcnnN4';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7917320065';

async function sendTelegramAlert(message, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('MASUKKAN')) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const bodyData = {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        };

        if (replyMarkup) {
            bodyData.reply_markup = replyMarkup;
        }

        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
    } catch (err) {
        console.error("Gagal mengirim Telegram alert:", err);
    }
}

// ==========================================
// 🤖 TELEGRAM BOT BUTTON CLICK LISTENER (POLLING)
// ==========================================
let telegramOffset = 0;

async function pollTelegramUpdates() {
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('MASUKKAN')) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=30`);
        const data = await res.json();
        
        if (data.ok && data.result) {
            for (const update of data.result) {
                telegramOffset = update.update_id + 1;

                if (update.callback_query) {
                    const callbackQuery = update.callback_query;
                    const dataParts = callbackQuery.data.split('_'); 
                    
                    if (dataParts[0] === 'cekredaman') {
                        const nodeLabel = dataParts[1];
                        const username = dataParts.slice(2).join('_'); 

                        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                callback_query_id: callbackQuery.id,
                                text: `Memindai redaman untuk ${username}...`,
                                show_alert: false
                            })
                        });

                        jalankanCekRedamanOtomatis(nodeLabel, username);
                    }
                }
            }
        }
    } catch (err) {
        // Abaikan error polling sementara
    }
    setTimeout(pollTelegramUpdates, 1000);
}

if (TELEGRAM_BOT_TOKEN && !TELEGRAM_BOT_TOKEN.includes('MASUKKAN')) {
    pollTelegramUpdates();
}

async function jalankanCekRedamanOtomatis(nodeLabel, username) {
    try {
        let serverKey = nodeLabel;
        const foundKey = Object.keys(config.servers).find(
            key => config.servers[key].label.toLowerCase() === nodeLabel.toLowerCase()
        );
        if (foundKey) serverKey = foundKey;

        const { api, targetServer } = await connectMikrotik(serverKey);
        const userObj = await getUserFromMikrotik(api, username);
        let rawMac = userObj['caller-id'] || 'Any';
        const activeUser = await getActiveUserFromMikrotik(api, username);
        if (activeUser) rawMac = activeUser['caller-id'] || rawMac;
        await safeCloseMikrotik(api);

        if (!rawMac || rawMac === 'Any') {
            sendTelegramAlert(`❌ Gagal cek redaman *${username}*: MAC Address tidak ditemukan.`);
            return;
        }

        const mac = rawMac.trim().toLowerCase();
        let hasilRedaman = 'ONU tidak ditemukan di OLT manapun';

        await scanSemuaOlt(targetServer.olts, mac, async (teksHasil) => {
            hasilRedaman = teksHasil;
        });

        let hasilMsg = `📊 *HASIL CEK REDAMAN*\n\n` +
                       `👤 *Nama:* ${username}\n` +
                       `📍 *Node:* ${nodeLabel}\n\n` +
                       `${hasilRedaman}`;
        
        sendTelegramAlert(hasilMsg);

    } catch (err) {
        sendTelegramAlert(`❌ Gagal memproses cek redaman untuk *${username}*: ${err.message}`);
    }
}

process.on('unhandledRejection', err => console.error('❌ UNHANDLED:', err));
process.on('uncaughtException', err => { if (err.name === 'RosException' && err.message.includes('Timed out')) return; console.error('❌ UNCAUGHT:', err); });
