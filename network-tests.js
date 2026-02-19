// network-tests.js — Network and connection analysis tools

const NetworkTests = {
    _simEnabled: false,
    _origHandleMessage: null,

    init() {
        document.getElementById('btn-ice-gather').addEventListener('click', () => NetworkTests.gatherCandidates());
        document.getElementById('btn-conntype').addEventListener('click', () => NetworkTests.detectConnectionType());
        document.getElementById('btn-stun-test').addEventListener('click', () => NetworkTests.testStunTurn());
        document.getElementById('btn-mtu').addEventListener('click', () => NetworkTests.discoverMtu());
        document.getElementById('btn-ice-restart').addEventListener('click', () => NetworkTests.restartIce());
        document.getElementById('btn-sim-enable').addEventListener('click', () => NetworkTests.enableSim());
        document.getElementById('btn-sim-disable').addEventListener('click', () => NetworkTests.disableSim());
    },

    registerHandlers(conn) {
        conn.registerHandler('mtu-probe', (peerId, msg) => NetworkTests._handleMtuProbe(peerId, msg));
        conn.registerHandler('mtu-ack', (peerId, msg) => NetworkTests._handleMtuAck(peerId, msg));
    },

    _log(id, text) {
        const el = document.getElementById(id);
        el.textContent += text + '\n';
    },

    _clear(id) {
        document.getElementById(id).textContent = '';
    },

    // === ICE CANDIDATE INSPECTOR ===

    async gatherCandidates() {
        NetworkTests._clear('ice-candidates-results');
        NetworkTests._log('ice-candidates-results', 'Gathering ICE candidates...\n');

        const pc = new RTCPeerConnection({
            iceServers: PeerManager._iceServers.length > 0
                ? PeerManager._iceServers
                : [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Need a data channel to generate candidates
        pc.createDataChannel('probe');

        const candidates = [];

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                candidates.push(event.candidate);
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for gathering to complete
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const timeout = setTimeout(resolve, 10000);
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });

        pc.close();

        if (candidates.length === 0) {
            NetworkTests._log('ice-candidates-results', 'No candidates gathered.');
            return;
        }

        // Group by type
        const grouped = {};
        for (const c of candidates) {
            const type = c.type || 'unknown';
            if (!grouped[type]) grouped[type] = [];
            grouped[type].push(c);
        }

        for (const type of Object.keys(grouped).sort()) {
            NetworkTests._log('ice-candidates-results', '--- ' + type + ' (' + grouped[type].length + ') ---');
            for (const c of grouped[type]) {
                const parts = c.candidate.split(' ');
                const foundation = parts[0] ? parts[0].replace('candidate:', '') : '?';
                const protocol = parts[2] || '?';
                const address = parts[4] || '?';
                const port = parts[5] || '?';
                const priority = c.priority || '?';
                NetworkTests._log('ice-candidates-results',
                    '  ' + protocol.toUpperCase() + ' ' + address + ':' + port +
                    '  priority=' + priority + '  foundation=' + foundation);
            }
            NetworkTests._log('ice-candidates-results', '');
        }

        NetworkTests._log('ice-candidates-results', 'Total: ' + candidates.length + ' candidates');
    },

    // === CONNECTION TYPE DETECTION ===

    async detectConnectionType() {
        const peerId = document.getElementById('conntype-peer-select').value;
        if (!peerId) { alert('No peer selected'); return; }

        NetworkTests._clear('conntype-results');
        NetworkTests._log('conntype-results', 'Detecting connection type...\n');

        const conn = PeerManager.get(peerId);
        if (!conn) { NetworkTests._log('conntype-results', 'Peer not found'); return; }

        const pc = conn.getRTCPeerConnection();
        if (!pc) { NetworkTests._log('conntype-results', 'No RTCPeerConnection'); return; }

        try {
            const stats = await pc.getStats();
            let activePair = null;
            const candidateMap = {};

            stats.forEach((report) => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    activePair = report;
                }
                if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                    candidateMap[report.id] = report;
                }
            });

            if (!activePair) {
                NetworkTests._log('conntype-results', 'No active candidate pair found');
                return;
            }

            const local = candidateMap[activePair.localCandidateId] || {};
            const remote = candidateMap[activePair.remoteCandidateId] || {};

            NetworkTests._log('conntype-results', 'Active Candidate Pair:');
            NetworkTests._log('conntype-results', '  Local:');
            NetworkTests._log('conntype-results', '    Type:     ' + (local.candidateType || '?'));
            NetworkTests._log('conntype-results', '    Protocol: ' + (local.protocol || '?').toUpperCase());
            NetworkTests._log('conntype-results', '    Address:  ' + (local.address || local.ip || '?') + ':' + (local.port || '?'));
            NetworkTests._log('conntype-results', '  Remote:');
            NetworkTests._log('conntype-results', '    Type:     ' + (remote.candidateType || '?'));
            NetworkTests._log('conntype-results', '    Protocol: ' + (remote.protocol || '?').toUpperCase());
            NetworkTests._log('conntype-results', '    Address:  ' + (remote.address || remote.ip || '?') + ':' + (remote.port || '?'));
            NetworkTests._log('conntype-results', '');

            const isDirect = local.candidateType === 'host' && remote.candidateType === 'host';
            const isRelay = local.candidateType === 'relay' || remote.candidateType === 'relay';
            const connType = isRelay ? 'RELAYED (via TURN)' : isDirect ? 'DIRECT (host-to-host)' : 'REFLEXIVE (via STUN)';
            NetworkTests._log('conntype-results', 'Connection: ' + connType);

            if (activePair.currentRoundTripTime) {
                NetworkTests._log('conntype-results', 'RTT: ' + (activePair.currentRoundTripTime * 1000).toFixed(1) + ' ms');
            }
            if (activePair.availableOutgoingBitrate) {
                NetworkTests._log('conntype-results', 'Available bandwidth: ' + (activePair.availableOutgoingBitrate / 1000).toFixed(0) + ' kbps');
            }
        } catch (err) {
            NetworkTests._log('conntype-results', 'Error: ' + err.message);
        }
    },

    // === STUN/TURN TESTING ===

    async testStunTurn() {
        const url = document.getElementById('stun-url').value.trim();
        if (!url) { alert('Enter a STUN/TURN URL'); return; }

        NetworkTests._clear('stun-results');
        NetworkTests._log('stun-results', 'Testing server: ' + url + '\n');

        const isTurn = url.startsWith('turn:') || url.startsWith('turns:');
        const config = {
            iceServers: [isTurn ? { urls: url, username: 'test', credential: 'test' } : { urls: url }]
        };

        const pc = new RTCPeerConnection(config);
        pc.createDataChannel('probe');

        const candidates = [];
        const gatherStart = performance.now();

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                candidates.push(event.candidate);
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const timeout = setTimeout(resolve, 10000);
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });

        const gatherTime = performance.now() - gatherStart;
        pc.close();

        const types = {};
        for (const c of candidates) {
            const t = c.type || 'unknown';
            types[t] = (types[t] || 0) + 1;
        }

        NetworkTests._log('stun-results', 'Gather time: ' + gatherTime.toFixed(0) + ' ms');
        NetworkTests._log('stun-results', 'Candidates: ' + candidates.length);

        if (candidates.length > 0) {
            NetworkTests._log('stun-results', 'Types: ' + Object.entries(types).map(([k, v]) => k + '=' + v).join(', '));
            const hasSrflx = types['srflx'] > 0;
            const hasRelay = types['relay'] > 0;

            if (url.startsWith('stun:')) {
                NetworkTests._log('stun-results', '\nResult: ' + (hasSrflx ? 'REACHABLE (got srflx candidates)' : 'PARTIAL (no srflx - might be blocked)'));
            } else {
                NetworkTests._log('stun-results', '\nResult: ' + (hasRelay ? 'REACHABLE (got relay candidates)' : 'UNREACHABLE or bad credentials'));
            }
        } else {
            NetworkTests._log('stun-results', '\nResult: UNREACHABLE (no candidates gathered)');
        }
    },

    // === MTU DISCOVERY ===

    _mtuResolve: null,

    async discoverMtu() {
        const peerId = document.getElementById('mtu-peer-select').value;
        if (!peerId) { alert('No peer selected'); return; }

        NetworkTests._clear('mtu-results');
        NetworkTests._log('mtu-results', 'Discovering effective MTU...\n');

        const conn = PeerManager.get(peerId);
        if (!conn) { NetworkTests._log('mtu-results', 'Peer not found'); return; }

        let size = 1024;
        let lastSuccess = 0;
        const step = 1024;
        const maxSize = 256 * 1024;

        while (size <= maxSize) {
            const payload = 'M'.repeat(size);
            PeerManager.sendRaw(peerId, { type: 'mtu-probe', size, payload });

            const acked = await new Promise((resolve) => {
                NetworkTests._mtuResolve = (ackedSize) => {
                    resolve(ackedSize === size);
                };
                setTimeout(() => {
                    NetworkTests._mtuResolve = null;
                    resolve(false);
                }, 2000);
            });

            if (acked) {
                lastSuccess = size;
                NetworkTests._log('mtu-results', '  ' + NetworkTests._formatBytes(size) + ' - OK');
                size += step;
            } else {
                NetworkTests._log('mtu-results', '  ' + NetworkTests._formatBytes(size) + ' - FAILED');
                break;
            }
        }

        NetworkTests._log('mtu-results', '\nEffective max chunk size: ' + NetworkTests._formatBytes(lastSuccess));
    },

    _handleMtuProbe(peerId, msg) {
        PeerManager.sendRaw(peerId, { type: 'mtu-ack', size: msg.size });
    },

    _handleMtuAck(peerId, msg) {
        if (NetworkTests._mtuResolve) {
            NetworkTests._mtuResolve(msg.size);
            NetworkTests._mtuResolve = null;
        }
    },

    // === ICE RESTART ===

    async restartIce() {
        const peerId = document.getElementById('restart-peer-select').value;
        if (!peerId) { alert('No peer selected'); return; }

        NetworkTests._clear('restart-results');
        NetworkTests._log('restart-results', 'Triggering ICE restart...\n');

        const conn = PeerManager.get(peerId);
        if (!conn) { NetworkTests._log('restart-results', 'Peer not found'); return; }

        const pc = conn.getRTCPeerConnection();
        if (!pc) { NetworkTests._log('restart-results', 'No RTCPeerConnection'); return; }

        try {
            const restartStart = performance.now();

            // Trigger ICE restart
            pc.restartIce();

            // Create new offer with ICE restart
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);

            // Send new offer via data channel
            conn._send(JSON.stringify({ type: 'renegotiate-offer', sdp: pc.localDescription.sdp }));

            // Wait for ICE to reconnect
            await new Promise((resolve) => {
                const timeout = setTimeout(resolve, 15000);
                const handler = () => {
                    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                        clearTimeout(timeout);
                        pc.removeEventListener('iceconnectionstatechange', handler);
                        resolve();
                    }
                };
                pc.addEventListener('iceconnectionstatechange', handler);
                // If already connected (fast restart)
                if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                    clearTimeout(timeout);
                    resolve();
                }
            });

            const elapsed = performance.now() - restartStart;
            NetworkTests._log('restart-results', 'ICE restart completed');
            NetworkTests._log('restart-results', 'Time: ' + elapsed.toFixed(0) + ' ms');
            NetworkTests._log('restart-results', 'State: ' + pc.iceConnectionState);
        } catch (err) {
            NetworkTests._log('restart-results', 'Error: ' + err.message);
        }
    },

    // === PACKET LOSS / JITTER SIMULATION ===

    enableSim() {
        const lossPercent = parseInt(document.getElementById('sim-loss').value) || 0;
        const jitterMs = parseInt(document.getElementById('sim-jitter').value) || 0;

        if (NetworkTests._simEnabled) return;
        NetworkTests._simEnabled = true;

        document.getElementById('btn-sim-enable').classList.add('hidden');
        document.getElementById('btn-sim-disable').classList.remove('hidden');

        NetworkTests._clear('sim-results');
        NetworkTests._log('sim-results', 'Simulation enabled: ' + lossPercent + '% loss, ' + jitterMs + 'ms jitter');

        let dropped = 0;
        let delayed = 0;
        let total = 0;

        // Patch all connections' _handleMessage
        for (const conn of PeerManager._connections.values()) {
            const original = conn._handleMessage.bind(conn);
            conn._origHandleMessage = conn._handleMessage;
            conn._handleMessage = function(event) {
                total++;
                // Simulate packet loss
                if (Math.random() * 100 < lossPercent) {
                    dropped++;
                    return; // Drop the message
                }
                // Simulate jitter
                if (jitterMs > 0) {
                    const delay = Math.random() * jitterMs;
                    delayed++;
                    setTimeout(() => original(event), delay);
                } else {
                    original(event);
                }
            };
        }

        // Update stats periodically
        NetworkTests._simStatsInterval = setInterval(() => {
            NetworkTests._clear('sim-results');
            NetworkTests._log('sim-results', 'Simulation active: ' + lossPercent + '% loss, ' + jitterMs + 'ms jitter');
            NetworkTests._log('sim-results', 'Total messages: ' + total);
            NetworkTests._log('sim-results', 'Dropped: ' + dropped + ' (' + (total > 0 ? (dropped / total * 100).toFixed(1) : 0) + '%)');
            NetworkTests._log('sim-results', 'Delayed: ' + delayed);
        }, 1000);
    },

    disableSim() {
        if (!NetworkTests._simEnabled) return;
        NetworkTests._simEnabled = false;

        document.getElementById('btn-sim-enable').classList.remove('hidden');
        document.getElementById('btn-sim-disable').classList.add('hidden');

        if (NetworkTests._simStatsInterval) {
            clearInterval(NetworkTests._simStatsInterval);
            NetworkTests._simStatsInterval = null;
        }

        // Restore original handlers
        for (const conn of PeerManager._connections.values()) {
            if (conn._origHandleMessage) {
                conn._handleMessage = conn._origHandleMessage;
                delete conn._origHandleMessage;
            }
        }

        NetworkTests._log('sim-results', '\nSimulation disabled.');
    },

    _simStatsInterval: null,

    // === UTILITY ===

    _formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }
};
