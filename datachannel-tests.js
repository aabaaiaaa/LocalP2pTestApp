// datachannel-tests.js — Data channel experiments

const DataChannelTests = {
    _running: false,

    init() {
        document.getElementById('btn-dc-maxsize').addEventListener('click', () => DataChannelTests.testMaxSize());
        document.getElementById('btn-dc-bintext').addEventListener('click', () => DataChannelTests.testBinaryVsText());
        document.getElementById('btn-dc-order').addEventListener('click', () => DataChannelTests.testOrdered());
        document.getElementById('btn-dc-reliable').addEventListener('click', () => DataChannelTests.testReliable());
        document.getElementById('btn-dc-stress').addEventListener('click', () => DataChannelTests.testStress());
        document.getElementById('btn-dc-concurrent').addEventListener('click', () => DataChannelTests.testConcurrent());
    },

    registerHandlers(conn) {
        conn.registerHandler('dc-maxsize-probe', (peerId, msg) => DataChannelTests._handleMaxSizeProbe(peerId, msg));
        conn.registerHandler('dc-maxsize-ack', (peerId, msg) => DataChannelTests._handleMaxSizeAck(peerId, msg));
        conn.registerHandler('dc-bintext-start', (peerId, msg) => DataChannelTests._handleBinTextStart(peerId, msg));
        conn.registerHandler('dc-bintext-ack', (peerId, msg) => DataChannelTests._handleBinTextAck(peerId, msg));
        conn.registerHandler('dc-stress-start', (peerId, msg) => DataChannelTests._handleStressStart(peerId, msg));
        conn.registerHandler('dc-stress-msg', (peerId, msg) => DataChannelTests._handleStressMsg(peerId, msg));
        conn.registerHandler('dc-stress-end', (peerId, msg) => DataChannelTests._handleStressEnd(peerId, msg));
        conn.registerHandler('dc-stress-report', (peerId, msg) => DataChannelTests._handleStressReport(peerId, msg));
        conn.registerHandler('dc-mtu-probe', (peerId, msg) => DataChannelTests._handleMtuProbe(peerId, msg));
        conn.registerHandler('dc-mtu-ack', (peerId, msg) => DataChannelTests._handleMtuAck(peerId, msg));
    },

    _getPeer() {
        const peerId = document.getElementById('dc-peer-select').value;
        if (!peerId) { alert('No peer selected'); return null; }
        const conn = PeerManager.get(peerId);
        if (!conn) { alert('Peer not connected'); return null; }
        return { peerId, conn };
    },

    _log(id, text) {
        const el = document.getElementById(id);
        el.textContent += text + '\n';
    },

    _clear(id) {
        document.getElementById(id).textContent = '';
    },

    // === MAX MESSAGE SIZE ===

    _maxSizeResolve: null,
    _maxSizeLastAcked: 0,

    async testMaxSize() {
        const peer = DataChannelTests._getPeer();
        if (!peer || DataChannelTests._running) return;
        DataChannelTests._running = true;
        DataChannelTests._clear('dc-maxsize-results');
        DataChannelTests._log('dc-maxsize-results', 'Testing max message size...');

        let size = 1024; // Start at 1 KB
        let lastSuccess = 0;

        while (size <= 1024 * 1024) { // Up to 1 MB
            DataChannelTests._maxSizeLastAcked = -1;

            try {
                const payload = 'x'.repeat(size);
                PeerManager.sendRaw(peer.peerId, { type: 'dc-maxsize-probe', size, payload });

                // Wait for ack with timeout
                const acked = await new Promise((resolve) => {
                    DataChannelTests._maxSizeResolve = resolve;
                    setTimeout(() => resolve(false), 2000);
                });

                if (acked) {
                    lastSuccess = size;
                    DataChannelTests._log('dc-maxsize-results', '  ' + DataChannelTests._formatBytes(size) + ' - OK');
                    size *= 2;
                } else {
                    DataChannelTests._log('dc-maxsize-results', '  ' + DataChannelTests._formatBytes(size) + ' - no ack (timeout)');
                    break;
                }
            } catch (e) {
                DataChannelTests._log('dc-maxsize-results', '  ' + DataChannelTests._formatBytes(size) + ' - FAILED: ' + e.message);
                break;
            }
        }

        DataChannelTests._log('dc-maxsize-results', '\nMax message size: ' + DataChannelTests._formatBytes(lastSuccess));
        DataChannelTests._running = false;
    },

    _handleMaxSizeProbe(peerId, msg) {
        PeerManager.sendRaw(peerId, { type: 'dc-maxsize-ack', size: msg.size });
    },

    _handleMaxSizeAck() {
        if (DataChannelTests._maxSizeResolve) {
            DataChannelTests._maxSizeResolve(true);
            DataChannelTests._maxSizeResolve = null;
        }
    },

    // === BINARY VS TEXT ===

    _binTextResolve: null,

    async testBinaryVsText() {
        const peer = DataChannelTests._getPeer();
        if (!peer || DataChannelTests._running) return;
        DataChannelTests._running = true;
        DataChannelTests._clear('dc-bintext-results');
        DataChannelTests._log('dc-bintext-results', 'Testing binary vs text throughput (1 MB each)...\n');

        const testSize = 1024 * 1024;
        const dc = peer.conn.getDataChannel();
        if (!dc || dc.readyState !== 'open') {
            DataChannelTests._log('dc-bintext-results', 'Error: data channel not open');
            DataChannelTests._running = false;
            return;
        }

        // Text test: send 1MB as JSON string chunks
        DataChannelTests._log('dc-bintext-results', 'Sending 1 MB as text...');
        PeerManager.sendRaw(peer.peerId, { type: 'dc-bintext-start', mode: 'text', size: testSize });
        const textStart = performance.now();
        const chunkSize = 16384;
        const textChunk = 'A'.repeat(chunkSize);
        let sent = 0;
        while (sent < testSize) {
            if (dc.bufferedAmount > 65536) {
                await new Promise(r => {
                    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
                    dc.bufferedAmountLowThreshold = 16384;
                });
            }
            dc.send(textChunk);
            sent += chunkSize;
        }
        PeerManager.sendRaw(peer.peerId, { type: 'dc-bintext-start', mode: 'text-end', size: testSize });
        const textTime = performance.now() - textStart;
        const textMbps = (testSize / 1024 / 1024) / (textTime / 1000);
        DataChannelTests._log('dc-bintext-results', '  Text: ' + textTime.toFixed(0) + ' ms, ' + textMbps.toFixed(2) + ' MB/s');

        // Small delay between tests
        await new Promise(r => setTimeout(r, 500));

        // Binary test: send 1MB as ArrayBuffer chunks
        DataChannelTests._log('dc-bintext-results', 'Sending 1 MB as binary...');
        PeerManager.sendRaw(peer.peerId, { type: 'dc-bintext-start', mode: 'binary', size: testSize });
        const binStart = performance.now();
        const binChunk = new ArrayBuffer(chunkSize);
        sent = 0;
        while (sent < testSize) {
            if (dc.bufferedAmount > 65536) {
                await new Promise(r => {
                    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
                    dc.bufferedAmountLowThreshold = 16384;
                });
            }
            dc.send(binChunk);
            sent += chunkSize;
        }
        PeerManager.sendRaw(peer.peerId, { type: 'dc-bintext-start', mode: 'binary-end', size: testSize });
        const binTime = performance.now() - binStart;
        const binMbps = (testSize / 1024 / 1024) / (binTime / 1000);
        DataChannelTests._log('dc-bintext-results', '  Binary: ' + binTime.toFixed(0) + ' ms, ' + binMbps.toFixed(2) + ' MB/s');

        DataChannelTests._log('dc-bintext-results', '\nComparison:');
        DataChannelTests._log('dc-bintext-results', '  Text:   ' + textMbps.toFixed(2) + ' MB/s');
        DataChannelTests._log('dc-bintext-results', '  Binary: ' + binMbps.toFixed(2) + ' MB/s');
        const ratio = binMbps / textMbps;
        DataChannelTests._log('dc-bintext-results', '  Binary is ' + ratio.toFixed(2) + 'x ' + (ratio > 1 ? 'faster' : 'slower'));

        DataChannelTests._running = false;
    },

    _handleBinTextStart() {
        // Receiver side — just acknowledge we got the coordination message
    },

    _handleBinTextAck() {
        if (DataChannelTests._binTextResolve) {
            DataChannelTests._binTextResolve();
            DataChannelTests._binTextResolve = null;
        }
    },

    // === ORDERED VS UNORDERED ===

    _orderResolves: {},
    _orderReceived: {},

    async testOrdered() {
        const peer = DataChannelTests._getPeer();
        if (!peer || DataChannelTests._running) return;
        DataChannelTests._running = true;
        DataChannelTests._clear('dc-order-results');

        const count = parseInt(document.getElementById('dc-order-count').value) || 1000;
        DataChannelTests._log('dc-order-results', 'Testing ordered vs unordered with ' + count + ' messages...\n');

        const conn = peer.conn;

        // Create an unordered secondary data channel
        let unorderedDc;
        try {
            unorderedDc = conn.createDataChannel('dc-test-unordered', { ordered: false });
        } catch (e) {
            DataChannelTests._log('dc-order-results', 'Error creating unordered channel: ' + e.message);
            DataChannelTests._running = false;
            return;
        }

        // Wait for unordered channel to open
        await new Promise((resolve) => {
            if (unorderedDc.readyState === 'open') { resolve(); return; }
            unorderedDc.onopen = resolve;
            setTimeout(resolve, 5000);
        });

        if (unorderedDc.readyState !== 'open') {
            DataChannelTests._log('dc-order-results', 'Error: unordered channel did not open');
            DataChannelTests._running = false;
            return;
        }

        // Send on ordered (main) channel
        DataChannelTests._log('dc-order-results', 'Sending ' + count + ' messages on ordered channel...');
        const orderedDc = conn.getDataChannel();
        const orderedStart = performance.now();
        for (let i = 0; i < count; i++) {
            orderedDc.send(JSON.stringify({ type: 'dc-order-test', channel: 'ordered', seq: i }));
        }
        orderedDc.send(JSON.stringify({ type: 'dc-order-test', channel: 'ordered', seq: -1 })); // sentinel

        // Send on unordered channel
        DataChannelTests._log('dc-order-results', 'Sending ' + count + ' messages on unordered channel...');
        const unorderedStart = performance.now();
        for (let i = 0; i < count; i++) {
            unorderedDc.send(JSON.stringify({ type: 'dc-order-test', channel: 'unordered', seq: i }));
        }
        unorderedDc.send(JSON.stringify({ type: 'dc-order-test', channel: 'unordered', seq: -1 }));

        // We measure send time locally (the actual reordering happens on the receiver side)
        const orderedTime = performance.now() - orderedStart;
        const unorderedTime = performance.now() - unorderedStart;

        DataChannelTests._log('dc-order-results', '\nSend times:');
        DataChannelTests._log('dc-order-results', '  Ordered:   ' + orderedTime.toFixed(1) + ' ms');
        DataChannelTests._log('dc-order-results', '  Unordered: ' + unorderedTime.toFixed(1) + ' ms');
        DataChannelTests._log('dc-order-results', '\nNote: Reordering is measured on the receiver side.');
        DataChannelTests._log('dc-order-results', 'Check the remote peer\'s Data Channel tab for reception results.');

        unorderedDc.close();
        DataChannelTests._running = false;
    },

    // === RELIABLE VS UNRELIABLE ===

    async testReliable() {
        const peer = DataChannelTests._getPeer();
        if (!peer || DataChannelTests._running) return;
        DataChannelTests._running = true;
        DataChannelTests._clear('dc-reliable-results');

        const count = parseInt(document.getElementById('dc-reliable-count').value) || 1000;
        DataChannelTests._log('dc-reliable-results', 'Testing reliable vs unreliable with ' + count + ' messages...\n');

        const conn = peer.conn;

        // Create unreliable channel
        let unreliableDc;
        try {
            unreliableDc = conn.createDataChannel('dc-test-unreliable', {
                ordered: false,
                maxRetransmits: 0
            });
        } catch (e) {
            DataChannelTests._log('dc-reliable-results', 'Error creating unreliable channel: ' + e.message);
            DataChannelTests._running = false;
            return;
        }

        await new Promise((resolve) => {
            if (unreliableDc.readyState === 'open') { resolve(); return; }
            unreliableDc.onopen = resolve;
            setTimeout(resolve, 5000);
        });

        if (unreliableDc.readyState !== 'open') {
            DataChannelTests._log('dc-reliable-results', 'Error: unreliable channel did not open');
            DataChannelTests._running = false;
            return;
        }

        // Tell remote to prepare for the test
        PeerManager.sendRaw(peer.peerId, { type: 'dc-reliable-start', count });

        // Send on reliable (main) channel
        DataChannelTests._log('dc-reliable-results', 'Sending ' + count + ' messages on reliable channel...');
        const reliableDc = conn.getDataChannel();
        const reliableStart = performance.now();
        for (let i = 0; i < count; i++) {
            reliableDc.send(JSON.stringify({ type: 'dc-reliable-test', channel: 'reliable', seq: i }));
        }
        reliableDc.send(JSON.stringify({ type: 'dc-reliable-test', channel: 'reliable', seq: -1 }));
        const reliableTime = performance.now() - reliableStart;

        // Send on unreliable channel
        DataChannelTests._log('dc-reliable-results', 'Sending ' + count + ' messages on unreliable channel...');
        const unreliableStart = performance.now();
        for (let i = 0; i < count; i++) {
            unreliableDc.send(JSON.stringify({ type: 'dc-reliable-test', channel: 'unreliable', seq: i }));
        }
        unreliableDc.send(JSON.stringify({ type: 'dc-reliable-test', channel: 'unreliable', seq: -1 }));
        const unreliableTime = performance.now() - unreliableStart;

        DataChannelTests._log('dc-reliable-results', '\nSend times:');
        DataChannelTests._log('dc-reliable-results', '  Reliable:   ' + reliableTime.toFixed(1) + ' ms');
        DataChannelTests._log('dc-reliable-results', '  Unreliable: ' + unreliableTime.toFixed(1) + ' ms');
        DataChannelTests._log('dc-reliable-results', '\nDelivery rate measured on the receiver side.');
        DataChannelTests._log('dc-reliable-results', 'Check the remote peer for reception results.');

        unreliableDc.close();
        DataChannelTests._running = false;
    },

    // === STRESS TEST ===

    _stressState: null,

    async testStress() {
        const peer = DataChannelTests._getPeer();
        if (!peer || DataChannelTests._running) return;
        DataChannelTests._running = true;
        DataChannelTests._clear('dc-stress-results');

        const rate = parseInt(document.getElementById('dc-stress-rate').value) || 1000;
        const duration = parseInt(document.getElementById('dc-stress-duration').value) || 5;
        const totalExpected = rate * duration;

        DataChannelTests._log('dc-stress-results', 'Stress test: ' + rate + ' msg/s for ' + duration + 's (' + totalExpected + ' expected)...\n');

        // Tell remote to start counting
        PeerManager.sendRaw(peer.peerId, { type: 'dc-stress-start', rate, duration, totalExpected });

        const dc = peer.conn.getDataChannel();
        const intervalMs = 1000 / rate;
        let sent = 0;
        const start = performance.now();
        const endTime = start + (duration * 1000);

        // Use a tight loop with timing
        const sendBatch = () => {
            const now = performance.now();
            if (now >= endTime) {
                const elapsed = now - start;
                PeerManager.sendRaw(peer.peerId, { type: 'dc-stress-end', sent });

                DataChannelTests._log('dc-stress-results', 'Sent: ' + sent + ' messages');
                DataChannelTests._log('dc-stress-results', 'Duration: ' + (elapsed / 1000).toFixed(2) + 's');
                DataChannelTests._log('dc-stress-results', 'Actual rate: ' + (sent / (elapsed / 1000)).toFixed(0) + ' msg/s');
                DataChannelTests._log('dc-stress-results', 'Bytes sent: ' + DataChannelTests._formatBytes(sent * 20));
                DataChannelTests._log('dc-stress-results', '\nWaiting for receiver report...');

                // Wait for report from remote
                DataChannelTests._stressReportResolve = null;
                const timeout = setTimeout(() => {
                    if (DataChannelTests._running) {
                        DataChannelTests._log('dc-stress-results', '(No report received - check remote peer)');
                        DataChannelTests._running = false;
                    }
                }, 5000);

                DataChannelTests._stressReportResolve = () => {
                    clearTimeout(timeout);
                };

                return;
            }

            // Send a batch of messages
            const batchSize = Math.min(100, Math.ceil(rate / 10));
            for (let i = 0; i < batchSize && sent < totalExpected; i++) {
                try {
                    dc.send(JSON.stringify({ type: 'dc-stress-msg', seq: sent }));
                    sent++;
                } catch (e) {
                    // Channel might be full — skip
                    break;
                }
            }

            setTimeout(sendBatch, Math.max(1, intervalMs * batchSize));
        };

        sendBatch();
    },

    _stressReportResolve: null,
    _stressReceiverState: null,

    _handleStressStart(peerId, msg) {
        DataChannelTests._stressReceiverState = {
            expected: msg.totalExpected,
            received: 0,
            start: performance.now(),
            maxSeq: -1,
            outOfOrder: 0
        };
    },

    _handleStressMsg(peerId, msg) {
        const state = DataChannelTests._stressReceiverState;
        if (!state) return;
        state.received++;
        if (msg.seq < state.maxSeq) state.outOfOrder++;
        if (msg.seq > state.maxSeq) state.maxSeq = msg.seq;
    },

    _handleStressEnd(peerId, msg) {
        const state = DataChannelTests._stressReceiverState;
        if (!state) return;

        // Small delay to let remaining messages arrive
        setTimeout(() => {
            const elapsed = performance.now() - state.start;
            const loss = msg.sent - state.received;
            const lossRate = (loss / msg.sent * 100).toFixed(2);

            PeerManager.sendRaw(peerId, {
                type: 'dc-stress-report',
                received: state.received,
                sent: msg.sent,
                loss,
                lossRate,
                elapsed: elapsed.toFixed(0),
                outOfOrder: state.outOfOrder,
                rate: (state.received / (elapsed / 1000)).toFixed(0)
            });

            DataChannelTests._stressReceiverState = null;
        }, 1000);
    },

    _handleStressReport(peerId, msg) {
        DataChannelTests._log('dc-stress-results', '\nReceiver report:');
        DataChannelTests._log('dc-stress-results', '  Received: ' + msg.received + ' / ' + msg.sent);
        DataChannelTests._log('dc-stress-results', '  Loss: ' + msg.loss + ' (' + msg.lossRate + '%)');
        DataChannelTests._log('dc-stress-results', '  Out of order: ' + msg.outOfOrder);
        DataChannelTests._log('dc-stress-results', '  Receiver rate: ' + msg.rate + ' msg/s');
        DataChannelTests._log('dc-stress-results', '  Elapsed: ' + (msg.elapsed / 1000).toFixed(2) + 's');
        DataChannelTests._running = false;
        if (DataChannelTests._stressReportResolve) DataChannelTests._stressReportResolve();
    },

    // === CONCURRENT TRANSFERS ===

    async testConcurrent() {
        const peer = DataChannelTests._getPeer();
        if (!peer || DataChannelTests._running) return;

        const fileInput = document.getElementById('dc-concurrent-files');
        const files = fileInput.files;
        if (!files || files.length < 2) {
            alert('Select at least 2 files');
            return;
        }

        DataChannelTests._running = true;
        DataChannelTests._clear('dc-concurrent-results');
        DataChannelTests._log('dc-concurrent-results', 'Concurrent transfer test with ' + files.length + ' files...\n');

        const conn = peer.conn;
        const CHUNK = 16384;

        // Sequential test
        DataChannelTests._log('dc-concurrent-results', '--- Sequential ---');
        const seqStart = performance.now();
        let seqTotalBytes = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const buffer = await file.arrayBuffer();
            const dc = conn.getDataChannel();
            const fStart = performance.now();

            let offset = 0;
            while (offset < buffer.byteLength) {
                if (dc.bufferedAmount > 65536) {
                    await new Promise(r => {
                        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
                        dc.bufferedAmountLowThreshold = 16384;
                    });
                }
                const end = Math.min(offset + CHUNK, buffer.byteLength);
                dc.send(buffer.slice(offset, end));
                offset = end;
            }

            const fTime = performance.now() - fStart;
            seqTotalBytes += buffer.byteLength;
            DataChannelTests._log('dc-concurrent-results', '  ' + file.name + ': ' + DataChannelTests._formatBytes(file.size) + ' in ' + fTime.toFixed(0) + ' ms');
        }
        const seqTime = performance.now() - seqStart;
        const seqMbps = (seqTotalBytes / 1024 / 1024) / (seqTime / 1000);
        DataChannelTests._log('dc-concurrent-results', '  Total: ' + seqTime.toFixed(0) + ' ms, ' + seqMbps.toFixed(2) + ' MB/s\n');

        // Small delay
        await new Promise(r => setTimeout(r, 1000));

        // Concurrent test — each file on its own secondary data channel
        DataChannelTests._log('dc-concurrent-results', '--- Concurrent ---');
        const concStart = performance.now();
        const promises = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const label = 'dc-concurrent-' + i;
            const dc = conn.createDataChannel(label, { ordered: true });

            const p = new Promise(async (resolve) => {
                // Wait for open
                await new Promise((r) => {
                    if (dc.readyState === 'open') { r(); return; }
                    dc.onopen = r;
                    setTimeout(r, 5000);
                });

                if (dc.readyState !== 'open') {
                    resolve({ file, time: -1 });
                    return;
                }

                const buffer = await file.arrayBuffer();
                const fStart = performance.now();
                let offset = 0;

                while (offset < buffer.byteLength) {
                    if (dc.bufferedAmount > 65536) {
                        await new Promise(r => {
                            dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
                            dc.bufferedAmountLowThreshold = 16384;
                        });
                    }
                    const end = Math.min(offset + CHUNK, buffer.byteLength);
                    dc.send(buffer.slice(offset, end));
                    offset = end;
                }

                const fTime = performance.now() - fStart;
                dc.close();
                resolve({ file, time: fTime });
            });
            promises.push(p);
        }

        const results = await Promise.all(promises);
        const concTime = performance.now() - concStart;
        let concTotalBytes = 0;

        for (const r of results) {
            concTotalBytes += r.file.size;
            if (r.time < 0) {
                DataChannelTests._log('dc-concurrent-results', '  ' + r.file.name + ': FAILED to open channel');
            } else {
                DataChannelTests._log('dc-concurrent-results', '  ' + r.file.name + ': ' + DataChannelTests._formatBytes(r.file.size) + ' in ' + r.time.toFixed(0) + ' ms');
            }
        }

        const concMbps = (concTotalBytes / 1024 / 1024) / (concTime / 1000);
        DataChannelTests._log('dc-concurrent-results', '  Total: ' + concTime.toFixed(0) + ' ms, ' + concMbps.toFixed(2) + ' MB/s\n');

        DataChannelTests._log('dc-concurrent-results', '--- Comparison ---');
        DataChannelTests._log('dc-concurrent-results', '  Sequential:  ' + seqTime.toFixed(0) + ' ms (' + seqMbps.toFixed(2) + ' MB/s)');
        DataChannelTests._log('dc-concurrent-results', '  Concurrent:  ' + concTime.toFixed(0) + ' ms (' + concMbps.toFixed(2) + ' MB/s)');
        const speedup = seqTime / concTime;
        DataChannelTests._log('dc-concurrent-results', '  Speedup: ' + speedup.toFixed(2) + 'x');

        DataChannelTests._running = false;
    },

    // === MTU Discovery (shared with NetworkTests for protocol) ===

    _mtuResolve: null,

    _handleMtuProbe(peerId, msg) {
        PeerManager.sendRaw(peerId, { type: 'dc-mtu-ack', size: msg.size });
    },

    _handleMtuAck(peerId, msg) {
        if (DataChannelTests._mtuResolve) {
            DataChannelTests._mtuResolve(msg.size);
            DataChannelTests._mtuResolve = null;
        }
    },

    // === UTILITY ===

    _formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }
};
