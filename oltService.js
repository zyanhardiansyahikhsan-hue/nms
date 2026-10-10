// oltService.js - Web Dashboard Version (v3: STABIL & CEPAT)
//
// Perubahan utama dibanding versi sebelumnya:
//  1. Satu browser Puppeteer dipakai bersama (tidak lagi launch Chromium per OLT per percobaan)
//  2. Begitu SATU OLT menemukan ONU, semua pengecekan OLT lain langsung dibatalkan
//  3. Hioso non-iframe dicoba via HTTP biasa dulu (tanpa browser), fallback ke Puppeteer
//  4. Koneksi paralel ke IP yang sama dibatasi (web server Hioso gampang timeout kalau dikeroyok)
//  5. Hioso non-iframe tidak lagi membuka halaman root (frameset) yang menarik banyak request
//  6. Login HSAirpo di-cache (tidak login ulang tiap scan), scan PON paralel terbatas
//  7. Semua sleep tetap diganti menunggu kondisi (waitFor...), bukan tebakan waktu
//  8. Batas waktu keras per percobaan & per scan; "OLT gagal dihubungi" dibedakan dari "tidak ditemukan"

const axios = require('axios');
const crypto = require('crypto');
const http = require('http');

// ==========================================
// 0. PENGATURAN
// ==========================================
const MAC_PREFIX_LEN = 10;            // 5 byte pertama MAC (sama dengan versi lama: substring(0,15))
const MAX_RETRY_PER_OLT = 2;
const RETRY_DELAY_MS = 700;
const DEADLINE_HSAIRPO_MS = 20000;    // batas keras 1x percobaan (bisa di-override: olt.timeout_ms)
const DEADLINE_HIOSO_MS = 30000;
const SCAN_TOTAL_TIMEOUT_MS = 35000;  // batas keras seluruh scan
const HIOSO_MAX_PER_IP = 2;           // maks pengecekan Hioso bersamaan ke IP yang sama
const HIOSO_MAX_GLOBAL = 4;           // maks pengecekan Hioso bersamaan se-server
const PON_PARALEL_DEFAULT = 4;        // maks request PON bersamaan (bisa di-override: olt.paralel)
const SESI_TTL_MS = 3 * 60 * 1000;    // lama cache token/cookie login
const BROWSER_IDLE_MS = 5 * 60 * 1000;
const NAV_TIMEOUT_MS = 12000;
const WAIT_DATA_MS = 5000;
const HIOSO_HTTP_TIMEOUT_MS = 20000;  // OLT lambat (mis. Perum) bisa butuh >8 dtk; bisa di-override: olt.http_timeout_ms
const LONG_TIMEOUT_NO_RETRY_MS = 10000; // timeout selama ini = OLT lambat/macet, retry hanya menggandakan waktu tunggu

// ==========================================
// 1. UTILITAS
// ==========================================
const normalisasiMac = (mac) => String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
const hapusSeparator = (s) => String(s || '').replace(/[:.\-]/g, '').toLowerCase();
const POLA_MAC = /(?:[0-9a-f]{2}[:\-.]){5}[0-9a-f]{2}|(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}/i;
const POLA_REDAMAN = /(?<![\w.])-\d+\.\d+/;

function formatRedaman(nilai) {
    if (!nilai) return 'N/A';
    const s = String(nilai);
    return s.includes('dBm') ? s : `${s} dBm`;
}

// sleep yang langsung berhenti kalau scan dibatalkan
function tidur(ms, signal) {
    return new Promise((resolve) => {
        if (signal && signal.aborted) return resolve();
        const selesai = () => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', selesai);
            resolve();
        };
        const timer = setTimeout(selesai, ms);
        if (signal) signal.addEventListener('abort', selesai, { once: true });
    });
}

// Signal anak: ikut batal kalau parent batal, dan batal sendiri kalau lewat batas waktu
function buatSignalAnak(parent, ms) {
    const c = new AbortController();
    const onAbort = () => c.abort();
    if (parent.aborted) c.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => c.abort(), ms);
    return {
        signal: c.signal,
        bersih() {
            clearTimeout(timer);
            parent.removeEventListener('abort', onAbort);
        }
    };
}

// Jamin promise berhenti begitu signal batal, walau fungsi di dalamnya tidak kooperatif
function balapAbort(promise, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            promise.catch(() => {});
            return reject(new Error('dibatalkan'));
        }
        const onAbort = () => reject(new Error('dibatalkan'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

class Semaphore {
    constructor(max) { this.max = max; this.aktif = 0; this.antri = []; }
    async ambil(signal) {
        if (signal && signal.aborted) throw new Error('dibatalkan');
        if (this.aktif < this.max) { this.aktif++; return; }
        await new Promise((resolve, reject) => {
            const item = { resolve };
            this.antri.push(item);
            if (signal) {
                signal.addEventListener('abort', () => {
                    const i = this.antri.indexOf(item);
                    if (i >= 0) { this.antri.splice(i, 1); reject(new Error('dibatalkan')); }
                }, { once: true });
            }
        });
    }
    lepas() {
        const next = this.antri.shift();
        if (next) next.resolve();   // slot langsung dioper ke antrean berikutnya
        else this.aktif--;
    }
}

const limiterGlobalHioso = new Semaphore(HIOSO_MAX_GLOBAL);
const limiterPerIp = new Map();
function limiterHioso(ip) {
    if (!limiterPerIp.has(ip)) limiterPerIp.set(ip, new Semaphore(HIOSO_MAX_PER_IP));
    const perIp = limiterPerIp.get(ip);
    return {
        async ambil(signal) {
            await perIp.ambil(signal);
            try { await limiterGlobalHioso.ambil(signal); }
            catch (e) { perIp.lepas(); throw e; }
        },
        lepas() { limiterGlobalHioso.lepas(); perIp.lepas(); }
    };
}

// Jalankan fn untuk tiap item dengan maksimal `batas` yang bersamaan; berhenti di temuan pertama
async function cariParalel(daftar, batas, fn, signal) {
    let idx = 0;
    let temuan = null;
    const pekerja = async () => {
        while (temuan === null && !signal.aborted) {
            const i = idx++;
            if (i >= daftar.length) return;
            const r = await fn(daftar[i]);
            if (r) { temuan = r; return; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(batas, daftar.length) }, pekerja));
    return temuan;
}

const agentApi = new http.Agent({ keepAlive: true, maxSockets: 8 });
const agentHioso = new http.Agent({ keepAlive: false, maxSockets: 2 }); // perangkat embedded: jangan keep-alive

// ==========================================
// 2. HSAirpo API (Panglejar & Sukamelang)
// ==========================================
const sesiApi = new Map();

async function cekRedamanHSAirpoAPI(olt, target, signal) {
    console.log(`\n🔍 [${olt.label}] Mulai cek (API)...`);
    const base = `http://${olt.ip}:${olt.port}`;
    const username = olt.user || 'root';
    const kunciSesi = `${olt.ip}:${olt.port}:${username}`;
    try {
        let sesi = sesiApi.get(kunciSesi);
        if (!sesi || sesi.exp < Date.now()) {
            const password = olt.pass || 'admin';
            const key = crypto.createHash('md5').update(`${username}:${password}`).digest('hex');
            const value = Buffer.from(password).toString('base64');
            const loginRes = await axios.post(
                `${base}/userlogin?form=login`,
                { method: 'set', param: { name: username, key, value, captcha_v: ' ', captcha_f: ' ' } },
                { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-token': 'null' }, timeout: 8000, signal, httpAgent: agentApi }
            );
            if (!loginRes.data || loginRes.data.code !== 1) {
                throw new Error(`Login gagal: ${(loginRes.data && loginRes.data.message) || 'respon tidak valid'}`);
            }
            const token = loginRes.headers['x-token'];
            if (!token) throw new Error('Login gagal: token kosong');
            sesi = { token, exp: Date.now() + SESI_TTL_MS };
            sesiApi.set(kunciSesi, sesi);
        }

        const totalPon = olt.total_pon || 16;
        const daftarPort = Array.from({ length: totalPon }, (_, i) => i + 1);
        let gagal = 0;
        let errPertama = null;

        const temuan = await cariParalel(daftarPort, olt.paralel || PON_PARALEL_DEFAULT, async (port) => {
            try {
                const res = await axios.get(`${base}/onu_allow_list?port_id=${port}`, {
                    headers: { 'x-token': sesi.token }, timeout: 5000, signal, httpAgent: agentApi
                });
                if (res.data && res.data.code !== undefined && res.data.code !== 1) {
                    throw new Error(`respon code ${res.data.code}`);
                }
                const onuList = res.data && Array.isArray(res.data.data) ? res.data.data : [];
                const onu = onuList.find((x) => x.macaddr && normalisasiMac(x.macaddr).startsWith(target));
                return onu ? { onu, port } : null;
            } catch (e) {
                if (axios.isCancel(e) || signal.aborted) throw e;
                gagal++;
                errPertama = errPertama || e.message;
                return null;
            }
        }, signal);

        if (temuan) {
            console.log(`   ✅ [${olt.label}] Ditemukan di PON ${temuan.port}`);
            return {
                olt_name: `${olt.label} (PON ${temuan.port})`,
                mac_onu: temuan.onu.macaddr,
                redaman: formatRedaman(temuan.onu.receive_power),
                status: temuan.onu.status || 'Online'
            };
        }
        // Tidak ketemu, tapi ada PON yang gagal dibaca -> jangan bilang "tidak ditemukan"
        if (gagal > 0) throw new Error(`${gagal}/${totalPon} PON gagal dibaca (${errPertama})`);
        return null;
    } catch (e) {
        if (!axios.isCancel(e)) sesiApi.delete(kunciSesi); // sesi mungkin kedaluwarsa -> login ulang di percobaan berikutnya
        throw e;
    }
}

// ==========================================
// 3. HSAirpo CIBAROLA (Axios API)
// ==========================================
const sesiCibarola = new Map();

async function cekRedamanHSAirpoCibarola(olt, target, signal) {
    console.log(`\n🔍 [${olt.label}] Mulai cek (Cibarola API)...`);
    const base = `http://${olt.ip}:${olt.port}`;
    const kunciSesi = `${olt.ip}:${olt.port}:${olt.user || 'admin'}`;
    try {
        let sesi = sesiCibarola.get(kunciSesi);
        if (!sesi || sesi.exp < Date.now()) {
            const loginRes = await axios.post(
                `${base}/login/Auth`,
                { userName: olt.user || 'admin', password: Buffer.from(olt.pass || 'admin').toString('base64') },
                { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 8000, signal, httpAgent: agentApi }
            );
            if (!loginRes.data || loginRes.data.errCode !== 'success') throw new Error('Login gagal');
            const cookies = loginRes.headers['set-cookie'];
            const cookie = cookies ? cookies.map((c) => c.split(';')[0]).join('; ') : '';
            sesi = { cookie, exp: Date.now() + SESI_TTL_MS };
            sesiCibarola.set(kunciSesi, sesi);
        }

        const totalPon = olt.total_pon || 4;
        const daftarPon = Array.from({ length: totalPon }, (_, i) => `pon${i + 1}`);
        let gagal = 0;
        let tanpaList = 0;
        let errPertama = null;

        const temuan = await cariParalel(daftarPon, olt.paralel || 2, async (ponPort) => {
            try {
                const res = await axios.get(
                    `${base}/goform/getPortOnuOptical?${Math.random()}&PonPortName=${ponPort}`,
                    { headers: { Cookie: sesi.cookie, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 10000, signal, httpAgent: agentApi }
                );
                let data = res.data;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { /* abaikan */ } }
                if (!data || !Array.isArray(data.list)) { tanpaList++; return null; }
                const onu = data.list.find((o) => String(o.mac || '').replace(/\./g, '').toLowerCase().startsWith(target));
                return onu ? { onu, ponPort } : null;
            } catch (e) {
                if (axios.isCancel(e) || signal.aborted) throw e;
                gagal++;
                errPertama = errPertama || e.message;
                return null;
            }
        }, signal);

        if (temuan) {
            console.log(`   ✅ [${olt.label}] Ditemukan di ${temuan.ponPort.toUpperCase()}`);
            return {
                olt_name: `${olt.label} (${temuan.ponPort.toUpperCase()})`,
                mac_onu: temuan.onu.mac,
                redaman: formatRedaman(temuan.onu.rxpower),
                status: 'Online'
            };
        }
        if (gagal > 0) throw new Error(`${gagal}/${totalPon} PON gagal dibaca (${errPertama})`);
        if (tanpaList === totalPon) throw new Error('respon tidak berisi daftar ONU (sesi kedaluwarsa?)');
        return null;
    } catch (e) {
        if (!axios.isCancel(e)) sesiCibarola.delete(kunciSesi);
        throw e;
    }
}

// ==========================================
// 4. Hioso
// ==========================================
function hasilHioso(olt, target, barisTeks) {
    const nilai = (barisTeks.match(POLA_REDAMAN) || [])[0];
    const macAsli = (barisTeks.match(POLA_MAC) || [target])[0];
    console.log(`   ✅ [${olt.label}] Ditemukan, redaman: ${nilai ? nilai + ' dBm' : 'tidak terbaca'}`);
    return {
        olt_name: olt.label,
        mac_onu: macAsli,
        redaman: nilai ? `${nilai} dBm` : 'N/A',
        status: nilai ? 'Online' : 'Redaman tidak terbaca (kemungkinan offline)'
    };
}

// ---- 4a. Jalur cepat: HTTP biasa (tanpa browser), hanya untuk Hioso non-iframe ----
function cariBarisDiHtml(html, target) {
    const bersih = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const potongan = bersih.split(/<tr[\s>]/i).slice(1);
    let adaMac = false;
    for (const p of potongan) {
        const teks = p.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
        if (POLA_MAC.test(teks)) adaMac = true;
        if (hapusSeparator(teks).includes(target)) return { halamanTerbaca: true, baris: teks };
    }
    return { halamanTerbaca: adaMac, baris: null };
}

const waktuMuatHioso = (olt) => olt.http_timeout_ms || HIOSO_HTTP_TIMEOUT_MS;

async function cekHiosoViaHttp(olt, target, signal) {
    const mulai = Date.now();
    const res = await axios.get(`http://${olt.ip}:${olt.port}/m/onu_all_onu.htm`, {
        auth: { username: olt.user || 'admin', password: olt.pass || 'admin' },
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
        },
        timeout: waktuMuatHioso(olt),
        signal,
        httpAgent: agentHioso,
        responseType: 'text',
        transformResponse: [(d) => d],
        maxRedirects: 2
    });
    console.log(`   ⏱️ [${olt.label}] HTTP selesai ${Date.now() - mulai}ms (${Math.round(String(res.data).length / 1024)} KB)`);
    return cariBarisDiHtml(res.data, target);
}

// ---- 4b. Jalur Puppeteer (browser bersama) ----
let browserInstance = null;
let browserLaunching = null;
let halamanAktif = 0;
let idleTimer = null;

async function getBrowser() {
    if (browserInstance) return browserInstance;
    if (!browserLaunching) {
        const puppeteer = require('puppeteer'); // di-load hanya saat benar-benar dibutuhkan
        browserLaunching = puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
                '--disable-extensions', '--disable-background-networking', '--mute-audio', '--no-first-run'
            ]
        }).then((b) => {
            browserInstance = b;
            b.on('disconnected', () => { if (browserInstance === b) browserInstance = null; });
            return b;
        }).finally(() => { browserLaunching = null; });
    }
    return browserLaunching;
}

async function tutupBrowser() {
    clearTimeout(idleTimer);
    const b = browserInstance;
    browserInstance = null;
    if (b) await b.close().catch(() => {});
}

function jadwalkanTutupBrowser() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (halamanAktif === 0) tutupBrowser(); }, BROWSER_IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
}

const RESOURCE_DIBLOKIR = new Set(['image', 'stylesheet', 'font', 'media']);
const aman = (p) => Promise.resolve(p).catch(() => {}); // cegah unhandled rejection saat halaman ditutup paksa

async function denganHalaman(signal, fn) {
    clearTimeout(idleTimer);
    halamanAktif++;
    let page = null;
    const tutup = () => { if (page) page.close().catch(() => {}); };
    try {
        if (signal.aborted) throw new Error('dibatalkan');
        const browser = await getBrowser();
        page = await browser.newPage();
        signal.addEventListener('abort', tutup, { once: true });
        if (signal.aborted) tutup();
        page.setDefaultTimeout(NAV_TIMEOUT_MS);
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (RESOURCE_DIBLOKIR.has(req.resourceType())) aman(req.abort());
            else aman(req.continue());
        });
        return await fn(page);
    } finally {
        signal.removeEventListener('abort', tutup);
        if (page) await page.close().catch(() => {});
        halamanAktif--;
        if (halamanAktif === 0) jadwalkanTutupBrowser();
    }
}

// Tunggu kondisi, tapi timeout bukan error fatal (kita tetap lanjut dan cek isinya)
async function tungguLunak(fn) {
    try { await fn(); }
    catch (e) { if (e.name !== 'TimeoutError') throw e; }
}

const tungguTarget = (frame, target) => tungguLunak(() => frame.waitForFunction(
    (t) => document.body && document.body.innerText.replace(/[:.\-]/g, '').toLowerCase().includes(t),
    { timeout: WAIT_DATA_MS },
    target
));

// Cari baris <tr> paling dalam yang memuat MAC target; kembalikan teksnya
const cariBarisDiFrame = (frame, target) => frame.evaluate((t) => {
    const bersih = (s) => s.replace(/[:.\-]/g, '').toLowerCase();
    for (const tr of document.querySelectorAll('tr')) {
        if (tr.querySelector('tr')) continue; // lewati <tr> pembungkus tabel bersarang
        if (bersih(tr.innerText).includes(t)) return tr.innerText.replace(/\s+/g, ' ').trim();
    }
    return null;
}, target);

async function bukaDaftarOnuIframe(page) {
    const utama = page.mainFrame();
    const leftFrame = await page.waitForFrame(
        (f) => f !== utama && (['leftFrame', 'menuFrame'].includes(f.name()) || /menu/i.test(f.url())),
        { timeout: 8000 }
    );
    let diklik = false;
    await tungguLunak(async () => {
        await leftFrame.waitForSelector('a', { timeout: 5000 });
        diklik = await leftFrame.evaluate(() => {
            const link = Array.from(document.querySelectorAll('a'))
                .find((a) => a.innerText.trim().toLowerCase().includes('all onu'));
            if (link) { link.click(); return true; }
            return false;
        });
    });
    if (!diklik) console.log('   ⚠️ Menu "All ONU" tidak ditemukan, lanjut dengan frame utama');

    const mainFrame = await page.waitForFrame(
        (f) => f !== utama && f !== leftFrame && (['mainFrame', 'main'].includes(f.name()) || /onu/i.test(f.url())),
        { timeout: 8000 }
    );
    // Tunggu daftar ONU benar-benar termuat (bukan sleep buta)
    await tungguLunak(() => mainFrame.waitForFunction(
        () => /onu/i.test(location.href) && document.querySelectorAll('table tr').length > 1,
        { timeout: 8000 }
    ));
    return mainFrame;
}

async function tampilkanSemuaOnu(frame) {
    try {
        await frame.evaluate(() => {
            if (typeof setNumPerPage === 'function') setNumPerPage(300);
            else if (typeof OnPageSizeChange === 'function') OnPageSizeChange(300);
            else {
                const sel = document.querySelector('select');
                if (sel) { sel.value = sel.options[sel.options.length - 1].value; sel.dispatchEvent(new Event('change')); }
            }
        });
    } catch (e) { /* frame bisa reload saat ganti ukuran halaman; tidak fatal */ }
}

async function cekHiosoViaBrowser(olt, target, signal) {
    const baseUrl = `http://${olt.ip}:${olt.port}`;
    return denganHalaman(signal, async (page) => {
        await page.authenticate({ username: olt.user || 'admin', password: olt.pass || 'admin' });

        if (olt.iframe) {
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: waktuMuatHioso(olt) });
            const frame = await bukaDaftarOnuIframe(page);
            let baris = await cariBarisDiFrame(frame, target);
            if (!baris) {
                // Mungkin ONU ada di halaman berikutnya -> tampilkan semua lalu cari lagi
                await tampilkanSemuaOnu(frame);
                await tungguTarget(frame, target);
                baris = await cariBarisDiFrame(frame, target);
            }
            return baris;
        }

        // Non-iframe: langsung ke halaman daftar ONU (tidak perlu buka root/frameset)
        await page.goto(`${baseUrl}/m/onu_all_onu.htm`, { waitUntil: 'domcontentloaded', timeout: waktuMuatHioso(olt) });
        const utama = page.mainFrame();
        const anak = page.frames().find((f) => f !== utama && /onu/i.test(f.url()));
        const frame = anak || utama;
        await tungguTarget(frame, target);
        return cariBarisDiFrame(frame, target);
    });
}

// ---- 4c. Pemilih jalur ----
const modeHioso = new Map(); // `${ip}:${port}` -> 'browser' kalau halamannya ternyata butuh JavaScript

async function cekRedamanHioso(olt, target, signal) {
    console.log(`\n🔍 [${olt.label}] Mulai cek Hioso...`);
    const kunci = `${olt.ip}:${olt.port}`;

    if (!olt.iframe && olt.mode !== 'browser' && modeHioso.get(kunci) !== 'browser') {
        const h = await cekHiosoViaHttp(olt, target, signal);
        if (h.halamanTerbaca) return h.baris ? hasilHioso(olt, target, h.baris) : null;
        console.log(`   ℹ️ [${olt.label}] Halaman dirender JavaScript, pakai Puppeteer untuk OLT ini`);
        modeHioso.set(kunci, 'browser');
    }

    const baris = await cekHiosoViaBrowser(olt, target, signal);
    return baris ? hasilHioso(olt, target, baris) : null;
}

// ==========================================
// 5. RETRY WRAPPER (dengan batas waktu keras)
// ==========================================
// checkerFn: (olt, target, signal) => hasil | null, dan melempar Error kalau gagal.
// Return: hasil | null (tidak ditemukan / dibatalkan) | { error } (gagal setelah semua percobaan)
const batasWaktuOlt = (olt) => olt.timeout_ms ||
    (olt.type === 'Hioso' ? Math.max(DEADLINE_HIOSO_MS, (olt.http_timeout_ms || 0) + 8000) : DEADLINE_HSAIRPO_MS);

async function cekDenganRetry(checkerFn, olt, target, signal, limiter = null) {
    const batasMs = batasWaktuOlt(olt);
    let errTerakhir = 'tidak diketahui';

    for (let attempt = 1; attempt <= MAX_RETRY_PER_OLT; attempt++) {
        if (signal.aborted) return null;
        if (limiter) {
            try { await limiter.ambil(signal); } catch (e) { return null; }
        }
        const anak = buatSignalAnak(signal, batasMs);
        const mulaiAttempt = Date.now();
        try {
            return await balapAbort(checkerFn(olt, target, anak.signal), anak.signal);
        } catch (err) {
            if (signal.aborted) return null; // dibatalkan karena OLT lain sudah ketemu
            errTerakhir = anak.signal.aborted ? `timeout (>${Math.round(batasMs / 1000)} dtk)` : err.message;
            console.log(`   🔁 [${olt.label}] Coba ${attempt}/${MAX_RETRY_PER_OLT} gagal: ${errTerakhir}`);
            const isTimeout = anak.signal.aborted || /timeout|ETIMEDOUT/i.test(err.message);
            if (isTimeout && Date.now() - mulaiAttempt >= LONG_TIMEOUT_NO_RETRY_MS) break; // jangan gandakan waktu tunggu
        } finally {
            anak.bersih();
            if (limiter) limiter.lepas();
        }
        if (attempt < MAX_RETRY_PER_OLT) await tidur(RETRY_DELAY_MS, signal);
    }
    return { error: errTerakhir };
}

function pilihChecker(olt) {
    if (olt.type === 'HSAirpo') return olt.method === 'cibarola' ? cekRedamanHSAirpoCibarola : cekRedamanHSAirpoAPI;
    if (olt.type === 'Hioso') return cekRedamanHioso;
    return null;
}

// ==========================================
// 6. SCAN SEMUA OLT (PARALEL, BERHENTI DI TEMUAN PERTAMA)
// ==========================================
// onFound(teks)  : dipanggil sekali saat ONU ditemukan
// onGagal(daftar): (opsional) dipanggil bila TIDAK ditemukan dan ada OLT yang gagal dihubungi,
//                  supaya bisa dibedakan dari "benar-benar tidak ada"
// Return: true kalau ditemukan, false kalau tidak.
async function scanSemuaOlt(oltList, mac, onFound, onGagal) {
    const mulai = Date.now();
    const target = normalisasiMac(mac).slice(0, MAC_PREFIX_LEN);
    if (target.length < MAC_PREFIX_LEN) {
        console.log(`⚠️ MAC tidak valid: "${mac}"`);
        return false;
    }

    const controller = new AbortController();
    const gagal = [];
    let habisWaktu = false;
    const batasScanMs = Math.max(SCAN_TOTAL_TIMEOUT_MS, ...oltList.map(batasWaktuOlt).map((x) => x + 1000));
    const timerTotal = setTimeout(() => { habisWaktu = true; controller.abort(); }, batasScanMs);

    const tugas = oltList.map(async (olt) => {
        try {
            const checker = pilihChecker(olt);
            if (!checker) return false;
            const limiter = olt.type === 'Hioso' ? limiterHioso(olt.ip) : null;
            const hasil = await cekDenganRetry(checker, olt, target, controller.signal, limiter);

            if (!hasil) return false;
            if (hasil.error) { gagal.push(`${olt.label}: ${hasil.error}`); return false; }
            if (controller.signal.aborted) return false; // OLT lain sudah menang duluan

            controller.abort(); // hentikan semua pengecekan lain
            console.log(`⏱️ Ditemukan di ${olt.label} dalam ${Date.now() - mulai}ms`);
            try {
                await onFound(`\n✅ *${hasil.olt_name}*\n   📉 Redaman: *${hasil.redaman}*\n   📡 Status: ${hasil.status}`);
            } catch (e) {
                console.error('onFound error:', e.message);
            }
            return true;
        } catch (e) {
            gagal.push(`${olt.label}: ${e.message}`);
            return false;
        }
    });

    // Selesai begitu ada yang menemukan, atau semua OLT sudah selesai tanpa hasil
    const ditemukan = await new Promise((resolve) => {
        let sisa = tugas.length;
        if (sisa === 0) return resolve(false);
        tugas.forEach((t) => t.then((ok) => {
            if (ok) resolve(true);
            else if (--sisa === 0) resolve(false);
        }));
    });
    clearTimeout(timerTotal);

    if (!ditemukan) {
        if (habisWaktu) gagal.push(`Batas waktu scan ${batasScanMs / 1000} dtk habis`);
        console.log(`⏱️ Tidak ditemukan (${Date.now() - mulai}ms)${gagal.length ? `, ${gagal.length} OLT bermasalah` : ''}`);
        if (gagal.length && typeof onGagal === 'function') {
            try { await onGagal(gagal); } catch (e) { console.error('onGagal error:', e.message); }
        }
    }
    return ditemukan;
}

module.exports = { scanSemuaOlt, tutupBrowser };
