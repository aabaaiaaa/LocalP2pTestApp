// app.js — Main application orchestrator

const App = {
    role: null,
    _blobUrls: [],

    init() {
        // Home
        document.getElementById('btn-create').addEventListener('click', () => App.startAsOfferer());
        document.getElementById('btn-join').addEventListener('click', () => App.startAsJoiner());

        // QR flow
        document.getElementById('btn-scan-answer').addEventListener('click', () => App.scanAnswer());
        document.getElementById('btn-cancel-scan-offer').addEventListener('click', () => App.cancelScan('home'));
        document.getElementById('btn-cancel-scan-answer').addEventListener('click', () => App.cancelScan('show-offer-qr'));

        // Connected — messages
        document.getElementById('btn-send-msg').addEventListener('click', () => App.sendMessage());
        document.getElementById('msg-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') App.sendMessage();
        });

        // Connected — files
        document.getElementById('file-input').addEventListener('change', (e) => App.sendFile(e));

        // Connected — speed test
        document.getElementById('btn-quick-test').addEventListener('click', () => {
            if (!SpeedTest._running) SpeedTest.runQuick();
        });
        document.getElementById('btn-full-test').addEventListener('click', () => {
            if (!SpeedTest._running) SpeedTest.runFull();
        });

        // Connected — media
        document.getElementById('btn-start-video').addEventListener('click', () => App.startMedia(true));
        document.getElementById('btn-start-audio').addEventListener('click', () => App.startMedia(false));
        document.getElementById('btn-stop-media').addEventListener('click', () => App.stopMedia());

        // Disconnect / error
        document.getElementById('btn-disconnect').addEventListener('click', () => App.reset());
        document.getElementById('btn-retry').addEventListener('click', () => App.reset());

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => App.switchTab(tab.dataset.tab));
        });

        // Wire Peer callbacks
        Peer.onMessage = (text) => App.displayMessage(text, 'remote');
        Peer.onFileMetadata = (meta) => App.showFileIncoming(meta);
        Peer.onFileChunk = (chunk, received, total) => App.updateFileProgress(received, total);
        Peer.onFileComplete = (blob, name) => App.showFileDownload(blob, name);
        Peer.onStateChange = (state) => App.handleConnectionState(state);
        Peer.onError = (err) => App.showError(err.message || 'Connection error');
        Peer.onPong = (msg) => SpeedTest.handlePong(msg);
        Peer.onRemoteStream = (stream) => App.handleRemoteStream(stream);
        Peer.onMediaStats = (stats) => App.updateMediaStats(stats);
    },

    setState(state) {
        document.body.dataset.state = state;
    },

    // === OFFERER FLOW ===

    async startAsOfferer() {
        App.role = 'offerer';
        App.setState('creating-offer');

        try {
            const desc = await Peer.createOffer();
            const encoded = Signal.encode(desc);
            console.log('Offer encoded:', encoded.length, 'chars');
            QR.generate('qr-offer', encoded);
            App.setState('show-offer-qr');
        } catch (err) {
            App.showError('Failed to create offer: ' + err.message);
        }
    },

    async scanAnswer() {
        QR.stopDisplay();
        App.setState('scan-answer');
        try {
            const data = await QR.scan('scanner-answer');
            App.setState('connecting');
            const { sdp } = Signal.decode(data);
            await Peer.processAnswer(sdp);
        } catch (err) {
            App.showError('Failed to scan answer: ' + err.message);
        }
    },

    // === JOINER FLOW ===

    async startAsJoiner() {
        App.role = 'joiner';
        App.setState('scan-offer');

        try {
            const data = await QR.scan('scanner-offer');
            App.setState('creating-answer');
            const { sdp } = Signal.decode(data);
            const desc = await Peer.processOfferAndCreateAnswer(sdp);
            const encoded = Signal.encode(desc);
            console.log('Answer encoded:', encoded.length, 'chars');
            QR.generate('qr-answer', encoded);
            App.setState('show-answer-qr');
        } catch (err) {
            App.showError('Failed to process offer: ' + err.message);
        }
    },

    // === CONNECTION STATE ===

    handleConnectionState(state) {
        switch (state) {
            case 'connected':
                App.setState('connected');
                document.getElementById('conn-status').textContent = 'Connected';
                document.getElementById('conn-indicator').className = 'conn-indicator';
                break;
            case 'unresponsive':
                document.getElementById('conn-status').textContent = 'Peer unresponsive...';
                document.getElementById('conn-indicator').className = 'conn-indicator warning';
                break;
            case 'disconnected':
                document.getElementById('conn-status').textContent = 'Disconnected';
                document.getElementById('conn-indicator').className = 'conn-indicator disconnected';
                break;
            case 'failed':
                App.showError('Connection failed. The other device may have disconnected.');
                break;
        }
    },

    // === MESSAGES ===

    sendMessage() {
        const input = document.getElementById('msg-input');
        const text = input.value.trim();
        if (!text) return;
        if (Peer.sendMessage(text)) {
            App.displayMessage(text, 'local');
            input.value = '';
        }
    },

    displayMessage(text, origin) {
        const log = document.getElementById('message-log');
        const div = document.createElement('div');
        div.className = 'message ' + origin;
        div.textContent = text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    },

    // === FILES ===

    async sendFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        const status = document.getElementById('file-status');
        const progress = document.getElementById('file-progress');
        const fill = document.getElementById('file-progress-fill');

        progress.classList.remove('hidden');
        status.textContent = 'Sending ' + file.name + ' (' + App.formatBytes(file.size) + ')...';
        fill.style.width = '0%';

        try {
            await Peer.sendFile(file);
            status.textContent = 'Sent ' + file.name;
            fill.style.width = '100%';
        } catch (err) {
            status.textContent = 'Failed: ' + err.message;
            fill.style.width = '0%';
            setTimeout(() => progress.classList.add('hidden'), 3000);
        }

        event.target.value = '';
    },

    showFileIncoming(meta) {
        const progress = document.getElementById('file-progress');
        const status = document.getElementById('file-status');
        const fill = document.getElementById('file-progress-fill');
        progress.classList.remove('hidden');
        status.textContent = 'Receiving ' + meta.name + ' (' + App.formatBytes(meta.size) + ')...';
        fill.style.width = '0%';
    },

    updateFileProgress(received, total) {
        const pct = Math.round((received / total) * 100);
        document.getElementById('file-progress-fill').style.width = pct + '%';
    },

    showFileDownload(blob, name) {
        document.getElementById('file-status').textContent = 'Received ' + name;
        document.getElementById('file-progress-fill').style.width = '100%';

        const container = document.getElementById('received-files');
        const link = document.createElement('a');
        const blobUrl = URL.createObjectURL(blob);
        App._blobUrls.push(blobUrl);
        link.href = blobUrl;
        link.download = name;
        link.className = 'file-download';
        link.textContent = name + ' (' + App.formatBytes(blob.size) + ')';
        container.appendChild(link);
    },

    // === MEDIA ===

    async startMedia(video) {
        try {
            const stream = await Peer.startMedia(video);
            document.getElementById('local-video').srcObject = stream;
            document.getElementById('btn-start-video').classList.add('hidden');
            document.getElementById('btn-start-audio').classList.add('hidden');
            document.getElementById('btn-stop-media').classList.remove('hidden');
            document.getElementById('media-stats').classList.remove('hidden');
        } catch (err) {
            App.showError('Media failed: ' + err.message);
        }
    },

    stopMedia() {
        Peer.stopMedia();
        document.getElementById('local-video').srcObject = null;
        document.getElementById('remote-video').srcObject = null;
        document.getElementById('btn-start-video').classList.remove('hidden');
        document.getElementById('btn-start-audio').classList.remove('hidden');
        document.getElementById('btn-stop-media').classList.add('hidden');
        document.getElementById('media-stats').classList.add('hidden');
    },

    handleRemoteStream(stream) {
        document.getElementById('remote-video').srcObject = stream;
    },

    updateMediaStats(stats) {
        const set = (id, val) => { document.getElementById(id).textContent = val || '--'; };
        set('stat-resolution', stats.resolution);
        set('stat-framerate', stats.framerate !== '--' ? stats.framerate + ' fps' : '--');
        set('stat-video-bitrate', stats.videoBitrate);
        set('stat-audio-bitrate', stats.audioBitrate);
        set('stat-packets-lost', stats.packetsLost !== undefined ? stats.packetsLost : '--');
        set('stat-jitter', stats.jitter);
        set('stat-rtt', stats.rtt);
    },

    // === UTILITY ===

    switchTab(name) {
        document.querySelectorAll('.tab').forEach(t =>
            t.classList.toggle('active', t.dataset.tab === name));
        document.querySelectorAll('.tab-content').forEach(c =>
            c.classList.toggle('active', c.id === 'tab-' + name));
    },

    async cancelScan(returnState) {
        await QR.stopScanner();
        App.setState(returnState);
    },

    showError(msg) {
        document.getElementById('error-message').textContent = msg;
        App.setState('error');
    },

    reset() {
        QR.stopDisplay();
        QR.stopScanner();
        Peer.close();
        App.role = null;
        App._blobUrls.forEach(url => URL.revokeObjectURL(url));
        App._blobUrls = [];
        document.getElementById('message-log').innerHTML = '';
        document.getElementById('received-files').innerHTML = '';
        document.getElementById('speed-results').innerHTML = '';
        App.setState('home');
    },

    formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
