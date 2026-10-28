// oltService.js - Web Dashboard Version (Sequential / Berurutan & Auto-Stop)
const axios = require('axios');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

// ==========================================
// 1. HSAirpo API (Panglejar & Sukamelang)
// ==========================================
async function cekRedamanHSAirpoAPI(oltConfig, mac, control = {}) {
    console.log(`\n🔍 [${oltConfig.label}] Mulai cek (API)...`);
    try {
        const searchMac = mac.substring(0, 16);
        const username = oltConfig.user || 'root';
        const password = oltConfig.pass || 'admin';
        const key = crypto.createHash('md5').update(`${username}:${password}`).digest('hex');
        const value = Buffer.from(password).toString('base64');
        
        const loginRes = await axios.post(
            `http://${oltConfig.ip}:${oltConfig.port}/userlogin?form=login`,
            { method: "set", param: { name: username, key, value, captcha_v: " ", captcha_f: " " } },
            { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-token': 'null' }, timeout: 10000, signal: control.signal }
        );
        if (loginRes.data.code !== 1) throw new Error(`Login gagal: ${loginRes.data.message}`);
        
        const token = loginRes.headers['x-token'];
        const totalPon = oltConfig.total_pon || 16;

        for (let port = 1; port <= totalPon; port++) {
            if (control.cancelled) throw new Error('Scan dibatalkan karena OLT lain sudah menemukan MAC');
            const res = await axios.get(
                `http://${oltConfig.ip}:${oltConfig.port}/onu_allow_list?port_id=${port}`,
                { headers: { 'x-token': token }, timeout: 5000, signal: control.signal }
            );
            
            const onuList = res.data.data || [];
            const found = onuList.find(x => x.macaddr && x.macaddr.toLowerCase().startsWith(searchMac.toLowerCase()));
            
            if (found) {
                console.log(`   ✅ Ditemukan di PON ${port}: ${found.macaddr}`);
                let redaman = found.receive_power || 'N/A';
                if (redaman !== 'N/A' && !String(redaman).includes('dBm')) redaman = `${redaman} dBm`;
                return { olt_name: `${oltConfig.label} (PON ${port})`, mac_onu: found.macaddr, redaman, status: found.status || 'Online' };
            }
        }
        console.log(`   ❌ Tidak ditemukan di semua port`);
        return null;
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        return { error: error.message };
    }
}

// ==========================================
// 2. HSAirpo CIBAROLA (Axios API) - FIXED MAC 12 CHAR
// ==========================================
async function cekRedamanHSAirpoCibarola(oltConfig, mac, control = {}) {
    console.log(`\n🔍 [${oltConfig.label}] Mulai cek (Cibarola API)...`);
    try {
        const cleanTargetMac = mac.replace(/[:.-]/g, '').toLowerCase();
        const matchTarget = cleanTargetMac.substring(0, 11);
        
        const passwordBase64 = Buffer.from(oltConfig.pass || 'admin').toString('base64');
        const loginRes = await axios.post(
            `http://${oltConfig.ip}:${oltConfig.port}/login/Auth`,
            { userName: oltConfig.user || 'admin', password: passwordBase64 },
            { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 10000, signal: control.signal }
        );
        
        if (loginRes.data.errCode !== 'success') throw new Error('Login gagal');
        
        const cookies = loginRes.headers['set-cookie'];
        let sessionCookie = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
        const totalPon = oltConfig.total_pon || 4;
        
        for (let i = 1; i <= totalPon; i++) {
            if (control.cancelled) throw new Error('Scan dibatalkan karena OLT lain sudah menemukan MAC');
            const ponPort = `pon${i}`;
            const opticalRes = await axios.get(
                `http://${oltConfig.ip}:${oltConfig.port}/goform/getPortOnuOptical?${Math.random()}&PonPortName=${ponPort}`,
                { headers: { 'Cookie': sessionCookie, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 15000, signal: control.signal }
            );
            
            let jsonData = opticalRes.data;
            if (typeof jsonData === 'string') {
                try { jsonData = JSON.parse(jsonData); } catch (e) {}
            }
            
            if (jsonData && jsonData.list) {
                const found = jsonData.list.find(onu => {
                    const onuMac = (onu.mac || '').replace(/\./g, '').toLowerCase();
                    return onuMac.startsWith(matchTarget);
                });
                
                if (found) {
                    console.log(`   ✅ Ditemukan di ${ponPort.toUpperCase()}: ${found.mac}`);
                    let redaman = found.rxpower || 'N/A';
                    if (redaman !== 'N/A' && !String(redaman).includes('dBm')) redaman = `${redaman} dBm`;
                    return { olt_name: `${oltConfig.label} (${ponPort.toUpperCase()})`, mac_onu: found.mac, redaman, status: 'Online' };
                }
            }
        }
        console.log(`   ❌ Tidak ditemukan di semua PON`);
        return null;
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        return { error: error.message };
    }
}

// ==========================================
// 3. Hioso (Puppeteer) - FAST MODE DENGAN BLOCKER
// ==========================================
async function cekRedamanHioso(oltConfig, mac, control = {}) {
    let searchMac = mac.substring(0, 16);
    if (oltConfig.label.includes('Cibarola') || oltConfig.label.includes('8Pon')) searchMac = mac.substring(0, 15);
    
    console.log(`\n🔍 [${oltConfig.label}] Mulai cek (Puppeteer Fast Mode)...`);
    console.log(`MAC dicari: ${searchMac} (Panjang: ${searchMac.length})`);
    
    let browser = null;
    control.cancel = async () => {
        control.cancelled = true;
        if (browser) { try { await browser.close(); } catch (e) {} }
    };

    const browserLaunch = puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    browser = await browserLaunch;
    
    try {
        const page = await browser.newPage();
        const ensureActive = () => { if (control.cancelled) throw new Error('Scan dibatalkan karena OLT lain sudah menemukan MAC'); };
        page.setDefaultTimeout(20000); 
        page.setDefaultNavigationTimeout(20000);
        
        // OPTIMASI: Blokir load gambar, CSS, dan font agar loading lebih cepat
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const baseUrl = `http://${oltConfig.ip}:${oltConfig.port}`;
        const user = oltConfig.user || 'admin';
        const pass = oltConfig.pass || 'admin';
        
        ensureActive();
        await page.authenticate({ username: user, password: pass });
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        console.log(`   ✅ HTTP Basic Auth sukses`);
        await new Promise(r => setTimeout(r, 2000));

        // MODE 1: HIOSO CIBAROLA / 8 PON SUKAMELANG (IFRAME)
        if (oltConfig.iframe) {
            console.log(`   Mode: Iframe`);
            let leftFrame = null;
            for (let attempt = 1; attempt <= 15; attempt++) {
                const frames = page.frames();
                leftFrame = frames.find(f => f.name() === 'leftFrame' || f.name() === 'menuFrame' || (f.url() && (f.url().includes('menu') || f.url().includes('left'))));
                if (leftFrame) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!leftFrame) throw new Error('Gagal memuat menu frame');
            
            try {
                await leftFrame.waitForSelector('a', { timeout: 10000 });
                await leftFrame.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const allOnuLink = links.find(link => link.innerText.trim() === 'All ONU' || link.innerText.trim().toLowerCase().includes('all onu'));
                    if (allOnuLink) allOnuLink.click();
                });
            } catch (err) {}
            
            await new Promise(r => setTimeout(r, 2000));
            
            let mainFrame = null;
            for (let attempt = 1; attempt <= 15; attempt++) {
                const frames = page.frames();
                mainFrame = frames.find(f => f.name() === 'mainFrame' || f.name() === 'main' || f.name() === 'content' || (f.url() && f.url().includes('onu')));
                if (mainFrame) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!mainFrame) throw new Error('Gagal memuat main frame');
            
            try { await mainFrame.waitForSelector('table tr', { timeout: 15000 }); } catch (err) {}
            
            try {
                await mainFrame.evaluate(() => {
                    if (typeof setNumPerPage === 'function') setNumPerPage(300);
                    else if (typeof OnPageSizeChange === 'function') OnPageSizeChange(300);
                    else { const sel = document.querySelector('select'); if (sel) { sel.value = sel.options[sel.options.length - 1].value; sel.dispatchEvent(new Event('change')); } }
                });
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {}

            ensureActive();
            const rxPowerResult = await mainFrame.evaluate((macToFind) => {
                const cleanTarget = macToFind.replace(/[:.-]/g, '').toLowerCase();
                const rows = Array.from(document.querySelectorAll('table tr'));
                for (let row of rows) {
                    const cleanRowText = row.innerText.replace(/[:.-]/g, '').toLowerCase();
                    if (cleanRowText.includes(cleanTarget)) {
                        const rowTextClean = row.innerText.replace(/\s+/g, ' ').trim();
                        const rxPattern = /-\d+\.\d+/;
                        const match = rowTextClean.match(rxPattern);
                        return match ? match[0] : null;
                    }
                }
                return null;
            }, searchMac);
            
            if (rxPowerResult) {
                console.log(`   ✅ Ditemukan! Redaman: ${rxPowerResult} dBm`);
                return { olt_name: oltConfig.label, mac_onu: searchMac, redaman: `${rxPowerResult} dBm`, status: 'Online' };
            }
        } 
        // MODE 2: HIOSO PERUM / LAMA SUKAMELANG / BARU 4 PON (DIRECT URL)
        else {
            console.log(`   Mode: Direct URL (Single Login)`);
            if (await page.$('#a')) {
                await page.type('#a', user); await page.type('#b', pass);
                await page.click('input[type="button"]');
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 2000));
            }

            await page.goto(`${baseUrl}/m/onu_all_onu.htm`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await new Promise(r => setTimeout(r, 2000));
            
            let targetFrame = page;
            const frames = page.frames();
            if (frames.length > 1) { targetFrame = frames.find(f => f.url().includes('onu')) || frames[1]; } 
            
            try { await targetFrame.waitForSelector('table tr', { timeout: 15000 }); } catch (err) {}
            
            ensureActive();
            const rxPowerResult = await targetFrame.evaluate((macToFind) => {
                const cleanTarget = macToFind.replace(/[:-]/g, '').toLowerCase();
                const rows = Array.from(document.querySelectorAll('table tr'));
                for (let row of rows) {
                    const rowText = row.innerText.replace(/[:-]/g, '').toLowerCase();
                    if (rowText.includes(cleanTarget)) {
                        const cleanRowText = row.innerText.replace(/\s+/g, ' ').trim();
                        const rxPattern = /\s(-\d+\.\d+)\s/;
                        const match = cleanRowText.match(rxPattern);
                        if (match) return match[1];
                    }
                }
                return null;
            }, searchMac);
            
            if (rxPowerResult) {
                console.log(`   ✅ Ditemukan! Redaman: ${rxPowerResult} dBm`);
                return { olt_name: oltConfig.label, mac_onu: searchMac, redaman: `${rxPowerResult} dBm`, status: 'Online' };
            }
        }
        
        console.log(`   ❌ Tidak ditemukan di tabel`);
        return null;
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        return { error: error.message };
    } finally {
        await browser.close();
    }
}

// ==========================================
// 4. RETRY WRAPPER
// ==========================================
const MAX_RETRY_PER_OLT = 2;
const RETRY_DELAY_MS = 1500;

async function cekDenganRetry(checkerFn, oltConfig, mac, control = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRY_PER_OLT + 1; attempt++) {
        if (control.cancelled) return null;
        const hasil = await checkerFn(oltConfig, mac, control);
        if (hasil === null) return null; 
        if (!hasil.error) return hasil;
        
        lastError = hasil.error;
        if (control.cancelled) return null;
        if (attempt <= MAX_RETRY_PER_OLT) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
    }
    return null;
}

// ==========================================
// 5. SCAN SEMUA OLT (SEQUENTIAL / BERURUTAN - AUTO STOP)
// ==========================================
async function scanSemuaOlt(oltList, mac, onFound) {
    console.log(`\n========================================`);
    console.log(`🚀 MULAI SCAN ${oltList.length} OLT...`);
    console.log(`========================================`);

    // CIBAROLA & SUKAMELANG: semua OLT dijalankan BERSAMAAN.
    // Begitu salah satu OLT menemukan redaman, hasil LANGSUNG dikirim
    // tanpa menunggu OLT lain selesai. Scan OLT lain dibatalkan.
    const fastParallelServer = oltList.some(olt =>
        String(olt.label || '').toLowerCase().includes('cibarola')
    ) || oltList.some(olt =>
        String(olt.label || '').toLowerCase().includes('sukamelang')
    );

    if (fastParallelServer && oltList.length >= 2) {
        const modeName = oltList.some(olt => String(olt.label || '').toLowerCase().includes('cibarola'))
            ? 'Cibarola'
            : 'Sukamelang';
        console.log(`⚡ Mode ${modeName}: scan paralel + AUTO CANCEL saat ketemu`);

        const controls = new Map();
        let winner = false;
        let remaining = oltList.length;

        await new Promise((resolve) => {
            const finishIfNeeded = () => {
                remaining--;
                if (remaining <= 0 || winner) resolve();
            };

            oltList.forEach((olt) => {
                const control = { cancelled: false, cancel: null };
                controls.set(olt, control);

                (async () => {
                    console.log(`\n➡️ Memulai Target: ${olt.label}`);
                    try {
                        let checkerFn;
                        if (olt.type === 'HSAirpo') {
                            checkerFn = olt.method === 'cibarola'
                                ? cekRedamanHSAirpoCibarola
                                : cekRedamanHSAirpoAPI;
                        } else if (olt.type === 'Hioso') {
                            checkerFn = cekRedamanHioso;
                        } else {
                            console.log(`   ⚠️ Tipe OLT tidak dikenal: ${olt.type}`);
                            finishIfNeeded();
                            return;
                        }

                        const hasil = await cekDenganRetry(checkerFn, olt, mac, control);

                        if (hasil && !hasil.error && !control.cancelled && !winner) {
                            winner = true;
                            console.log(`\n✅ KETEMU di ${hasil.olt_name}!`);
                            console.log(`   📉 Redaman: ${hasil.redaman}`);

                            // KIRIM SECEPATNYA. Jangan tunggu OLT lain.
                            const teksHasil = `\n✅ *${hasil.olt_name}*\n   📉 Redaman: *${hasil.redaman}*\n   📡 Status: ${hasil.status}`;
                            try {
                                await onFound(teksHasil);
                            } catch (err) {
                                console.error(`   ❌ Gagal mengirim hasil: ${err.message}`);
                            }

                            // Setelah hasil terkirim, batalkan semua OLT lain.
                            for (const [otherOlt, otherControl] of controls.entries()) {
                                if (otherOlt !== olt && !otherControl.cancelled) {
                                    otherControl.cancelled = true;
                                    console.log(`🛑 Membatalkan scan: ${otherOlt.label}`);
                                    if (typeof otherControl.cancel === 'function') {
                                        try { await otherControl.cancel(); } catch (e) {}
                                    }
                                }
                            }
                            resolve();
                            return;
                        }
                    } catch (err) {
                        if (!control.cancelled) {
                            console.error(`   ❌ [${olt.label}] Error sistem: ${err.message}`);
                        }
                    } finally {
                        finishIfNeeded();
                    }
                })();
            });
        });

        console.log(winner
            ? `\n✅ ${modeName} selesai: hasil sudah dikirim, OLT lain dibatalkan.`
            : `\n❌ Tidak ketemu di OLT manapun.`
        );
        console.log(`========================================\n`);
        return winner;
    }

    // SERVER LAIN: tetap sequential seperti perilaku sebelumnya.
    console.log(`🔄 Mode Sequential: scan OLT satu per satu`);

    let foundResult = null;

    for (const olt of oltList) {
        console.log(`\n➡️ Memeriksa Target: ${olt.label}`);

        try {
            let hasil = null;

            if (olt.type === 'HSAirpo') {
                hasil = olt.method === 'cibarola'
                    ? await cekDenganRetry(cekRedamanHSAirpoCibarola, olt, mac)
                    : await cekDenganRetry(cekRedamanHSAirpoAPI, olt, mac);
            } else if (olt.type === 'Hioso') {
                hasil = await cekDenganRetry(cekRedamanHioso, olt, mac);
            }

            if (hasil && !hasil.error) {
                foundResult = hasil;

                console.log(`\n✅ KETEMU di ${hasil.olt_name}!`);
                console.log(`   📉 Redaman: ${hasil.redaman}`);

                const teksHasil = `\n✅ *${hasil.olt_name}*\n   📉 Redaman: *${hasil.redaman}*\n   📡 Status: ${hasil.status}`;
                await onFound(teksHasil);

                // Server selain Cibarola tetap auto-stop.
                break;
            }
        } catch (err) {
            console.error(`   ❌ [${olt.label}] Error sistem: ${err.message}`);
        }
    }

    if (!foundResult) {
        console.log(`\n❌ Tidak ketemu di OLT manapun.`);
        console.log(`========================================\n`);
        return false;
    }

    console.log(`========================================\n`);
    return true;
}

module.exports = { scanSemuaOlt };
