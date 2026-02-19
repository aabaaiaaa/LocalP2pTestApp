// app.js — Main application orchestrator (multi-peer mesh)

const App = {
    role: null,
    _blobUrls: [],
    _typingPeers: new Map(),    // peerId -> typing state
    _typingTimeout: null,       // local typing debounce
    _isTyping: false,
    _currentConnId: null,
    _currentModalConnId: null,
    _networkStatsInterval: null,
    _peerNames: new Map(),      // peerId -> name

    init() {
        // Generate preview name
        PeerManager.init('');
        document.getElementById('name-preview').textContent =
            'Default: ' + PeerManager._localName;

        document.getElementById('device-name').addEventListener('input', (e) => {
            if (e.target.value.trim()) {
                document.getElementById('name-preview').textContent = '';
            } else {
                document.getElementById('name-preview').textContent =
                    'Default: ' + PeerManager._localName;
            }
        });

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

        // Typing indicator
        document.getElementById('msg-input').addEventListener('input', () => App._handleTypingInput());

        // Connected — files
        document.getElementById('file-input').addEventListener('change', (e) => App.sendFile(e));

        // Connected — speed test
        document.getElementById('btn-quick-test').addEventListener('click', () => {
            const peerId = App._getSelectedPeer('speed-peer-select');
            if (peerId && !SpeedTest._running) SpeedTest.runQuick(peerId);
        });
        document.getElementById('btn-full-test').addEventListener('click', () => {
            const peerId = App._getSelectedPeer('speed-peer-select');
            if (peerId && !SpeedTest._running) SpeedTest.runFull(peerId);
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

        // Add Peer modal
        document.getElementById('btn-add-peer').addEventListener('click', () => App.openAddPeerModal());
        document.getElementById('btn-close-modal').addEventListener('click', () => App.closeAddPeerModal());
        document.getElementById('modal-btn-create').addEventListener('click', () => App.modalCreateOffer());
        document.getElementById('modal-btn-join').addEventListener('click', () => App.modalScanOffer());
        document.getElementById('modal-btn-scan-answer').addEventListener('click', () => App.modalScanAnswer());
        document.getElementById('modal-btn-cancel-scan').addEventListener('click', () => App.modalCancelScan());
        document.getElementById('modal-btn-cancel-scan-answer').addEventListener('click', () => App.modalCancelScanAnswer());

        // Wire PeerManager callbacks
        PeerManager.onMessage = (peerId, text) => App.displayMessage(peerId, text, 'remote');
        PeerManager.onFileMetadata = (peerId, meta) => App.showFileIncoming(peerId, meta);
        PeerManager.onFileChunk = (peerId, chunk, received, total) => App.updateFileProgress(received, total);
        PeerManager.onFileComplete = (peerId, blob, name) => App.showFileDownload(blob, name);
        PeerManager.onStateChange = (peerId, state) => App.handleConnectionState(peerId, state);
        PeerManager.onError = (peerId, err) => console.error('Peer', peerId, 'error:', err.message || err);
        PeerManager.onPong = (peerId, msg) => SpeedTest.handlePong(peerId, msg);
        PeerManager.onRemoteStream = (peerId, stream) => App.handleRemoteStream(peerId, stream);
        PeerManager.onMediaStats = (peerId, stats) => App.updateMediaStats(stats);
        PeerManager.onTyping = (peerId, isTyping) => App.showTypingIndicator(peerId, isTyping);
        PeerManager.onPeerJoined = (peerId, name) => App.handlePeerJoined(peerId, name);
        PeerManager.onPeerLeft = (peerId) => App.handlePeerLeft(peerId);
    },

    _initPeerManager() {
        const nameInput = document.getElementById('device-name');
        const name = nameInput ? nameInput.value.trim() : '';
        PeerManager.init(name);
    },

    setState(state) {
        document.body.dataset.state = state;
    },

    // === OFFERER FLOW ===

    async startAsOfferer() {
        App.role = 'offerer';
        App._initPeerManager();
        App.setState('creating-offer');

        try {
            const { connId, desc } = await PeerManager.createOffer();
            App._currentConnId = connId;
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
            await PeerManager.processAnswer(App._currentConnId, sdp);
        } catch (err) {
            App.showError('Failed to scan answer: ' + err.message);
        }
    },

    // === JOINER FLOW ===

    async startAsJoiner() {
        App.role = 'joiner';
        App._initPeerManager();
        App.setState('scan-offer');

        try {
            const data = await QR.scan('scanner-offer');
            App.setState('creating-answer');
            const { sdp } = Signal.decode(data);
            const { connId, desc } = await PeerManager.processOfferAndCreateAnswer(sdp);
            App._currentConnId = connId;
            const encoded = Signal.encode(desc);
            console.log('Answer encoded:', encoded.length, 'chars');
            QR.generate('qr-answer', encoded);
            App.setState('show-answer-qr');
        } catch (err) {
            App.showError('Failed to process offer: ' + err.message);
        }
    },

    // === CONNECTION STATE ===

    handleConnectionState(peerId, state) {
        switch (state) {
            case 'connected':
                App.setState('connected');
                App._updatePeerChip(peerId, 'connected');
                App._updatePeerSelects();
                App._startNetworkStats();
                // Close add-peer modal if open and this connection succeeded
                if (!document.getElementById('add-peer-modal').classList.contains('hidden')) {
                    App.closeAddPeerModal();
                }
                break;
            case 'unresponsive':
                App._updatePeerChip(peerId, 'warning');
                break;
            case 'disconnected': {
                App._updatePeerChip(peerId, 'disconnected');
                // Clean up the connection
                const conn = PeerManager.get(peerId);
                if (conn) {
                    PeerManager.closeOne(peerId);
                }
                // Clear typing state for this peer
                App._clearTypingForPeer(peerId);
                App._updatePeerSelects();
                // If no peers left, show disconnected state
                if (PeerManager.getConnectedPeers().length === 0) {
                    App._stopNetworkStats();
                }
                break;
            }
            case 'failed':
                App._updatePeerChip(peerId, 'disconnected');
                break;
        }
    },

    handlePeerJoined(peerId, name) {
        App._peerNames.set(peerId, name);
        App._addPeerChip(peerId, name);
        App._updatePeerSelects();
        App.displaySystemMessage(name + ' joined');
    },

    handlePeerLeft(peerId) {
        const name = App._peerNames.get(peerId) || peerId;
        App._removePeerChip(peerId);
        App._peerNames.delete(peerId);
        App._clearTypingForPeer(peerId);
        App._updatePeerSelects();
        App.displaySystemMessage(name + ' left');
    },

    // === PEER LIST UI ===

    _addPeerChip(peerId, name) {
        const list = document.getElementById('peer-list');
        // Don't duplicate
        if (document.getElementById('peer-chip-' + peerId)) return;

        const chip = document.createElement('div');
        chip.className = 'peer-chip';
        chip.id = 'peer-chip-' + peerId;

        const indicator = document.createElement('span');
        indicator.className = 'conn-indicator';

        const label = document.createElement('span');
        label.textContent = name;

        chip.appendChild(indicator);
        chip.appendChild(label);
        list.appendChild(chip);
    },

    _updatePeerChip(peerId, state) {
        const chip = document.getElementById('peer-chip-' + peerId);
        if (!chip) return;
        const indicator = chip.querySelector('.conn-indicator');
        indicator.className = 'conn-indicator';
        if (state === 'warning') indicator.classList.add('warning');
        else if (state === 'disconnected') indicator.classList.add('disconnected');
    },

    _removePeerChip(peerId) {
        const chip = document.getElementById('peer-chip-' + peerId);
        if (chip) chip.remove();
    },

    _updatePeerSelects() {
        const peers = PeerManager.getConnectedPeers();
        const selects = ['file-peer-select', 'speed-peer-select', 'media-peer-select'];

        for (const selectId of selects) {
            const select = document.getElementById(selectId);
            const currentVal = select.value;
            select.innerHTML = '';

            for (const peer of peers) {
                const option = document.createElement('option');
                option.value = peer.peerId;
                option.textContent = peer.name;
                select.appendChild(option);
            }

            // Restore selection if still available
            if (currentVal && [...select.options].some(o => o.value === currentVal)) {
                select.value = currentVal;
            }
        }
    },

    _getSelectedPeer(selectId) {
        const select = document.getElementById(selectId);
        return select.value || null;
    },

    // === TYPING INDICATORS ===

    _handleTypingInput() {
        if (!App._isTyping) {
            App._isTyping = true;
            PeerManager.broadcastTyping(true);
        }

        if (App._typingTimeout) clearTimeout(App._typingTimeout);
        App._typingTimeout = setTimeout(() => {
            App._isTyping = false;
            PeerManager.broadcastTyping(false);
        }, 2000);
    },

    _clearLocalTyping() {
        if (App._typingTimeout) clearTimeout(App._typingTimeout);
        if (App._isTyping) {
            App._isTyping = false;
            PeerManager.broadcastTyping(false);
        }
    },

    showTypingIndicator(peerId, isTyping) {
        const el = document.getElementById('typing-indicator');
        if (isTyping) {
            App._typingPeers.set(peerId, true);
        } else {
            App._typingPeers.delete(peerId);
        }

        if (App._typingPeers.size === 0) {
            el.classList.add('hidden');
            el.innerHTML = '';
            return;
        }

        const names = [];
        for (const id of App._typingPeers.keys()) {
            names.push(App._peerNames.get(id) || id);
        }

        let text;
        if (names.length === 1) {
            text = names[0] + ' is typing';
        } else if (names.length === 2) {
            text = names[0] + ' and ' + names[1] + ' are typing';
        } else {
            text = names.length + ' people are typing';
        }

        el.innerHTML = text + '<span class="dots"></span>';
        el.classList.remove('hidden');
    },

    _clearTypingForPeer(peerId) {
        App._typingPeers.delete(peerId);
        App.showTypingIndicator(peerId, false);
    },

    // === MESSAGES ===

    sendMessage() {
        const input = document.getElementById('msg-input');
        const text = input.value.trim();
        if (!text) return;
        if (PeerManager.broadcastMessage(text)) {
            App.displayMessage(null, text, 'local');
            input.value = '';
            App._clearLocalTyping();
        }
    },

    displayMessage(peerId, text, origin) {
        const log = document.getElementById('message-log');

        if (origin === 'remote') {
            const group = document.createElement('div');
            group.className = 'message-group';

            const sender = document.createElement('div');
            sender.className = 'message-sender';
            sender.textContent = App._peerNames.get(peerId) || peerId;

            const msg = document.createElement('div');
            msg.className = 'message remote';
            msg.textContent = text;

            group.appendChild(sender);
            group.appendChild(msg);
            log.appendChild(group);
        } else {
            const div = document.createElement('div');
            div.className = 'message local';
            div.textContent = text;
            log.appendChild(div);
        }

        log.scrollTop = log.scrollHeight;
    },

    displaySystemMessage(text) {
        const log = document.getElementById('message-log');
        const div = document.createElement('div');
        div.className = 'message-sender';
        div.style.textAlign = 'center';
        div.style.alignSelf = 'center';
        div.style.padding = '4px 0';
        div.textContent = text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    },

    // === FILES ===

    async sendFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        const peerId = App._getSelectedPeer('file-peer-select');
        if (!peerId) {
            alert('No peer selected');
            return;
        }

        const status = document.getElementById('file-status');
        const progress = document.getElementById('file-progress');
        const fill = document.getElementById('file-progress-fill');

        progress.classList.remove('hidden');
        status.textContent = 'Sending ' + file.name + ' (' + App.formatBytes(file.size) + ')...';
        fill.style.width = '0%';

        try {
            await PeerManager.sendFile(peerId, file);
            status.textContent = 'Sent ' + file.name;
            fill.style.width = '100%';
        } catch (err) {
            status.textContent = 'Failed: ' + err.message;
            fill.style.width = '0%';
            setTimeout(() => progress.classList.add('hidden'), 3000);
        }

        event.target.value = '';
    },

    showFileIncoming(peerId, meta) {
        const senderName = App._peerNames.get(peerId) || peerId;
        const progress = document.getElementById('file-progress');
        const status = document.getElementById('file-status');
        const fill = document.getElementById('file-progress-fill');
        progress.classList.remove('hidden');
        status.textContent = 'Receiving ' + meta.name + ' from ' + senderName + ' (' + App.formatBytes(meta.size) + ')...';
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
        const peerId = App._getSelectedPeer('media-peer-select');
        if (!peerId) {
            alert('No peer selected');
            return;
        }

        try {
            const stream = await PeerManager.startMedia(peerId, video);
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
        const peerId = App._getSelectedPeer('media-peer-select');
        if (peerId) {
            try { PeerManager.stopMedia(peerId); } catch (e) { /* peer may be gone */ }
        }
        document.getElementById('local-video').srcObject = null;
        // Clear all remote videos
        document.getElementById('remote-videos').innerHTML = '';
        document.getElementById('btn-start-video').classList.remove('hidden');
        document.getElementById('btn-start-audio').classList.remove('hidden');
        document.getElementById('btn-stop-media').classList.add('hidden');
        document.getElementById('media-stats').classList.add('hidden');
    },

    handleRemoteStream(peerId, stream) {
        const container = document.getElementById('remote-videos');
        // Remove existing video for this peer if any
        const existing = document.getElementById('remote-video-' + peerId);
        if (existing) existing.remove();

        const wrapper = document.createElement('div');
        wrapper.className = 'video-wrapper';
        wrapper.id = 'remote-video-' + peerId;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;

        const label = document.createElement('span');
        label.className = 'video-label';
        label.textContent = App._peerNames.get(peerId) || 'Peer';

        wrapper.appendChild(video);
        wrapper.appendChild(label);
        container.appendChild(wrapper);
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

    // === ADD PEER MODAL ===

    openAddPeerModal() {
        const modal = document.getElementById('add-peer-modal');
        modal.classList.remove('hidden');
        App._showModalStep('modal-home');
    },

    closeAddPeerModal() {
        const modal = document.getElementById('add-peer-modal');
        modal.classList.add('hidden');
        QR.stopDisplay();
        QR.stopScanner();
        App._currentModalConnId = null;
    },

    _showModalStep(stepId) {
        document.querySelectorAll('.modal-step').forEach(s => s.classList.add('hidden'));
        document.getElementById(stepId).classList.remove('hidden');
    },

    async modalCreateOffer() {
        App._showModalStep('modal-creating');
        try {
            const { connId, desc } = await PeerManager.createOffer();
            App._currentModalConnId = connId;
            const encoded = Signal.encode(desc);
            QR.generate('modal-qr-offer', encoded);
            App._showModalStep('modal-show-offer');
        } catch (err) {
            console.error('Modal offer failed:', err);
            App.closeAddPeerModal();
        }
    },

    async modalScanOffer() {
        App._showModalStep('modal-scan-offer');
        try {
            const data = await QR.scan('modal-scanner-offer');
            App._showModalStep('modal-creating-answer');
            const { sdp } = Signal.decode(data);
            const { connId, desc } = await PeerManager.processOfferAndCreateAnswer(sdp);
            App._currentModalConnId = connId;
            const encoded = Signal.encode(desc);
            QR.generate('modal-qr-answer', encoded);
            App._showModalStep('modal-show-answer');
        } catch (err) {
            console.error('Modal scan offer failed:', err);
            App._showModalStep('modal-home');
        }
    },

    async modalScanAnswer() {
        QR.stopDisplay();
        App._showModalStep('modal-scan-answer');
        try {
            const data = await QR.scan('modal-scanner-answer');
            App._showModalStep('modal-connecting');
            const { sdp } = Signal.decode(data);
            await PeerManager.processAnswer(App._currentModalConnId, sdp);
        } catch (err) {
            console.error('Modal scan answer failed:', err);
            App._showModalStep('modal-home');
        }
    },

    modalCancelScan() {
        QR.stopScanner();
        App._showModalStep('modal-home');
    },

    modalCancelScanAnswer() {
        QR.stopScanner();
        App._showModalStep('modal-show-offer');
    },

    // === NETWORK TAB — MESH VISUALIZATION + TRAFFIC STATS ===

    _startNetworkStats() {
        if (App._networkStatsInterval) return;
        App._networkStatsInterval = setInterval(() => {
            App._drawMesh();
            App._updateTrafficTable();
        }, 1000);
        // Immediate draw
        App._drawMesh();
        App._updateTrafficTable();
    },

    _stopNetworkStats() {
        if (App._networkStatsInterval) {
            clearInterval(App._networkStatsInterval);
            App._networkStatsInterval = null;
        }
    },

    _drawMesh() {
        const canvas = document.getElementById('mesh-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        // Set canvas resolution
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const w = rect.width;
        const h = rect.height;

        ctx.clearRect(0, 0, w, h);

        const peers = PeerManager.getConnectedPeers();
        // All nodes: self + connected peers
        const nodes = [
            { id: PeerManager._localId, name: PeerManager._localName + ' (You)', state: 'connected' },
            ...peers.map(p => ({ id: p.peerId, name: p.name, state: p.state }))
        ];

        if (nodes.length < 2) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '14px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No peers connected', w / 2, h / 2);
            return;
        }

        // Position nodes in a circle
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) * 0.35;

        const positions = nodes.map((node, i) => {
            const angle = (2 * Math.PI * i / nodes.length) - Math.PI / 2;
            return {
                x: cx + radius * Math.cos(angle),
                y: cy + radius * Math.sin(angle),
                node
            };
        });

        // Draw connections (lines from self to each peer)
        const selfPos = positions[0];
        for (let i = 1; i < positions.length; i++) {
            const p = positions[i];
            ctx.beginPath();
            ctx.moveTo(selfPos.x, selfPos.y);
            ctx.lineTo(p.x, p.y);

            const state = p.node.state;
            if (state === 'connected') ctx.strokeStyle = '#22c55e';
            else if (state === 'unresponsive') ctx.strokeStyle = '#f59e0b';
            else ctx.strokeStyle = '#ef4444';

            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Draw inter-peer connections (all peers connect to each other in mesh)
        for (let i = 1; i < positions.length; i++) {
            for (let j = i + 1; j < positions.length; j++) {
                ctx.beginPath();
                ctx.moveTo(positions[i].x, positions[i].y);
                ctx.lineTo(positions[j].x, positions[j].y);
                ctx.strokeStyle = '#334155';
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Draw nodes
        for (const p of positions) {
            // Circle
            ctx.beginPath();
            ctx.arc(p.x, p.y, 20, 0, 2 * Math.PI);

            if (p.node.state === 'connected') ctx.fillStyle = '#1e293b';
            else ctx.fillStyle = '#334155';

            ctx.fill();

            // Border
            ctx.beginPath();
            ctx.arc(p.x, p.y, 20, 0, 2 * Math.PI);
            if (p.node.state === 'connected') ctx.strokeStyle = '#22c55e';
            else if (p.node.state === 'unresponsive') ctx.strokeStyle = '#f59e0b';
            else ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Label
            ctx.fillStyle = '#f1f5f9';
            ctx.font = '11px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(p.node.name, p.x, p.y + 34);
        }
    },

    _updateTrafficTable() {
        const tbody = document.getElementById('traffic-tbody');
        if (!tbody) return;

        const peers = PeerManager.getConnectedPeers();
        tbody.innerHTML = '';

        for (const peer of peers) {
            const tr = document.createElement('tr');

            const tdName = document.createElement('td');
            tdName.textContent = peer.name;

            const tdState = document.createElement('td');
            tdState.textContent = peer.state;
            tdState.className = 'state-' + peer.state;

            const tdMsgSent = document.createElement('td');
            tdMsgSent.textContent = peer.stats.messagesSent;

            const tdMsgRecv = document.createElement('td');
            tdMsgRecv.textContent = peer.stats.messagesReceived;

            const tdBytesSent = document.createElement('td');
            tdBytesSent.textContent = App.formatBytes(peer.stats.bytesSent);

            const tdBytesRecv = document.createElement('td');
            tdBytesRecv.textContent = App.formatBytes(peer.stats.bytesReceived);

            tr.appendChild(tdName);
            tr.appendChild(tdState);
            tr.appendChild(tdMsgSent);
            tr.appendChild(tdMsgRecv);
            tr.appendChild(tdBytesSent);
            tr.appendChild(tdBytesRecv);
            tbody.appendChild(tr);
        }
    },

    // === UTILITY ===

    switchTab(name) {
        document.querySelectorAll('.tab').forEach(t =>
            t.classList.toggle('active', t.dataset.tab === name));
        document.querySelectorAll('.tab-content').forEach(c =>
            c.classList.toggle('active', c.id === 'tab-' + name));

        // Redraw mesh when switching to network tab
        if (name === 'network') {
            App._drawMesh();
            App._updateTrafficTable();
        }
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
        PeerManager.closeAll();
        App.role = null;
        App._currentConnId = null;
        App._typingPeers.clear();
        App._peerNames.clear();
        App._clearLocalTyping();
        App._stopNetworkStats();
        App._blobUrls.forEach(url => URL.revokeObjectURL(url));
        App._blobUrls = [];
        document.getElementById('message-log').innerHTML = '';
        document.getElementById('received-files').innerHTML = '';
        document.getElementById('speed-results').innerHTML = '';
        document.getElementById('peer-list').innerHTML = '';
        document.getElementById('remote-videos').innerHTML = '';
        document.getElementById('typing-indicator').classList.add('hidden');
        document.getElementById('typing-indicator').innerHTML = '';
        App.setState('home');
    },

    formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
