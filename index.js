// index.js - Server Backend (Express, Socket.io, SNMP Trap, MikroTik Auto-Sync & Telegram Webhook)
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
let previousCustomerStatus = new Map();
let isFirstRun = true;

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
                // Abaikan error background
            } finally {
                if (api) await safeCloseMikrotik(api);
            }
            return nodeCustomers;
        }));

        const newCache = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        if (newCache.length > 0) {
            
            newCache.forEach(cust => {
                const uniqueKey = `${cust.node}_${cust.name}`;
                const oldStatus = previousCustomerStatus.get(uniqueKey);

                if (!isFirstRun && oldStatus && oldStatus !== cust.status) {
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
                }
                previousCustomerStatus.set(uniqueKey, cust.status);
            });

            isFirstRun = false;
            globalCustomerCache = newCache;
        }
    } catch (e) {
        console.error("Error update cache:", e);
    } finally {
        isFetchingCache = false;
    }
}

updateCustomerCache();
setInterval(updateCustomerCache, 20000);

app.get('/api/customers', (req, res) => {
    res.json({ success: true, customers: globalCustomerCache });
});

async function getUserSecrets(api) {
    try { return await withTimeout(api.write('/ppp/secret/print'), 10000, 'Timeout Secret'); } catch (e) { return []; }
}
async function getActiveUsers(api) {
    try { return await withTimeout(api.write('/ppp/active/print'), 10000, 'Timeout Active'); } catch (e) { return []; }
}

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
        
        try {
            await scanSemuaOlt(targetServer.olts, mac, async (teksHasil) => { 
                oltText = teksHasil; 
                io.emit('realtime_redaman_result', { username, redamanText: teksHasil });
            });
        } catch (oltErr) {
            console.error(`⚠️ Error saat scan OLT untuk ${username}:`, oltErr.message);
            oltText = `Gagal memindai OLT: ${oltErr.message}`;
        }

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
            try {
                await scanSemuaOlt(targetServer.olts, mac, async (teksHasil) => { oltText = teksHasil; });
            } catch (oltErr) {
                oltText = `Gagal memindai OLT: ${oltErr.message}`;
            }
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

async function sendTelegramAlert(message, replyMarkup = null, chatId = TELEGRAM_CHAT_ID) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('❌ TELEGRAM_BOT_TOKEN belum di-set di Railway Variables.');
        return false;
    }
    if (!chatId) {
        console.error('❌ TELEGRAM_CHAT_ID belum di-set di Railway Variables.');
        return false;
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const bodyData = {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        };

        if (replyMarkup) bodyData.reply_markup = replyMarkup;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });

        const result = await response.json();
        if (!result.ok) {
            console.error('❌ Telegram sendMessage gagal:', result.description);
            return false;
        }
        return true;
    } catch (err) {
        console.error('❌ Gagal mengirim Telegram alert:', err.message);
        return false;
    }
}

// ==========================================
// 🤖 TELEGRAM WEBHOOK + CEK REDAMAN BER-QUEUE
// ==========================================
async function answerTelegramCallback(callbackQueryId, text) {
    if (!TELEGRAM_BOT_TOKEN) return;

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callback_query_id: callbackQueryId,
                text,
                show_alert: false
            })
        });
    } catch (err) {
        console.error('❌ answerCallbackQuery gagal:', err.message);
    }
}

app.post('/api/telegram-webhook', async (req, res) => {
    res.status(200).send('OK');

    try {
        const update = req.body;
        
        // 1. Jika pengguna mengirim pesan teks (misal: /start)
        if (update && update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            console.log(`💬 [TELEGRAM MESSAGE] Pesan dari chat_id ${chatId}: ${text}`);

            if (text === '/start') {
                await sendTelegramAlert(
                    `👋 *Halo! Selamat datang di RnB Network Bot.*\n\n` +
                    `Bot sistem NMS & MikroTik ini siap membantu Anda memantau status pelanggan dan melakukan pengecekan redaman OLT secara real-time.`,
                    null,
                    chatId
                );
            }
            return;
        }

        // 2. Jika pengguna mengklik tombol interaktif
        if (!update || !update.callback_query) return;

        const callbackQuery = update.callback_query;
        const rawData = callbackQuery.data || '';

        console.log(`🔘 [TELEGRAM WEBHOOK] Tombol diklik: ${rawData}`);

        if (!rawData.startsWith('cekredaman_')) return;

        const payload = rawData.substring('cekredaman_'.length);
        const firstUnderscore = payload.indexOf('_');

        if (firstUnderscore <= 0) {
            console.error('❌ Format callback cekredaman tidak valid:', rawData);
            await answerTelegramCallback(callbackQuery.id, 'Format tombol tidak valid.');
            return;
        }

        const nodeLabel = payload.substring(0, firstUnderscore);
        const username = payload.substring(firstUnderscore + 1);
        const chatId = callbackQuery.message?.chat?.id || TELEGRAM_CHAT_ID;

        await answerTelegramCallback(
            callbackQuery.id,
            `Masuk antrean cek redaman ${username}...`
        );

        await jalankanCekRedamanOtomatis(nodeLabel, username, chatId);
    } catch (err) {
        console.error('❌ Error Webhook Telegram:', err);
    }
});
async function jalankanCekRedamanOtomatis(nodeLabel, username, chatId) {
    let serverKey = Object.keys(config.servers).find(
        key => config.servers[key].label.toLowerCase() === nodeLabel.toLowerCase()
    );

    if (!serverKey) {
        serverKey = Object.keys(config.servers)[0];
    }

    const serverLabel = config.servers[serverKey]?.label || nodeLabel;

    console.log(`📥 [TELEGRAM REDAMAN] ${username} masuk antrean (${serverLabel})`);

    const queued = await enqueueTask(async () => {
        let api;

        try {
            console.log(`▶️ [TELEGRAM REDAMAN] ${username} mulai scan`);

            const connected = await connectMikrotik(serverKey);
            api = connected.api;

            const userObj = await getUserFromMikrotik(api, username);

            let rawMac = userObj['caller-id'] || 'Any';
            const activeUser = await getActiveUserFromMikrotik(api, username);

            if (activeUser) {
                rawMac = activeUser['caller-id'] || rawMac;
            }

            if (!rawMac || rawMac === 'Any') {
                throw new Error('MAC Address tidak ditemukan');
            }

            const mac = rawMac.trim().toLowerCase();
            let hasilRedaman = 'ONU tidak ditemukan di OLT manapun';

            try {
                await scanSemuaOlt(
                    connected.targetServer.olts,
                    mac,
                    async (teksHasil) => {
                        hasilRedaman = teksHasil;

                        io.emit('realtime_redaman_result', {
                            username,
                            redamanText: teksHasil
                        });
                    }
                );
            } catch (scanErr) {
                console.error(`⚠️ Error saat proses scan OLT Telegram: ${scanErr.message}`);
                hasilRedaman = `Gagal memindai OLT: ${scanErr.message}`;
            }

            const hasilMsg =
                `📊 *HASIL CEK REDAMAN*\n\n` +
                `👤 *Nama:* ${username}\n` +
                `📍 *Node:* ${nodeLabel}\n` +
                `📶 *Hasil:*\n${hasilRedaman}`;

            await sendTelegramAlert(hasilMsg, null, chatId);

            console.log(`✅ [TELEGRAM REDAMAN] ${username} selesai`);
            return { username, server: serverLabel, mac, olt: hasilRedaman };
        } catch (err) {
            console.error(`❌ [TELEGRAM REDAMAN] ${username}:`, err.message);

            await sendTelegramAlert(
                `❌ *Gagal cek redaman*\n\n` +
                `👤 *Nama:* ${username}\n` +
                `📍 *Node:* ${nodeLabel}\n` +
                `⚠️ ${err.message}`,
                null,
                chatId
            );

            throw err;
        } finally {
            await safeCloseMikrotik(api);
        }
    }, username, serverLabel);

    if (queued.position > 1) {
        await sendTelegramAlert(
            `⏳ *CEK REDAMAN MASUK ANTREAN*\n\n` +
            `👤 *Nama:* ${username}\n` +
            `📍 *Node:* ${nodeLabel}\n` +
            `🔢 *Posisi:* ${queued.position}\n\n` +
            `Mohon tunggu. Setelah orang sebelumnya selesai, giliran Anda otomatis.`,
            null,
            chatId
        );
    } else {
        await sendTelegramAlert(
            `🔎 *CEK REDAMAN DIMULAI*\n\n` +
            `👤 *Nama:* ${username}\n` +
            `📍 *Node:* ${nodeLabel}`,
            null,
            chatId
        );
    }

    console.log(
        `🧾 [TELEGRAM REDAMAN] ${username} queueId=${queued.queueId} posisi=${queued.position}`
    );
}

// ==========================================
// 🌐 SET WEBHOOK TELEGRAM OTOMATIS DI RAILWAY
// ==========================================
async function configureTelegramWebhook() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('⚠️ Telegram webhook dilewati: TELEGRAM_BOT_TOKEN belum ada.');
        return;
    }

    const publicDomain =
        process.env.RAILWAY_PUBLIC_DOMAIN ||
        process.env.PUBLIC_DOMAIN ||
        '';

    const publicUrl =
        process.env.PUBLIC_URL ||
        (publicDomain ? `https://${publicDomain}` : '');

    if (!publicUrl) {
        console.log(
            '⚠️ Telegram webhook belum diset: isi PUBLIC_URL di Railway Variables.'
        );
        return;
    }

    const webhookUrl = `${publicUrl.replace(/\/$/, '')}/api/telegram-webhook`;

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: webhookUrl,
                    allowed_updates: ['callback_query']
                })
            }
        );

        const result = await response.json();

        if (result.ok) {
            console.log(`✅ [TELEGRAM] Webhook aktif: ${webhookUrl}`);
        } else {
            console.error(
                `❌ [TELEGRAM] Gagal set webhook: ${result.description}`
            );
        }
    } catch (err) {
        console.error('❌ [TELEGRAM] Error set webhook:', err.message);
    }
}

configureTelegramWebhook();

process.on('unhandledRejection', err => console.error('❌ UNHANDLED:', err));
process.on('uncaughtException', err => { if (err.name === 'RosException' && err.message.includes('Timed out')) return; console.error('❌ UNCAUGHT:', err); });
