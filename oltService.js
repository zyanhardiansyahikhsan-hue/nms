// oltService.js - Parsing OLT HSAirpo & Hioso (Dying Gasp vs Laser Out)
const axios = require('axios');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

function parseOnuStatusAndRx(rxPower, statusRaw, fullObjectOrText) {
    let redaman = rxPower || 'N/A';
    if (redaman !== 'N/A' && !String(redaman).includes('dBm')) {
        redaman = `${redaman} dBm`;
    }

    const fullText = (String(statusRaw) + " " + JSON.stringify(fullObjectOrText || {})).toLowerCase();
    const rxNum = parseFloat(redaman);

    const isOffline = fullText.includes('off') || 
                      fullText.includes('down') || 
                      redaman.includes('-inf') || 
                      redaman === 'N/A' || 
                      (!isNaN(rxNum) && rxNum <= -35);

    let displayStatus = 'Online';

    if (isOffline) {
        if (fullText.includes('dying gasp') || fullText.includes('dying_gasp') || fullText.includes('power off') || fullText.includes('pwr')) {
            displayStatus = '⚡ MATI LISTRIK (Dying Gasp)';
        } else if (fullText.includes('laser out') || fullText.includes('laser_out') || fullText.includes('los') || fullText.includes('wire_cut') || redaman.includes('-inf')) {
            displayStatus = '🚨 LOSE KONEKSI (Laser Out / LOS)';
        } else {
            displayStatus = '🚨 LOSE KONEKSI (Offline)';
        }
    }

    return { redaman, displayStatus };
}

async function cekRedamanHSAirpoAPI(oltConfig, mac) {
    try {
        const searchMac = mac.substring(0, 15);
        const username = oltConfig.user || 'root';
        const password = oltConfig.pass || 'admin';
        const key = crypto.createHash('md5').update(`${username}:${password}`).digest('hex');
        const value = Buffer.from(password).toString('base64');
        
        const loginRes = await axios.post(
            `http://${oltConfig.ip}:${oltConfig.port}/userlogin?form=login`,
            { method: "set", param: { name: username, key, value, captcha_v: " ", captcha_f: " " } },
            { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-token': 'null' }, timeout: 10000 }
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
                const { redaman, displayStatus } = parseOnuStatusAndRx(found.receive_power, found.status, found);
                return { olt_name: `${oltConfig.label} (PON ${port})`, mac_onu: found.macaddr, redaman, status: displayStatus };
            }
        }
        return null;
    } catch (error) {
        return { error: error.message };
    }
}

async function cekRedamanHSAirpoCibarola(oltConfig, mac) {
    try {
        const cleanTargetMac = mac.replace(/[:.-]/g, '').toLowerCase();
        const matchTarget = cleanTargetMac.substring(0, 10);
        const passwordBase64 = Buffer.from(oltConfig.pass || 'admin').toString('base64');
        
        const loginRes = await axios.post(
            `http://${oltConfig.ip}:${oltConfig.port}/login/Auth`,
            { userName: oltConfig.user || 'admin', password: passwordBase64 },
            { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 10000 }
        );
        
        if (loginRes.data.errCode !== 'success') throw new Error('Login gagal');
        const cookies = loginRes.headers['set-cookie'];
        let sessionCookie = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
        
        const totalPon = oltConfig.total_pon || 4;
        for (let i = 1; i <= totalPon; i++) {
            const ponPort = `pon${i}`;
            const opticalRes = await axios.get(
                `http://${oltConfig.ip}:${oltConfig.port}/goform/getPortOnuOptical?${Math.random()}&PonPortName=${ponPort}`,
                { headers: { 'Cookie': sessionCookie, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 15000 }
            );
            
            let jsonData = opticalRes.data;
            if (typeof jsonData === 'string') { try { jsonData = JSON.parse(jsonData); } catch (e) {} }
            
            if (jsonData && jsonData.list) {
                const found = jsonData.list.find(onu => {
                    const onuMac = (onu.mac || '').replace(/\./g, '').toLowerCase();
                    return onuMac.startsWith(matchTarget);
                });
                
                if (found) {
                    const { redaman, displayStatus } = parseOnuStatusAndRx(found.rxpower, found.status, found);
                    return { olt_name: `${oltConfig.label} (${ponPort.toUpperCase()})`, mac_onu: found.mac, redaman, status: displayStatus };
                }
            }
        }
        return null;
    } catch (error) {
        return { error: error.message };
    }
}

async function cekRedamanHioso(oltConfig, mac) {
    let searchMac = mac.substring(0, 15);
    if (oltConfig.label.includes('Cibarola') || oltConfig.label.includes('8Pon')) searchMac = mac.substring(0, 15);
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(30000);
        const baseUrl = `http://${oltConfig.ip}:${oltConfig.port}`;
        const user = oltConfig.user || 'admin';
        const pass = oltConfig.pass || 'admin';
        
        await page.authenticate({ username: user, password: pass });
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));
        
        let targetFrame = page;
        if (oltConfig.iframe) {
            let leftFrame = null;
            for (let i = 0; i < 10; i++) {
                leftFrame = page.frames().find(f => f.name() === 'leftFrame' || f.name() === 'menuFrame');
                if (leftFrame) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (leftFrame) {
                await leftFrame.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const link = links.find(l => l.innerText.toLowerCase().includes('all onu'));
                    if (link) link.click();
                });
                await new Promise(r => setTimeout(r, 2000));
            }
            for (let i = 0; i < 10; i++) {
                targetFrame = page.frames().find(f => f.name() === 'mainFrame' || f.name() === 'main') || targetFrame;
                if (targetFrame !== page) break;
                await new Promise(r => setTimeout(r, 1000));
            }
        } else {
            await page.goto(`${baseUrl}/m/onu_all_onu.htm`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));
            const frames = page.frames();
            if (frames.length > 1) targetFrame = frames.find(f => f.url().includes('onu')) || frames[1];
        }
        
        try { await targetFrame.waitForSelector('table tr', { timeout: 15000 }); } catch (e) {}
        
        const onuData = await targetFrame.evaluate((macToFind) => {
            const cleanTarget = macToFind.replace(/[:.-]/g, '').toLowerCase();
            const rows = Array.from(document.querySelectorAll('table tr'));
            for (let row of rows) {
                const cleanRowText = row.innerText.replace(/[:.-]/g, '').toLowerCase();
                if (cleanRowText.includes(cleanTarget)) {
                    const rawText = row.innerText.trim();
                    const rxMatch = rawText.match(/-\d+\.\d+/);
                    return { rxPower: rxMatch ? `${rxMatch[0]} dBm` : 'N/A', rawRowText: rawText };
                }
            }
            return null;
        }, searchMac);
        
        if (onuData) {
            const { redaman, displayStatus } = parseOnuStatusAndRx(onuData.rxPower, onuData.rawRowText, onuData.rawRowText);
            return { olt_name: oltConfig.label, mac_onu: searchMac, redaman, status: displayStatus };
        }
        return null;
    } catch (error) {
        return { error: error.message };
    } finally {
        await browser.close();
    }
}

const MAX_RETRY_PER_OLT = 2;
const RETRY_DELAY_MS = 1500;

async function cekDenganRetry(checkerFn, oltConfig, mac) {
    for (let attempt = 1; attempt <= MAX_RETRY_PER_OLT + 1; attempt++) {
        const hasil = await checkerFn(oltConfig, mac);
        if (!hasil || !hasil.error) return hasil;
        if (attempt <= MAX_RETRY_PER_OLT) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
    return null;
}

async function scanSemuaOlt(oltList, mac, onFound) {
    let foundResult = null;
    const scanPromises = oltList.map(async (olt) => {
        try {
            if (foundResult) return null;
            let hasil = null;
            if (olt.type === 'HSAirpo') {
                hasil = olt.method === 'cibarola'
                    ? await cekDenganRetry(cekRedamanHSAirpoCibarola, olt, mac)
                    : await cekDenganRetry(cekRedamanHSAirpoAPI, olt, mac);
            } else if (olt.type === 'Hioso') {
                hasil = await cekDenganRetry(cekRedamanHioso, olt, mac);
            }
            
            if (hasil && !hasil.error && !foundResult) {
                foundResult = hasil;
                const teksHasil = `\n✅ *${hasil.olt_name}*\n   📉 Redaman: *${hasil.redaman}*\n   📡 Status: ${hasil.status}`;
                await onFound(teksHasil);
            }
        } catch (err) {}
    });
    
    await Promise.all(scanPromises);
    return !!foundResult;
}

module.exports = { scanSemuaOlt };
