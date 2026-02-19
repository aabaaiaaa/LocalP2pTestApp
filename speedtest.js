// speedtest.js — Speed test suite for P2P connection (multi-peer aware)

const SpeedTest = {
    _running: false,
    _pingResolves: {},
    _targetPeerId: null,

    // Run a quick 1MB throughput test against a specific peer
    async runQuick(peerId) {
        SpeedTest._running = true;
        SpeedTest._targetPeerId = peerId;
        SpeedTest._setStatus('Running quick test...');
        SpeedTest._clearResults();

        try {
            const result = await PeerManager.sendSpeedTest(peerId, 1 * 1024 * 1024);
            const mbps = ((result.bytes / 1024 / 1024) / (result.ms / 1000)).toFixed(2);
            SpeedTest._clearResults();
            SpeedTest._addCard('Throughput', mbps, 'MB/s', 'done');
            SpeedTest._addCard('Time', (result.ms / 1000).toFixed(2), 's', 'done');
            SpeedTest._addCard('Data sent', '1', 'MB', 'done');
            SpeedTest._setStatus('Quick test complete');
        } catch (err) {
            SpeedTest._setStatus('Test failed: ' + err.message);
        }

        SpeedTest._running = false;
        SpeedTest._targetPeerId = null;
    },

    // Run the full test suite against a specific peer
    async runFull(peerId) {
        SpeedTest._running = true;
        SpeedTest._targetPeerId = peerId;
        SpeedTest._clearResults();

        try {
            // 1. Latency test
            SpeedTest._setStatus('Testing latency...');
            SpeedTest._addCard('Latency', '...', '', 'running');
            const latency = await SpeedTest._testLatency(peerId, 20);
            SpeedTest._updateCard(0, latency.avg.toFixed(1), 'ms', 'done');
            SpeedTest._addCard('Lat. min', latency.min.toFixed(1), 'ms', 'done');
            SpeedTest._addCard('Lat. max', latency.max.toFixed(1), 'ms', 'done');

            // 2. Throughput 1MB
            SpeedTest._setStatus('Testing throughput (1 MB)...');
            SpeedTest._addCard('1 MB test', '...', '', 'running');
            const t1 = await PeerManager.sendSpeedTest(peerId, 1 * 1024 * 1024);
            const mbps1 = ((t1.bytes / 1024 / 1024) / (t1.ms / 1000)).toFixed(2);
            SpeedTest._updateCard(3, mbps1, 'MB/s', 'done');

            // 3. Throughput 10MB
            SpeedTest._setStatus('Testing throughput (10 MB)...');
            SpeedTest._addCard('10 MB test', '...', '', 'running');
            const t10 = await PeerManager.sendSpeedTest(peerId, 10 * 1024 * 1024);
            const mbps10 = ((t10.bytes / 1024 / 1024) / (t10.ms / 1000)).toFixed(2);
            SpeedTest._updateCard(4, mbps10, 'MB/s', 'done');

            // 4. Sustained 5s test
            SpeedTest._setStatus('Running sustained test (5s)...');
            SpeedTest._addCard('Sustained', '...', '', 'running');
            const conn = PeerManager.get(peerId);
            if (!conn) throw new Error('Peer disconnected');
            const sustained = await conn.sendSustainedTest(5000);
            const sustainedMbps = ((sustained.bytes / 1024 / 1024) / (sustained.ms / 1000)).toFixed(2);
            SpeedTest._updateCard(5, sustainedMbps, 'MB/s', 'done');

            SpeedTest._setStatus('Full test suite complete');
        } catch (err) {
            SpeedTest._setStatus('Test failed: ' + err.message);
        }

        SpeedTest._running = false;
        SpeedTest._targetPeerId = null;
    },

    // Latency test: send N pings and measure round-trip times
    async _testLatency(peerId, count) {
        const times = [];

        for (let i = 0; i < count; i++) {
            const rtt = await new Promise((resolve) => {
                const id = 'ping-' + i;
                const sent = performance.now();

                SpeedTest._pingResolves[id] = () => {
                    delete SpeedTest._pingResolves[id];
                    resolve(performance.now() - sent);
                };

                PeerManager.sendPing(peerId, id);

                setTimeout(() => {
                    if (SpeedTest._pingResolves[id]) {
                        delete SpeedTest._pingResolves[id];
                        resolve(3000);
                    }
                }, 3000);
            });

            times.push(rtt);
        }

        return {
            min: Math.min(...times),
            max: Math.max(...times),
            avg: times.reduce((a, b) => a + b, 0) / times.length
        };
    },

    // Called by app.js when a pong arrives — filter by target peer
    handlePong(peerId, msg) {
        if (SpeedTest._targetPeerId && peerId !== SpeedTest._targetPeerId) return;
        const resolve = SpeedTest._pingResolves[msg.id];
        if (resolve) resolve(msg);
    },

    // UI helpers
    _setStatus(text) {
        const el = document.getElementById('speed-status');
        el.textContent = text;
        el.classList.remove('hidden');
    },

    _clearResults() {
        document.getElementById('speed-results').innerHTML = '';
    },

    _addCard(label, value, unit, state) {
        const container = document.getElementById('speed-results');
        const card = document.createElement('div');
        card.className = 'speed-card ' + state;

        const labelEl = document.createElement('div');
        labelEl.className = 'label';
        labelEl.textContent = label;

        const valueEl = document.createElement('div');
        valueEl.className = 'value';
        valueEl.textContent = value;

        const unitEl = document.createElement('span');
        unitEl.className = 'unit';
        unitEl.textContent = unit;
        valueEl.appendChild(unitEl);

        card.appendChild(labelEl);
        card.appendChild(valueEl);
        container.appendChild(card);
    },

    _updateCard(index, value, unit, state) {
        const cards = document.querySelectorAll('.speed-card');
        if (cards[index]) {
            cards[index].className = 'speed-card ' + state;
            const valueEl = cards[index].querySelector('.value');
            valueEl.textContent = value;
            const newUnit = document.createElement('span');
            newUnit.className = 'unit';
            newUnit.textContent = unit;
            valueEl.appendChild(newUnit);
        }
    }
};
