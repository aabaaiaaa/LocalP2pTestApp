// peer.js — Multi-peer mesh networking via WebRTC

// ─── PeerConnection class (one instance per remote peer) ───

class PeerConnection {
    constructor(peerId, callbacks) {
        this.peerId = peerId;
        this.callbacks = callbacks;

        this._pc = null;
        this._dc = null;
        this._incomingFile = null;
        this._speedTestActive = false;
        this._speedTestResolve = null;
        this._speedTestStart = 0;
        this._speedTestReceived = 0;
        this._speedTestExpected = 0;
        this._localStream = null;
        this._statsInterval = null;
        this._heartbeatInterval = null;
        this._lastPeerHeartbeat = 0;
        this._heartbeatState = 'connected';
        this._renegotiating = false;
        this._everConnected = false;
        this._iceDisconnectTimer = null;

        // Traffic counters
        this._messagesSent = 0;
        this._messagesReceived = 0;
        this._bytesSent = 0;
        this._bytesReceived = 0;

        // Extensible message handlers (type -> callback)
        this._messageHandlers = new Map();

        // Secondary data channel handlers (label -> callback)
        this._dataChannelHandlers = new Map();

        // Remote peer info (set after introduce handshake)
        this.remoteName = null;
    }

    // === EXTENSIBILITY ===

    registerHandler(type, callback) {
        this._messageHandlers.set(type, callback);
    }

    registerDataChannelHandler(label, callback) {
        this._dataChannelHandlers.set(label, callback);
    }

    createDataChannel(label, options) {
        if (!this._pc) throw new Error('No peer connection');
        const dc = this._pc.createDataChannel(label, options);
        dc.binaryType = 'arraybuffer';
        return dc;
    }

    getRTCPeerConnection() {
        return this._pc;
    }

    getDataChannel() {
        return this._dc;
    }

    // === CONNECTION SETUP ===

    _createConnection() {
        const pc = new RTCPeerConnection({ iceServers: PeerManager._iceServers || [] });

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;

            if (state === 'connected' || state === 'completed') {
                // ICE succeeded — dc.onopen is the authoritative 'connected' signal.
                // Clear any pending disconnect timer so it doesn't fire spuriously.
                if (this._iceDisconnectTimer) {
                    clearTimeout(this._iceDisconnectTimer);
                    this._iceDisconnectTimer = null;
                }
            } else if (state === 'disconnected' && !this._everConnected) {
                // ICE 'disconnected' before the data channel ever opened.
                // This can be transient — give it 10 s to recover before surfacing
                // a failure.  Post-connection drops are handled by dc.onclose.
                if (!this._iceDisconnectTimer) {
                    this._iceDisconnectTimer = setTimeout(() => {
                        this._iceDisconnectTimer = null;
                        if (!this._everConnected && this._pc) {
                            this.callbacks.onError(this.peerId, new Error('ICE connection timed out'));
                        }
                    }, 10000);
                }
            } else if (state === 'failed') {
                // Terminal failure — surface immediately.
                if (this._iceDisconnectTimer) {
                    clearTimeout(this._iceDisconnectTimer);
                    this._iceDisconnectTimer = null;
                }
                if (!this._everConnected) {
                    this.callbacks.onError(this.peerId, new Error('ICE connection failed'));
                }
            }
        };

        pc.ontrack = (event) => {
            if (event.streams[0]) {
                this.callbacks.onRemoteStream(this.peerId, event.streams[0]);
            }
        };

        this._pc = pc;
        return pc;
    }

    // === OFFERER ===

    async createOffer() {
        const pc = this._createConnection();
        const dc = pc.createDataChannel('messages', { ordered: true });
        this._setupDataChannel(dc);
        this._dc = dc;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this._waitForIce(pc);

        return pc.localDescription;
    }

    async processAnswer(sdp) {
        await this._pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    }

    // === JOINER ===

    async processOfferAndCreateAnswer(sdp) {
        const pc = this._createConnection();

        pc.ondatachannel = (event) => {
            const ch = event.channel;
            if (ch.label === 'messages') {
                this._dc = ch;
                this._setupDataChannel(ch);
            } else {
                ch.binaryType = 'arraybuffer';
                const handler = this._dataChannelHandlers.get(ch.label);
                if (handler) {
                    handler(ch);
                } else if (PeerManager.onDataChannel) {
                    PeerManager.onDataChannel(this.peerId, ch);
                }
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this._waitForIce(pc);

        return pc.localDescription;
    }

    // === ICE ===

    _waitForIce(pc) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }

            const timeout = setTimeout(() => {
                console.warn('ICE gathering timed out, using partial candidates');
                resolve();
            }, 5000);

            pc.onicecandidate = (event) => {
                if (event.candidate === null) {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });
    }

    // === DATA CHANNEL ===

    _setupDataChannel(dc) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            this._everConnected = true;
            // Data channel opened — clear any pending ICE disconnect timer.
            if (this._iceDisconnectTimer) {
                clearTimeout(this._iceDisconnectTimer);
                this._iceDisconnectTimer = null;
            }
            this.callbacks.onStateChange(this.peerId, 'connected');
            this._setupRenegotiation();
            this._startHeartbeat();
            // Send introduce message
            this._send(JSON.stringify({
                type: 'introduce',
                peerId: PeerManager._localId,
                name: PeerManager._localName
            }));
        };

        dc.onclose = () => {
            this._stopHeartbeat();
            this.callbacks.onStateChange(this.peerId, 'disconnected');
        };

        dc.onerror = (err) => {
            this.callbacks.onError(this.peerId, err);
        };

        dc.onmessage = (event) => this._handleMessage(event);
    }

    _handleMessage(event) {
        if (typeof event.data === 'string') {
            this._messagesReceived++;
            this._bytesReceived += event.data.length;

            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                console.warn('Received malformed message:', e);
                return;
            }
            switch (msg.type) {
                case 'text':
                    this.callbacks.onMessage(this.peerId, msg.data);
                    break;
                case 'typing':
                    this.callbacks.onTyping(this.peerId, msg.isTyping);
                    break;
                case 'introduce':
                    PeerManager._handleIntroduce(this.peerId, msg.peerId, msg.name);
                    break;
                case 'peer-list':
                    PeerManager._handlePeerList(this.peerId, msg.peers);
                    break;
                case 'relay-offer':
                    PeerManager._handleRelayOffer(this.peerId, msg);
                    break;
                case 'relay-answer':
                    PeerManager._handleRelayAnswer(this.peerId, msg);
                    break;
                case 'file-meta':
                    this._incomingFile = { name: msg.name, size: msg.size, mimeType: msg.mimeType, chunks: [], received: 0 };
                    this.callbacks.onFileMetadata(this.peerId, msg);
                    break;
                case 'file-end':
                    if (this._incomingFile) {
                        const blob = new Blob(this._incomingFile.chunks, { type: this._incomingFile.mimeType });
                        this.callbacks.onFileComplete(this.peerId, blob, this._incomingFile.name);
                        this._incomingFile = null;
                    }
                    break;
                case 'ping':
                    this._send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: msg.timestamp }));
                    break;
                case 'pong':
                    this.callbacks.onPong(this.peerId, msg);
                    break;
                case 'speed-start':
                    this._speedTestActive = true;
                    this._speedTestReceived = 0;
                    this._speedTestExpected = msg.size;
                    this._speedTestStart = performance.now();
                    break;
                case 'speed-end':
                    this._speedTestActive = false;
                    if (this.callbacks.onSpeedEnd) {
                        const elapsed = performance.now() - this._speedTestStart;
                        this.callbacks.onSpeedEnd(this.peerId, { bytes: this._speedTestReceived, ms: elapsed });
                    }
                    break;
                case 'heartbeat':
                    this._send(JSON.stringify({ type: 'heartbeat-ack' }));
                    break;
                case 'heartbeat-ack':
                    this._lastPeerHeartbeat = Date.now();
                    break;
                case 'renegotiate-offer':
                    this._handleRenegotiateOffer(msg.sdp);
                    break;
                case 'renegotiate-answer':
                    this._handleRenegotiateAnswer(msg.sdp);
                    break;
                case 'goodbye':
                    this.callbacks.onGoodbye(this.peerId);
                    break;
                default: {
                    const handler = this._messageHandlers.get(msg.type);
                    if (handler) {
                        handler(this.peerId, msg);
                    } else {
                        console.warn('Unhandled message type:', msg.type);
                    }
                    break;
                }
            }
        } else {
            // ArrayBuffer — file chunk or speed test data
            this._bytesReceived += event.data.byteLength;

            if (this._speedTestActive) {
                this._speedTestReceived += event.data.byteLength;
                if (this.callbacks.onSpeedData) {
                    this.callbacks.onSpeedData(this.peerId, this._speedTestReceived, this._speedTestExpected);
                }
            } else if (this._incomingFile) {
                this._incomingFile.chunks.push(event.data);
                this._incomingFile.received += event.data.byteLength;
                this.callbacks.onFileChunk(this.peerId, event.data, this._incomingFile.received, this._incomingFile.size);
            }
        }
    }

    _send(data) {
        if (this._dc && this._dc.readyState === 'open') {
            this._dc.send(data);
            this._messagesSent++;
            this._bytesSent += (typeof data === 'string') ? data.length : data.byteLength;
            return true;
        }
        return false;
    }

    sendMessage(text) {
        return this._send(JSON.stringify({ type: 'text', data: text }));
    }

    sendTyping(isTyping) {
        return this._send(JSON.stringify({ type: 'typing', isTyping }));
    }

    sendPing(id) {
        return this._send(JSON.stringify({ type: 'ping', id, timestamp: performance.now() }));
    }

    // === FILE TRANSFER ===

    async sendFile(file) {
        if (!this._dc || this._dc.readyState !== 'open') throw new Error('Not connected');

        if (!this._send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' }))) {
            throw new Error('Failed to send file metadata — channel closed');
        }

        const buffer = await file.arrayBuffer();
        await this._sendBuffer(buffer);

        if (!this._send(JSON.stringify({ type: 'file-end' }))) {
            throw new Error('Failed to send file-end marker — channel closed');
        }
    }

    // === SPEED TEST ===

    async sendSpeedTest(sizeBytes) {
        if (!this._dc || this._dc.readyState !== 'open') throw new Error('Not connected');

        if (!this._send(JSON.stringify({ type: 'speed-start', size: sizeBytes }))) {
            throw new Error('Failed to start speed test — channel closed');
        }

        const buffer = new ArrayBuffer(sizeBytes);
        const view = new Uint32Array(buffer);
        for (let i = 0; i < view.length; i++) view[i] = (Math.random() * 0xFFFFFFFF) >>> 0;

        const start = performance.now();
        await this._sendBuffer(buffer);
        const elapsed = performance.now() - start;

        this._send(JSON.stringify({ type: 'speed-end' }));

        return { bytes: sizeBytes, ms: elapsed };
    }

    async sendSustainedTest(durationMs) {
        if (!this._dc || this._dc.readyState !== 'open') throw new Error('Not connected');

        const chunkSize = 64 * 1024;
        const chunk = new ArrayBuffer(chunkSize);
        const view = new Uint32Array(chunk);
        for (let i = 0; i < view.length; i++) view[i] = (Math.random() * 0xFFFFFFFF) >>> 0;

        this._send(JSON.stringify({ type: 'speed-start', size: -1 }));

        const start = performance.now();
        let totalSent = 0;
        const dc = this._dc;

        while (performance.now() - start < durationMs) {
            if (dc.bufferedAmount > 65536) {
                await new Promise(r => {
                    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
                    dc.bufferedAmountLowThreshold = 16384;
                });
            }
            dc.send(chunk);
            totalSent += chunkSize;
            this._bytesSent += chunkSize;
        }

        const elapsed = performance.now() - start;
        this._send(JSON.stringify({ type: 'speed-end' }));

        return { bytes: totalSent, ms: elapsed };
    }

    // === SHARED BUFFER SENDING WITH BACKPRESSURE ===

    _sendBuffer(buffer) {
        return new Promise((resolve, reject) => {
            const dc = this._dc;
            const CHUNK_SIZE = 16384;
            let offset = 0;

            const onClose = () => {
                cleanup();
                reject(new Error('Data channel closed during transfer'));
            };

            const cleanup = () => {
                dc.removeEventListener('close', onClose);
                dc.onbufferedamountlow = null;
            };

            dc.addEventListener('close', onClose);

            const sendChunks = () => {
                try {
                    while (offset < buffer.byteLength) {
                        if (dc.readyState !== 'open') {
                            cleanup();
                            reject(new Error('Data channel closed during transfer'));
                            return;
                        }
                        if (dc.bufferedAmount > 65536) {
                            dc.onbufferedamountlow = () => {
                                dc.onbufferedamountlow = null;
                                sendChunks();
                            };
                            dc.bufferedAmountLowThreshold = 16384;
                            return;
                        }
                        const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
                        const slice = buffer.slice(offset, end);
                        dc.send(slice);
                        this._bytesSent += slice.byteLength;
                        offset = end;
                    }
                    cleanup();
                    resolve();
                } catch (err) {
                    cleanup();
                    reject(err);
                }
            };

            sendChunks();
        });
    }

    // === MEDIA RENEGOTIATION OVER DATA CHANNEL ===

    _setupRenegotiation() {
        if (!this._pc) return;
        this._pc.onnegotiationneeded = async () => {
            if (this._renegotiating) return;
            this._renegotiating = true;
            try {
                const offer = await this._pc.createOffer();
                await this._pc.setLocalDescription(offer);
                this._send(JSON.stringify({ type: 'renegotiate-offer', sdp: this._pc.localDescription.sdp }));
            } catch (err) {
                console.error('Renegotiation offer failed:', err);
                this._renegotiating = false;
            }
        };
    }

    async _handleRenegotiateOffer(sdp) {
        try {
            await this._pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            const answer = await this._pc.createAnswer();
            await this._pc.setLocalDescription(answer);
            this._send(JSON.stringify({ type: 'renegotiate-answer', sdp: this._pc.localDescription.sdp }));
        } catch (err) {
            console.error('Renegotiation answer failed:', err);
        }
    }

    async _handleRenegotiateAnswer(sdp) {
        try {
            await this._pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        } catch (err) {
            console.error('Set renegotiation answer failed:', err);
        }
        this._renegotiating = false;
    }

    // === MEDIA ===

    async startMedia(constraints) {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this._localStream = stream;

        for (const track of stream.getTracks()) {
            this._pc.addTrack(track, stream);
        }

        this._startStatsPolling();
        return stream;
    }

    stopMedia() {
        // Only stop local tracks and remove senders — leave stats polling
        // running so inbound-rtp stats (remote stream) keep updating.
        if (this._localStream) {
            for (const track of this._localStream.getTracks()) {
                track.stop();
            }
            this._localStream = null;
        }

        if (this._pc) {
            for (const sender of this._pc.getSenders()) {
                if (sender.track) {
                    this._pc.removeTrack(sender);
                }
            }
        }
    }

    ensureStatsPolling() {
        if (!this._statsInterval) this._startStatsPolling();
    }

    _startStatsPolling() {
        let prevStats = {};

        this._statsInterval = setInterval(async () => {
            if (!this._pc) return;
            const stats = await this._pc.getStats();
            const result = {};

            stats.forEach((report) => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    result.resolution = (report.frameWidth || '--') + 'x' + (report.frameHeight || '--');
                    result.framerate = report.framesPerSecond || '--';
                    result.packetsLost = report.packetsLost || 0;
                    result.jitter = report.jitter ? (report.jitter * 1000).toFixed(1) + ' ms' : '--';

                    const prev = prevStats['video'];
                    if (prev && report.bytesReceived) {
                        const dt = (report.timestamp - prev.timestamp) / 1000;
                        const db = report.bytesReceived - prev.bytesReceived;
                        result.videoBitrate = ((db * 8) / dt / 1000).toFixed(0) + ' kbps';
                    }
                    prevStats['video'] = { bytesReceived: report.bytesReceived, timestamp: report.timestamp };
                }

                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    const prev = prevStats['audio'];
                    if (prev && report.bytesReceived) {
                        const dt = (report.timestamp - prev.timestamp) / 1000;
                        const db = report.bytesReceived - prev.bytesReceived;
                        result.audioBitrate = ((db * 8) / dt / 1000).toFixed(0) + ' kbps';
                    }
                    prevStats['audio'] = { bytesReceived: report.bytesReceived, timestamp: report.timestamp };
                }

                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    result.rtt = report.currentRoundTripTime
                        ? (report.currentRoundTripTime * 1000).toFixed(1) + ' ms'
                        : '--';
                }
            });

            this.callbacks.onMediaStats(this.peerId, result);
        }, 1000);
    }

    _stopStatsPolling() {
        if (this._statsInterval) {
            clearInterval(this._statsInterval);
            this._statsInterval = null;
        }
    }

    // === HEARTBEAT ===

    _startHeartbeat() {
        this._lastPeerHeartbeat = Date.now();
        this._heartbeatState = 'connected';

        this._heartbeatInterval = setInterval(() => {
            this._send(JSON.stringify({ type: 'heartbeat' }));

            const silent = Date.now() - this._lastPeerHeartbeat;
            const newState = silent > PeerManager.HEARTBEAT_TIMEOUT ? 'unresponsive' : 'connected';
            if (newState !== this._heartbeatState) {
                this._heartbeatState = newState;
                this.callbacks.onStateChange(this.peerId, newState);
            }
        }, PeerManager.HEARTBEAT_INTERVAL);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    // === CLEANUP ===

    close() {
        this._stopHeartbeat();
        if (this._iceDisconnectTimer) {
            clearTimeout(this._iceDisconnectTimer);
            this._iceDisconnectTimer = null;
        }
        this.stopMedia();
        if (this._dc) { this._dc.close(); this._dc = null; }
        if (this._pc) { this._pc.close(); this._pc = null; }
        this._incomingFile = null;
        this._speedTestActive = false;
        this._renegotiating = false;
        this._heartbeatState = 'connected';
    }

    getStats() {
        return {
            messagesSent: this._messagesSent,
            messagesReceived: this._messagesReceived,
            bytesSent: this._bytesSent,
            bytesReceived: this._bytesReceived,
            heartbeatState: this._heartbeatState
        };
    }
}


// ─── PeerManager singleton (manages all peer connections) ───

const PeerManager = {
    _connections: new Map(),
    _localId: null,
    _localName: null,
    _pendingConnections: new Map(), // tempId -> PeerConnection (before introduce)
    _iceServers: [],

    HEARTBEAT_INTERVAL: 3000,
    HEARTBEAT_TIMEOUT: 10000,

    _ADJECTIVES: [
        'Brave', 'Swift', 'Bold', 'Keen', 'Calm', 'Wild', 'Wise', 'Warm',
        'Cool', 'Fair', 'Glad', 'Pale', 'Dark', 'Soft', 'Loud', 'True'
    ],
    _ANIMALS: [
        'Fox', 'Owl', 'Bear', 'Deer', 'Hawk', 'Wolf', 'Lynx', 'Hare',
        'Crow', 'Dove', 'Seal', 'Moth', 'Wren', 'Newt', 'Frog', 'Swan'
    ],

    // Callbacks (set by app.js)
    onMessage: null,
    onFileMetadata: null,
    onFileChunk: null,
    onFileComplete: null,
    onStateChange: null,
    onError: null,
    onPong: null,
    onSpeedData: null,
    onSpeedEnd: null,
    onRemoteStream: null,
    onMediaStats: null,
    onTyping: null,
    onPeerJoined: null,
    onPeerLeft: null,
    onGoodbye: null,
    onDataChannel: null,

    init(name, savedId, savedName) {
        PeerManager._localId = savedId || PeerManager._generateId();
        PeerManager._localName = savedName || name || PeerManager._generateName();
        console.log('PeerManager init:', PeerManager._localId, PeerManager._localName);
    },

    _generateId() {
        return Math.random().toString(36).slice(2, 6);
    },

    _generateName() {
        const adj = PeerManager._ADJECTIVES[Math.floor(Math.random() * PeerManager._ADJECTIVES.length)];
        const animal = PeerManager._ANIMALS[Math.floor(Math.random() * PeerManager._ANIMALS.length)];
        return adj + ' ' + animal;
    },

    getPreviewName() {
        // Returns what the auto-generated name would be (for placeholder display)
        return PeerManager._localName || PeerManager._generateName();
    },

    _createCallbackProxy() {
        return {
            onMessage: (peerId, text) => { if (PeerManager.onMessage) PeerManager.onMessage(peerId, text); },
            onFileMetadata: (peerId, meta) => { if (PeerManager.onFileMetadata) PeerManager.onFileMetadata(peerId, meta); },
            onFileChunk: (peerId, chunk, received, total) => { if (PeerManager.onFileChunk) PeerManager.onFileChunk(peerId, chunk, received, total); },
            onFileComplete: (peerId, blob, name) => { if (PeerManager.onFileComplete) PeerManager.onFileComplete(peerId, blob, name); },
            onStateChange: (peerId, state) => { if (PeerManager.onStateChange) PeerManager.onStateChange(peerId, state); },
            onError: (peerId, err) => { if (PeerManager.onError) PeerManager.onError(peerId, err); },
            onPong: (peerId, msg) => { if (PeerManager.onPong) PeerManager.onPong(peerId, msg); },
            onSpeedData: (peerId, received, expected) => { if (PeerManager.onSpeedData) PeerManager.onSpeedData(peerId, received, expected); },
            onSpeedEnd: (peerId, result) => { if (PeerManager.onSpeedEnd) PeerManager.onSpeedEnd(peerId, result); },
            onRemoteStream: (peerId, stream) => { if (PeerManager.onRemoteStream) PeerManager.onRemoteStream(peerId, stream); },
            onMediaStats: (peerId, stats) => { if (PeerManager.onMediaStats) PeerManager.onMediaStats(peerId, stats); },
            onTyping: (peerId, isTyping) => { if (PeerManager.onTyping) PeerManager.onTyping(peerId, isTyping); },
            onGoodbye: (peerId) => { if (PeerManager.onGoodbye) PeerManager.onGoodbye(peerId); },
        };
    },

    // === OFFER/ANSWER (initial QR-based connection) ===

    async createOffer() {
        const tempId = 'temp-' + PeerManager._generateId();
        const conn = new PeerConnection(tempId, PeerManager._createCallbackProxy());
        PeerManager._pendingConnections.set(tempId, conn);

        const desc = await conn.createOffer();
        return { connId: tempId, desc };
    },

    async processAnswer(connId, sdp) {
        const conn = PeerManager._pendingConnections.get(connId);
        if (!conn) throw new Error('No pending connection for ' + connId);
        await conn.processAnswer(sdp);
    },

    async processOfferAndCreateAnswer(sdp) {
        const tempId = 'temp-' + PeerManager._generateId();
        const conn = new PeerConnection(tempId, PeerManager._createCallbackProxy());
        PeerManager._pendingConnections.set(tempId, conn);

        const desc = await conn.processOfferAndCreateAnswer(sdp);
        return { connId: tempId, desc };
    },

    // === INTRODUCE HANDSHAKE ===

    _handleIntroduce(tempId, realPeerId, name) {
        // Find the connection — could be in pending or connections
        let conn = PeerManager._pendingConnections.get(tempId);
        if (!conn) conn = PeerManager._connections.get(tempId);
        if (!conn) {
            console.warn('Introduce from unknown connection:', tempId);
            return;
        }

        // Re-key from temp ID to real peer ID
        PeerManager._pendingConnections.delete(tempId);
        PeerManager._connections.delete(tempId);

        // Duplicate connection prevention: if we already have a connection to this peer
        if (PeerManager._connections.has(realPeerId)) {
            // Peer with lexicographically smaller ID is the offerer; other drops
            if (PeerManager._localId < realPeerId) {
                // We should be the offerer — keep our existing connection, close new one
                conn.close();
                return;
            } else {
                // They should be the offerer — close our old, keep new
                const old = PeerManager._connections.get(realPeerId);
                old.close();
            }
        }

        conn.peerId = realPeerId;
        conn.remoteName = name;
        PeerManager._connections.set(realPeerId, conn);

        if (PeerManager.onPeerJoined) PeerManager.onPeerJoined(realPeerId, name);

        // Send peer list to the new peer (for mesh joining)
        const peers = [];
        for (const [id, c] of PeerManager._connections) {
            if (id !== realPeerId && c.remoteName) {
                peers.push({ peerId: id, name: c.remoteName });
            }
        }
        if (peers.length > 0) {
            conn._send(JSON.stringify({ type: 'peer-list', peers }));
        }
    },

    // === RELAY-BASED MESH JOINING ===

    async _handlePeerList(fromPeerId, peers) {
        for (const peer of peers) {
            if (PeerManager._connections.has(peer.peerId)) continue; // Already connected
            if (peer.peerId === PeerManager._localId) continue; // That's us

            // We (the new joiner) always initiate since the existing peer
            // doesn't know about us yet. Duplicate prevention in _handleIntroduce
            // handles the rare case where both sides try simultaneously.

            // Create an offer for this peer and relay through fromPeerId
            const tempId = 'relay-' + PeerManager._generateId();
            const conn = new PeerConnection(tempId, PeerManager._createCallbackProxy());
            PeerManager._pendingConnections.set(tempId, conn);

            try {
                const desc = await conn.createOffer();
                // Send relay offer through the peer that told us about the target
                const relay = PeerManager._connections.get(fromPeerId);
                if (relay) {
                    relay._send(JSON.stringify({
                        type: 'relay-offer',
                        targetPeerId: peer.peerId,
                        fromPeerId: PeerManager._localId,
                        fromName: PeerManager._localName,
                        sdp: desc.sdp
                    }));
                }
            } catch (err) {
                console.error('Failed to create relay offer for', peer.peerId, err);
                PeerManager._pendingConnections.delete(tempId);
                conn.close();
            }
        }
    },

    _handleRelayOffer(viaPeerId, msg) {
        if (msg.targetPeerId === PeerManager._localId) {
            // This relay offer is for us
            PeerManager._processRelayOffer(viaPeerId, msg);
        } else {
            // Forward to the target peer
            const target = PeerManager._connections.get(msg.targetPeerId);
            if (target) {
                target._send(JSON.stringify(msg));
            }
        }
    },

    async _processRelayOffer(viaPeerId, msg) {
        // Duplicate connection prevention
        if (PeerManager._connections.has(msg.fromPeerId)) return;

        const tempId = 'relay-' + PeerManager._generateId();
        const conn = new PeerConnection(tempId, PeerManager._createCallbackProxy());
        PeerManager._pendingConnections.set(tempId, conn);

        try {
            const desc = await conn.processOfferAndCreateAnswer(msg.sdp);
            // Send answer back via the relay peer
            const relay = PeerManager._connections.get(viaPeerId);
            if (relay) {
                relay._send(JSON.stringify({
                    type: 'relay-answer',
                    targetPeerId: msg.fromPeerId,
                    fromPeerId: PeerManager._localId,
                    sdp: desc.sdp
                }));
            }
        } catch (err) {
            console.error('Failed to process relay offer from', msg.fromPeerId, err);
            PeerManager._pendingConnections.delete(tempId);
            conn.close();
        }
    },

    _handleRelayAnswer(viaPeerId, msg) {
        if (msg.targetPeerId === PeerManager._localId) {
            // This relay answer is for us — find matching pending connection
            for (const [tempId, conn] of PeerManager._pendingConnections) {
                if (tempId.startsWith('relay-') && conn._pc &&
                    conn._pc.signalingState === 'have-local-offer') {
                    conn.processAnswer(msg.sdp).catch(err => {
                        console.error('Failed to process relay answer:', err);
                    });
                    return;
                }
            }
            console.warn('No pending relay connection for answer from', msg.fromPeerId);
        } else {
            // Forward to the target peer
            const target = PeerManager._connections.get(msg.targetPeerId);
            if (target) {
                target._send(JSON.stringify(msg));
            }
        }
    },

    // === BROADCAST ===

    broadcastMessage(text) {
        let sent = false;
        for (const conn of PeerManager._connections.values()) {
            if (conn.sendMessage(text)) sent = true;
        }
        return sent;
    },

    broadcastTyping(isTyping) {
        for (const conn of PeerManager._connections.values()) {
            conn.sendTyping(isTyping);
        }
    },

    broadcastGoodbye() {
        const data = JSON.stringify({ type: 'goodbye' });
        for (const conn of PeerManager._connections.values()) {
            conn._send(data);
        }
    },

    // === TARGETED OPERATIONS ===

    get(peerId) {
        return PeerManager._connections.get(peerId) || null;
    },

    getConnectedPeers() {
        const peers = [];
        for (const [id, conn] of PeerManager._connections) {
            peers.push({
                peerId: id,
                name: conn.remoteName || id,
                state: conn._heartbeatState,
                stats: conn.getStats()
            });
        }
        return peers;
    },

    sendFile(peerId, file) {
        const conn = PeerManager._connections.get(peerId);
        if (!conn) throw new Error('Peer not found: ' + peerId);
        return conn.sendFile(file);
    },

    sendSpeedTest(peerId, size) {
        const conn = PeerManager._connections.get(peerId);
        if (!conn) throw new Error('Peer not found: ' + peerId);
        return conn.sendSpeedTest(size);
    },

    sendPing(peerId, id) {
        const conn = PeerManager._connections.get(peerId);
        if (!conn) throw new Error('Peer not found: ' + peerId);
        return conn.sendPing(id);
    },

    startMedia(peerId, constraints) {
        const conn = PeerManager._connections.get(peerId);
        if (!conn) throw new Error('Peer not found: ' + peerId);
        return conn.startMedia(constraints);
    },

    stopMedia(peerId) {
        const conn = PeerManager._connections.get(peerId);
        if (!conn) throw new Error('Peer not found: ' + peerId);
        conn.stopMedia();
    },

    setIceServers(servers) {
        PeerManager._iceServers = servers || [];
    },

    // Send a raw JSON message to a specific peer
    sendRaw(peerId, msg) {
        const conn = PeerManager._connections.get(peerId);
        if (!conn) return false;
        return conn._send(JSON.stringify(msg));
    },

    // Broadcast a raw JSON message to all peers
    broadcastRaw(msg) {
        const data = JSON.stringify(msg);
        for (const conn of PeerManager._connections.values()) {
            conn._send(data);
        }
    },

    // === CLEANUP ===

    closeOne(peerId) {
        const conn = PeerManager._connections.get(peerId);
        if (conn) {
            conn.close();
            PeerManager._connections.delete(peerId);
            if (PeerManager.onPeerLeft) PeerManager.onPeerLeft(peerId);
        }
    },

    closeAll() {
        for (const [, conn] of PeerManager._connections) {
            conn.close();
        }
        PeerManager._connections.clear();

        for (const [, conn] of PeerManager._pendingConnections) {
            conn.close();
        }
        PeerManager._pendingConnections.clear();
    }
};
