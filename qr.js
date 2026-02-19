// qr.js — QR code generation (with multi-part fallback) and scanning wrapper

const QR = {
    _scanner: null,
    _cycleTimer: null,
    _currentChunks: [],
    _currentIndex: 0,
    _cycleSpeed: 500,
    _currentContainerId: null,

    CHUNK_MAX: 300,

    generate(containerId, data) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';

        // Always render the full single QR code at a large size for easy scanning
        QR._renderQR(container, data, 360);

        // Always show multi-part QR codes below for devices with weaker cameras
        const chunks = QR._splitIntoChunks(data);
        QR._currentChunks = chunks;
        QR._currentIndex = 0;

        const section = document.createElement('div');
        section.className = 'qr-multi-section';
        section.id = containerId + '-multi';

        const label = document.createElement('p');
        label.className = 'qr-multi-label';
        label.textContent = 'Having trouble scanning? Use these smaller QR codes instead';
        section.appendChild(label);

        const miniContainer = document.createElement('div');
        miniContainer.className = 'qr-mini-container';
        miniContainer.id = containerId + '-mini';
        section.appendChild(miniContainer);

        const counter = document.createElement('p');
        counter.className = 'qr-counter';
        counter.id = containerId + '-counter';
        counter.textContent = 'QR 1 of ' + chunks.length;
        section.appendChild(counter);

        const speedToggle = document.createElement('label');
        speedToggle.className = 'qr-speed-toggle';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = containerId + '-slow';
        checkbox.addEventListener('change', (e) => {
            QR._cycleSpeed = e.target.checked ? 1000 : 500;
            QR._startCycleTimer(QR._currentContainerId);
        });
        speedToggle.appendChild(checkbox);
        speedToggle.appendChild(document.createTextNode(' Slower (1s)'));
        section.appendChild(speedToggle);

        container.parentNode.insertBefore(section, container.nextSibling);

        QR._currentContainerId = containerId;
        QR._renderQR(miniContainer, chunks[0], 360);
        QR._startCycleTimer(containerId);
    },

    _splitIntoChunks(data) {
        const chunks = [];
        // Account for prefix length when splitting
        // Prefix format: "{n}/{total}:" — estimate total first
        const estimatedTotal = Math.ceil(data.length / QR.CHUNK_MAX);
        const prefixLen = String(estimatedTotal).length * 2 + 2; // e.g. "1/3:" = 4 chars
        const chunkDataSize = QR.CHUNK_MAX - prefixLen;

        for (let i = 0; i < data.length; i += chunkDataSize) {
            chunks.push(data.slice(i, i + chunkDataSize));
        }

        const total = chunks.length;
        const prefixed = chunks.map((chunk, idx) => (idx + 1) + '/' + total + ':' + chunk);
        // Pad all chunks to the same length so QR codes use the same version/density
        const maxLen = Math.max(...prefixed.map(c => c.length));
        return prefixed.map(c => c.padEnd(maxLen));
    },

    _renderQR(element, text, size) {
        new QRCode(element, {
            text: text,
            width: size,
            height: size,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.L
        });
    },

    _startCycleTimer(containerId) {
        QR._stopCycleTimer();
        QR._cycleTimer = setInterval(() => {
            QR._currentIndex = (QR._currentIndex + 1) % QR._currentChunks.length;
            QR._showChunk(containerId);
        }, QR._cycleSpeed);
    },

    _stopCycleTimer() {
        if (QR._cycleTimer) {
            clearInterval(QR._cycleTimer);
            QR._cycleTimer = null;
        }
    },

    _showChunk(containerId) {
        const miniContainer = document.getElementById(containerId + '-mini');
        const counter = document.getElementById(containerId + '-counter');
        if (!miniContainer || !counter) return;

        miniContainer.innerHTML = '';
        QR._renderQR(miniContainer, QR._currentChunks[QR._currentIndex], 360);
        counter.textContent = 'QR ' + (QR._currentIndex + 1) + ' of ' + QR._currentChunks.length;
    },

    _parseChunk(text) {
        const match = text.match(/^(\d+)\/(\d+):(.+)$/s);
        if (!match) return null;
        return {
            partNum: parseInt(match[1], 10),
            totalParts: parseInt(match[2], 10),
            data: match[3].trimEnd()
        };
    },

    scan(containerId) {
        return new Promise((resolve, reject) => {
            const container = document.getElementById(containerId);

            const scanner = new Html5Qrcode(containerId);
            QR._scanner = scanner;

            const parts = new Map();
            let expectedTotal = null;

            scanner.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
                (decodedText) => {
                    const chunk = QR._parseChunk(decodedText);

                    if (!chunk) {
                        // Single QR code — resolve immediately
                        scanner.stop().then(() => {
                            QR._scanner = null;
                            QR._cleanupScanUI(containerId);
                            resolve(decodedText);
                        }).catch(() => {
                            QR._scanner = null;
                            QR._cleanupScanUI(containerId);
                            resolve(decodedText);
                        });
                        return;
                    }

                    // Multi-part QR code
                    if (parts.has(chunk.partNum)) return; // Duplicate, ignore

                    parts.set(chunk.partNum, chunk.data);
                    expectedTotal = chunk.totalParts;

                    // Show/update progress
                    QR._showScanProgress(containerId, parts.size, expectedTotal);

                    if (parts.size === expectedTotal) {
                        // All parts collected — reassemble in order
                        const assembled = [];
                        for (let i = 1; i <= expectedTotal; i++) {
                            assembled.push(parts.get(i));
                        }
                        const fullData = assembled.join('');

                        scanner.stop().then(() => {
                            QR._scanner = null;
                            QR._cleanupScanUI(containerId);
                            resolve(fullData);
                        }).catch(() => {
                            QR._scanner = null;
                            QR._cleanupScanUI(containerId);
                            resolve(fullData);
                        });
                    }
                },
                () => {} // No QR found in frame — expected, keep scanning
            ).catch(err => {
                QR._scanner = null;
                QR._cleanupScanUI(containerId);
                reject(err);
            });
        });
    },

    _showScanProgress(containerId, scanned, total) {
        const progressId = containerId + '-progress';
        let el = document.getElementById(progressId);
        if (!el) {
            el = document.createElement('p');
            el.className = 'qr-scan-progress';
            el.id = progressId;
            const container = document.getElementById(containerId);
            container.parentNode.insertBefore(el, container.nextSibling);
        }
        const remaining = total - scanned;
        el.textContent = 'Scanned ' + scanned + ' of ' + total + ' — ' + remaining + ' remaining';
    },

    _cleanupScanUI(containerId) {
        const hint = document.getElementById(containerId + '-hint');
        if (hint) hint.remove();
        const progress = document.getElementById(containerId + '-progress');
        if (progress) progress.remove();
    },

    stopDisplay() {
        QR._stopCycleTimer();
        QR._currentChunks = [];
        QR._currentIndex = 0;
        // Remove any multi-QR sections
        document.querySelectorAll('.qr-multi-section').forEach(el => el.remove());
    },

    stopScanner() {
        QR._cleanupScanUI('scanner-offer');
        QR._cleanupScanUI('scanner-answer');
        if (QR._scanner) {
            return QR._scanner.stop().then(() => { QR._scanner = null; }).catch(() => { QR._scanner = null; });
        }
        return Promise.resolve();
    }
};
