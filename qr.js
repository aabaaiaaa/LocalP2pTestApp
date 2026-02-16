// qr.js — QR code generation and scanning wrapper

const QR = {
    _scanner: null,

    generate(containerId, data) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';

        new QRCode(container, {
            text: data,
            width: 280,
            height: 280,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.L
        });
    },

    scan(containerId) {
        return new Promise((resolve, reject) => {
            const scanner = new Html5Qrcode(containerId);
            QR._scanner = scanner;

            scanner.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
                (decodedText) => {
                    scanner.stop().then(() => {
                        QR._scanner = null;
                        resolve(decodedText);
                    }).catch(() => {
                        QR._scanner = null;
                        resolve(decodedText);
                    });
                },
                () => {} // No QR found in frame — expected, keep scanning
            ).catch(err => {
                QR._scanner = null;
                reject(err);
            });
        });
    },

    stopScanner() {
        if (QR._scanner) {
            return QR._scanner.stop().then(() => { QR._scanner = null; }).catch(() => { QR._scanner = null; });
        }
        return Promise.resolve();
    }
};
