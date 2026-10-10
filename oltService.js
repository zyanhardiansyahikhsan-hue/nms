// oltService.js - Web Dashboard Version (ULTIMATE TURBO - STAGGERED PARALLEL)
const axios = require('axios');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

// ==========================================
// 1. HSAirpo API (Panglejar & Sukamelang)
// ==========================================
async function cekRedamanHSAirpoAPI(oltConfig, mac) {
    console.log(`\n🔍 [${oltConfig.label}] Mulai cek (API)...`);
    try {
        const searchMac = mac.substring(0, 15);
        const username = oltConfig.user || 'root';
        const password = oltConfig.pass || 'admin';
        const key = crypto.createHash('md5').update(`${username}:${password}`).digest('hex');
        const value = Buffer.from(password).toString('base64');
        const loginRes = await axios.post(
            `http://${oltConfig.ip}:${oltConfig.port}/userlogin?form=login`,
            { method: "set", param: { name: username, key, value, captcha_v: " ", captcha_f: " " } },
            { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-token': 'null' }, timeout: 8000 }
        );
        if (loginRes.data.code !== 1) throw new Error(`Login gagal: ${loginRes.data.message}`);
        const token = loginRes.headers['x-token'];
        for (let port = 1; port <= 16; port++) {
            const res = await axios.get(
                `http://${oltConfig.ip}:${oltConfig.port}/onu_allow_list?port_id=${port}`,
                { headers: { 'x-token': token }, timeout: 5000 }
            );
            const onuList = res.data.data || [];
            const found = onuList.find(x => x.macaddr && x.macaddr.toLowerCase().startsWith(searchMac.toLowerCase()));
            if (found) {
                console.log(`   ✅ Ditemukan di PON ${port}`);
                let redaman = found.receive_power || 'N/A';
                if (redaman !== 'N/A' && !String(redaman).includes('dBm')) redaman = `${redaman} dBm`;
                return { olt_name: `${oltConfig.label} (PON ${port})`, mac_onu: found.macaddr, redaman, status: found.status || 'Online' };
            }
        }
        return null;
    } catch (error) {
        return { error: error.message };
    }
}

// ==========================================
// 2. HSAirpo CIBAROLA (Axios API)
// ==========================================
async function cekRedamanHSAirpoCibarola(oltConfig, mac) {
    console.log(`\n🔍 [${oltConfig.label}] Mulai cek (Cibarola API)...`);
    try {
        const cleanTargetMac = mac.replace(/[:.-]/g, '').toLowerCase();
        const matchTarget = cleanTargetMac.substring(0, 10);
        const passwordBase64 = Buffer.from(oltConfig.pass || 'admin').toString('base64');
        
        const loginRes = await axios.post(
            `http://${oltConfig.ip}:${oltConfig.port}/login/Auth`,
            { userName: oltConfig.user || 'admin', password: passwordBase64 },
            { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 8000 }
        );
        
        if (loginRes.data.errCode !== 'success') throw new Error('Login gagal');
        
        const cookies = loginRes.headers['set-cookie'];
        let sessionCookie = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
        
        const totalPon = oltConfig.total_pon || 4;
        for (let i = 1; i <= totalPon; i++) {
            const ponPort = `pon${i}`;
            const opticalRes = await axios.get(
                `http://${oltConfig.ip}:${oltConfig.port}/goform/getPortOnuOptical?${Math.random()}&PonPortName=${ponPort}`,
                { headers: { 'Cookie': sessionCookie, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 10000 }
            );
            
            let jsonData = opticalRes.data;
            if (typeof jsonData === 'string') { try { jsonData = JSON.parse(jsonData); } catch (e) {} }
            
            if (jsonData && jsonData.list) {
                const found = jsonData.list.find(onu => {
                    const onuMac = (onu.mac || '').replace(/\./g, '').toLowerCase();
                    return onuMac.startsWith(matchTarget);
                });
                
                if (found) {
                    console.log(`   ✅ Ditemukan di ${ponPort.toUpperCase()}`);
                    let redaman = found.rxpower || 'N/A';
                    if (redaman !== 'N/A' && !String(redaman).includes('dBm')) redaman = `${redaman} dBm`;
                    return { olt_name: `${oltConfig.label} (${ponPort.toUpperCase()})`, mac_onu: found.mac, redaman, status: 'Online' };
                }
            }
        }
        return null;
    } catch (error) {
        return { error: error.message };
    }
}

// ==========================================
// 3. Hioso (Puppeteer) - TURBO MODE
// ==========================================
async function cekRedamanHioso(oltConfig, mac) {
    let searchMac = mac.substring(0, 15);
    console.log(`\n🔍 [${oltConfig.label}] Mulai cek Hioso (Puppeteer Turbo)...`);
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    
    try {
        const page = await browser.newPage();
        
        // PERBAIKAN: Naikkan timeout global ke 35 detik (35000ms) untuk OLT yang agak lambat seperti Perum
        page.setDefaultTimeout(35000);
        
        // TURBO OPTIMIZATION: Blokir gambar, CSS, dan Font agar loading instan
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const baseUrl = `http://${oltConfig.ip}:${oltConfig.port}`;
        const user = oltConfig.user || 'admin';
        const pass = oltConfig.pass || 'admin';
        
        await page.authenticate({ username: user, password: pass });
        
        // PERBAIKAN: Naikkan timeout login
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        console.log(`   ✅ Login sukses di ${oltConfig.label}`);
        
        await new Promise(r => setTimeout(r, 1000));
        
        if (oltConfig.iframe) {
            let leftFrame = null;
            for (let attempt = 1; attempt <= 10; attempt++) {
                const frames = page.frames();
                leftFrame = frames.find(f => f.name() === 'leftFrame' || f.name() === 'menuFrame' || (f.url() && f.url().includes('menu')));
                if (leftFrame) break;
                await new Promise(r => setTimeout(r, 500));
            }
            if (!leftFrame) throw new Error('Gagal memuat menu frame');
            
            try {
                await leftFrame.waitForSelector('a', { timeout: 5000 });
                await leftFrame.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const allOnuLink = links.find(link => link.innerText.trim().toLowerCase().includes('all onu'));
                    if (allOnuLink) allOnuLink.click();
                });
            } catch (err) {}
            
            await new Promise(r => setTimeout(r, 1000));
            
            let mainFrame = null;
            for (let attempt = 1; attempt <= 10; attempt++) {
                const frames = page.frames();
                mainFrame = frames.find(f => f.name() === 'mainFrame' || f.name() === 'main' || (f.url() && f.url().includes('onu')));
                if (mainFrame) break;
                await new Promise(r => setTimeout(r, 500));
            }
            if (!mainFrame) throw new Error('Gagal memuat main frame');
            
            try { await mainFrame.waitForSelector('table tr', { timeout: 15000 }); } catch (err) {}
            
            try {
                await mainFrame.evaluate(() => {
                    if (typeof setNumPerPage === 'function') setNumPerPage(300);
                    else if (typeof OnPageSizeChange === 'function') OnPageSizeChange(300);
                    else { const sel = document.querySelector('select'); if (sel) { sel.value = sel.options[sel.options.length - 1].value; sel.dispatchEvent(new Event('change')); } }
                });
                await new Promise(r => setTimeout(r, 1000));
            } catch (err) {}
            
            const rxPowerResult = await mainFrame.evaluate((macToFind) => {
                const cleanTarget = macToFind.replace(/[:.-]/g, '').toLowerCase();
                const rows = Array.from(document.querySelectorAll('table tr'));
                for (let row of rows) {
                    const cleanRowText = row.innerText.replace(/[:.-]/g, '').toLowerCase();
                    if (cleanRowText.includes(cleanTarget)) {
                        const rowTextClean = row.innerText.replace(/\s+/g, ' ').trim();
                        const match = rowTextClean.match(/-\d+\.\d+/);
                        return match ? match[0] : null;
                    }
                }
                return null;
            }, searchMac);
            
            if (rxPowerResult) {
                console.log(`   ✅ Redaman ${oltConfig.label}: ${rxPowerResult} dBm`);
                return { olt_name: oltConfig.label, mac_onu: searchMac, redaman: `${rxPowerResult} dBm`, status: 'Online' };
            }
        } else {
            // PERBAIKAN: Naikkan timeout menu halaman utama OLT dan abaikan jika loadingnya nyangkut di script latar belakang
            await page.goto(`${baseUrl}/m/onu_all_onu.htm`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(e => console.log(`   ⚠️ Web lambat, ditoleransi...`));
            await new Promise(r => setTimeout(r, 1500));
            
            let targetFrame = page;
            const frames = page.frames();
            if (frames.length > 1) { targetFrame = frames.find(f => f.url().includes('onu')) || frames[1]; }
            
            try { await targetFrame.waitForSelector('table tr', { timeout: 15000 }); } catch (err) {}
            
            const rxPowerResult = await targetFrame.evaluate((macToFind) => {
                const cleanTarget = macToFind.replace(/[:-]/g, '').toLowerCase();
                const rows = Array.from(document.querySelectorAll('table tr'));
                for (let row of rows) {
                    const rowText = row.innerText.replace(/[:-]/g, '').toLowerCase();
                    if (rowText.includes(cleanTarget)) {
                        const match = row.innerText.replace(/\s+/g, ' ').match(/\s(-\d+\.\d+)\s/);
                        if (match) return match[1];
                    }
                }
                return null;
            }, searchMac);
            
            if (rxPowerResult) {
                console.log(`   ✅ Redaman ${oltConfig.label}: ${rxPowerResult} dBm`);
                return { olt_name: oltConfig.label, mac_onu: searchMac, redaman: `${rxPowerResult} dBm`, status: 'Online' };
            }
        }
        
        console.log(`   ❌ Tidak ditemukan di ${oltConfig.label}`);
        return null;
    } catch (error) {
        return { error: error.message };
    } finally {
        await browser.close();
    }
}

// ==========================================
// 4. RETRY WRAPPER
// ==========================================
const MAX_RETRY_PER_OLT = 2;
const RETRY_DELAY_MS = 1000;

async function cekDenganRetry(checkerFn, oltConfig, mac) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRY_PER_OLT; attempt++) {
        const hasil = await checkerFn(oltConfig, mac);
        if (!hasil || !hasil.error) return hasil;
        lastError = hasil.error;
        console.log(`   🔁 [${oltConfig.label}] Coba ${attempt}/${MAX_RETRY_PER_OLT} gagal: ${lastError}`);
        if (attempt < MAX_RETRY_PER_OLT) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
    return null;
}

// ==========================================
// 5. SCAN SEMUA OLT (PARALEL BERTAHAP ANTI-TIMEOUT)
// ==========================================
async function scanSemuaOlt(oltList, mac, onFound) {
    let foundResult = null;
    console.log(`\n========================================`);
    console.log(`🚀 MULAI SCAN PARALEL TURBO (JEDA 800ms)`);
    console.log(`========================================`);
    
    const scanPromises = [];
    
    for (let i = 0; i < oltList.length; i++) {
        const olt = oltList[i];
        
        // Eksekusi jalan di latar belakang (paralel)
        scanPromises.push((async () => {
            try {
                // Jika sudah ada OLT lain yang menemukan duluan, langsung berhentikan proses ini
                if (foundResult) return null; 
                let hasil = null;
                
                if (olt.type === 'HSAirpo') {
                    hasil = olt.method === 'cibarola'
                        ? await cekDenganRetry(cekRedamanHSAirpoCibarola, olt, mac)
                        : await cekDenganRetry(cekRedamanHSAirpoAPI, olt, mac);
                } else if (olt.type === 'Hioso') {
                    hasil = await cekDenganRetry(cekRedamanHioso, olt, mac);
                }
                
                // Begitu ketemu, langsung lempar hasilnya ke layar NMS
                if (hasil && !hasil.error && !foundResult) {
                    foundResult = hasil;
                    const teksHasil = `\n✅ *${hasil.olt_name}*\n   📉 Redaman: *${hasil.redaman}*\n   📡 Status: ${hasil.status}`;
                    await onFound(teksHasil);
                }
            } catch (err) {
                console.error(`Error saat scan ${olt.label}:`, err.message);
            }
        })());
        
        // KUNCI KECEPATAN & KESTABILAN: Jeda 800ms sebelum browser selanjutnya dibuka!
        if (i < oltList.length - 1) {
            await new Promise(r => setTimeout(r, 800));
        }
    }
    
    // Tunggu sampai semua proses yang sedang jalan selesai
    await Promise.all(scanPromises);
    
    return !!foundResult;
}

module.exports = { scanSemuaOlt };
