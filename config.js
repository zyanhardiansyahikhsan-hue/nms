// config.js - RnBNET BOT (Web Dashboard Version - Urutan Scan Updated)
module.exports = {
    defaultMikrotik: { timeout: 15 },
    servers: {
        panglejar: {
            label: 'Panglejar',
            mikrotik: { host: '103.191.165.115', port: 705, user: 'berry', pass: 'subang21' },
            olts: [
                { type: 'HSAirpo', label: 'HSAirpo Panglejar', ip: '103.191.165.115', port: 710, user: 'root', pass: 'admin' }
            ]
        },
        perum: {
            label: 'Perum',
            mikrotik: { host: '103.191.165.38', port: 8725, user: 'berry', pass: 'subang21' },
            olts: [
                { type: 'Hioso', label: 'Hioso Perum', ip: '103.191.165.38', port: 8422, user: 'admin', pass: 'admin', iframe: false }
            ]
        },
        cibarola: {
            label: 'Cibarola',
            mikrotik: { host: '103.191.165.115', port: 8725, user: 'berry', pass: 'subang21' },
            olts: [
                // Urutan 1: HSAirpo
                { type: 'HSAirpo', label: 'HSAirpo Cibarola', ip: '103.191.165.115', port: 704, user: 'admin', pass: 'admin', method: 'cibarola', total_pon: 4 },
                // Urutan 2: Hioso
                { type: 'Hioso', label: 'Hioso Cibarola', ip: '103.191.165.115', port: 655, user: 'admin', pass: 'admin', iframe: true }
            ]
        },
        sukamelang: {
            label: 'Sukamelang',
            mikrotik: { host: '103.191.165.100', port: 3150, user: 'berry', pass: 'Subang21' },
            olts: [
                // Urutan 1: HSAirpo
                { type: 'HSAirpo', label: 'HSAirpo Sukamelang', ip: '103.191.165.100', port: 9900, user: 'root', pass: 'admin' },
                // Urutan 2: Hioso 4Pon Baru (Port 671)
                { type: 'Hioso', label: 'Hioso 4Pon Baru Sukamelang', ip: '103.191.165.100', port: 671, user: 'admin', pass: 'admin', iframe: false },
                // Urutan 3: Hioso 4Pon Lama (Port 670)
                { type: 'Hioso', label: 'Hioso 4Pon Lama Sukamelang', ip: '103.191.165.100', port: 670, user: 'admin', pass: 'admin', iframe: false },
                // Urutan 4: Hioso 8Pon (Port 680)
                { type: 'Hioso', label: 'Hioso 8Pon Sukamelang', ip: '103.191.165.100', port: 680, user: 'admin', pass: 'admin', iframe: true }
            ]
        }
    }
};
