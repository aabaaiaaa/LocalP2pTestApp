// peer.js — WebRTC peer connection lifecycle

const Peer = {
    _pc: null,
    _dc: null,
    _localStream: null,
    _statsInterval: null,
    _heartbeatInterval: null,
    _lastPeerHeartbeat: 0,
    _incomingFile: null,
    _speedTestActive: false,
    _speedTestResolve: null,
    _speedTestStart: 0,
    _speedTestReceived: 0,
    _speedTestExpected: 0,

    HEARTBEAT_INTERVAL: 3000,
    HEARTBEAT_TIMEOUT: 10000,

    // Callbacks set by app.js
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

    CHUNK_SIZE: 16384,

    _createConnection() {
        const pc = new RTCPeerConnection({ iceServers: [] });

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            if (Peer.onStateChange) Peer.onStateChange(state);
            if (state === 'failed') {
                if (Peer.onError) Peer.onError(new Error('Connection failed'));
            }
        };

        pc.ontrack = (event) => {
            if (Peer.onRemoteStream && event.streams[0]) {
                Peer.onRemoteStream(event.streams[0]);
            }
        };

        Peer._pc = pc;
        return pc;
    },

    // === OFFERER ===

    async createOffer() {
        const pc = Peer._createConnection();
        const dc = pc.createDataChannel('messages', { ordered: true });
        Peer._setupDataChannel(dc);
        Peer._dc = dc;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await Peer._waitForIce(pc);

        return pc.localDescription;
    },

    async processAnswer(sdp) {
        await Peer._pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    },

    // === JOINER ===

    async processOfferAndCreateAnswer(sdp) {
        const pc = Peer._createConnection();

        pc.ondatachannel = (event) => {
            Peer._dc = event.channel;
            Peer._setupDataChannel(event.channel);
        };

        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await Peer._waitForIce(pc);

        return pc.localDescription;
    },

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
    },

    // === DATA CHANNEL ===

    _setupDataChannel(dc) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            if (Peer.onStateChange) Peer.onStateChange('connected');
            Peer._setupRenegotiation();
            Peer._startHeartbeat();
        };

        dc.onclose = () => {
            Peer._stopHeartbeat();
            if (Peer.onStateChange) Peer.onStateChange('disconnected');
        };

        dc.onerror = (err) => {
            if (Peer.onError) Peer.onError(err);
        };

        dc.onmessage = (event) => Peer._handleMessage(event);
    },

    _handleMessage(event) {
        if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case 'text':
                    if (Peer.onMessage) Peer.onMessage(msg.data);
                    break;
                case 'file-meta':
                    Peer._incomingFile = { name: msg.name, size: msg.size, mimeType: msg.mimeType, chunks: [], received: 0 };
                    if (Peer.onFileMetadata) Peer.onFileMetadata(msg);
                    break;
                case 'file-end':
                    if (Peer._incomingFile) {
                        const blob = new Blob(Peer._incomingFile.chunks, { type: Peer._incomingFile.mimeType });
                        if (Peer.onFileComplete) Peer.onFileComplete(blob, Peer._incomingFile.name);
                        Peer._incomingFile = null;
                    }
                    break;
                case 'ping':
                    Peer._send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: msg.timestamp }));
                    break;
                case 'pong':
                    if (Peer.onPong) Peer.onPong(msg);
                    break;
                case 'speed-start':
                    Peer._speedTestActive = true;
                    Peer._speedTestReceived = 0;
                    Peer._speedTestExpected = msg.size;
                    Peer._speedTestStart = performance.now();
                    break;
                case 'speed-end':
                    Peer._speedTestActive = false;
                    if (Peer.onSpeedEnd) {
                        const elapsed = performance.now() - Peer._speedTestStart;
                        Peer.onSpeedEnd({ bytes: Peer._speedTestReceived, ms: elapsed });
                    }
                    break;
                case 'heartbeat':
                    Peer._send(JSON.stringify({ type: 'heartbeat-ack' }));
                    break;
                case 'heartbeat-ack':
                    Peer._lastPeerHeartbeat = Date.now();
                    break;
                case 'renegotiate-offer':
                    Peer._handleRenegotiateOffer(msg.sdp);
                    break;
                case 'renegotiate-answer':
                    Peer._handleRenegotiateAnswer(msg.sdp);
                    break;
            }
        } else {
            // ArrayBuffer — file chunk or speed test data
            if (Peer._speedTestActive) {
                Peer._speedTestReceived += event.data.byteLength;
                if (Peer.onSpeedData) Peer.onSpeedData(Peer._speedTestReceived, Peer._speedTestExpected);
            } else if (Peer._incomingFile) {
                Peer._incomingFile.chunks.push(event.data);
                Peer._incomingFile.received += event.data.byteLength;
                if (Peer.onFileChunk) Peer.onFileChunk(event.data, Peer._incomingFile.received, Peer._incomingFile.size);
            }
        }
    },

    _send(data) {
        if (Peer._dc && Peer._dc.readyState === 'open') {
            Peer._dc.send(data);
            return true;
        }
        return false;
    },

    sendMessage(text) {
        return Peer._send(JSON.stringify({ type: 'text', data: text }));
    },

    sendPing(id) {
        return Peer._send(JSON.stringify({ type: 'ping', id, timestamp: performance.now() }));
    },

    // === FILE TRANSFER ===

    async sendFile(file) {
        if (!Peer._dc || Peer._dc.readyState !== 'open') throw new Error('Not connected');

        Peer._send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' }));

        const buffer = await file.arrayBuffer();
        await Peer._sendBuffer(buffer);

        Peer._send(JSON.stringify({ type: 'file-end' }));
    },

    // === SPEED TEST ===

    async sendSpeedTest(sizeBytes) {
        if (!Peer._dc || Peer._dc.readyState !== 'open') throw new Error('Not connected');

        Peer._send(JSON.stringify({ type: 'speed-start', size: sizeBytes }));

        const buffer = new ArrayBuffer(sizeBytes);
        // Fill with random-ish data to prevent compression cheating
        const view = new Uint32Array(buffer);
        for (let i = 0; i < view.length; i++) view[i] = (Math.random() * 0xFFFFFFFF) >>> 0;

        const start = performance.now();
        await Peer._sendBuffer(buffer);
        const elapsed = performance.now() - start;

        Peer._send(JSON.stringify({ type: 'speed-end' }));

        return { bytes: sizeBytes, ms: elapsed };
    },

    // === SHARED BUFFER SENDING WITH BACKPRESSURE ===

    _sendBuffer(buffer) {
        return new Promise((resolve) => {
            const dc = Peer._dc;
            let offset = 0;

            const sendChunks = () => {
                while (offset < buffer.byteLength) {
                    if (dc.bufferedAmount > 65536) {
                        dc.onbufferedamountlow = () => {
                            dc.onbufferedamountlow = null;
                            sendChunks();
                        };
                        dc.bufferedAmountLowThreshold = 16384;
                        return;
                    }
                    const end = Math.min(offset + Peer.CHUNK_SIZE, buffer.byteLength);
                    dc.send(buffer.slice(offset, end));
                    offset = end;
                }
                resolve();
            };

            sendChunks();
        });
    },

    // === MEDIA RENEGOTIATION OVER DATA CHANNEL ===

    _renegotiating: false,

    _setupRenegotiation() {
        if (!Peer._pc) return;
        Peer._pc.onnegotiationneeded = async () => {
            if (Peer._renegotiating) return;
            Peer._renegotiating = true;
            try {
                const offer = await Peer._pc.createOffer();
                await Peer._pc.setLocalDescription(offer);
                Peer._send(JSON.stringify({ type: 'renegotiate-offer', sdp: Peer._pc.localDescription.sdp }));
            } catch (err) {
                console.error('Renegotiation offer failed:', err);
            }
        };
    },

    async _handleRenegotiateOffer(sdp) {
        try {
            await Peer._pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            const answer = await Peer._pc.createAnswer();
            await Peer._pc.setLocalDescription(answer);
            Peer._send(JSON.stringify({ type: 'renegotiate-answer', sdp: Peer._pc.localDescription.sdp }));
        } catch (err) {
            console.error('Renegotiation answer failed:', err);
        }
    },

    async _handleRenegotiateAnswer(sdp) {
        try {
            await Peer._pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        } catch (err) {
            console.error('Set renegotiation answer failed:', err);
        }
        Peer._renegotiating = false;
    },

    // === MEDIA ===

    async startMedia(video) {
        const constraints = video ? { video: true, audio: true } : { audio: true };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        Peer._localStream = stream;

        for (const track of stream.getTracks()) {
            Peer._pc.addTrack(track, stream);
        }

        Peer._startStatsPolling();
        return stream;
    },

    stopMedia() {
        Peer._stopStatsPolling();

        if (Peer._localStream) {
            for (const track of Peer._localStream.getTracks()) {
                track.stop();
            }
            Peer._localStream = null;
        }

        // Remove senders
        if (Peer._pc) {
            for (const sender of Peer._pc.getSenders()) {
                if (sender.track) {
                    Peer._pc.removeTrack(sender);
                }
            }
        }
    },

    _startStatsPolling() {
        let prevStats = {};

        Peer._statsInterval = setInterval(async () => {
            if (!Peer._pc) return;
            const stats = await Peer._pc.getStats();
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

            if (Peer.onMediaStats) Peer.onMediaStats(result);
        }, 1000);
    },

    _stopStatsPolling() {
        if (Peer._statsInterval) {
            clearInterval(Peer._statsInterval);
            Peer._statsInterval = null;
        }
    },

    // === HEARTBEAT ===

    _startHeartbeat() {
        Peer._lastPeerHeartbeat = Date.now();

        Peer._heartbeatInterval = setInterval(() => {
            Peer._send(JSON.stringify({ type: 'heartbeat' }));

            const silent = Date.now() - Peer._lastPeerHeartbeat;
            if (silent > Peer.HEARTBEAT_TIMEOUT) {
                if (Peer.onStateChange) Peer.onStateChange('unresponsive');
            } else {
                if (Peer.onStateChange) Peer.onStateChange('connected');
            }
        }, Peer.HEARTBEAT_INTERVAL);
    },

    _stopHeartbeat() {
        if (Peer._heartbeatInterval) {
            clearInterval(Peer._heartbeatInterval);
            Peer._heartbeatInterval = null;
        }
    },

    // === CLEANUP ===

    close() {
        Peer._stopHeartbeat();
        Peer.stopMedia();
        if (Peer._dc) { Peer._dc.close(); Peer._dc = null; }
        if (Peer._pc) { Peer._pc.close(); Peer._pc = null; }
        Peer._incomingFile = null;
        Peer._speedTestActive = false;
        Peer._renegotiating = false;
    }
};
