// stats-explorer.js — Raw WebRTC stats viewer

const StatsExplorer = {
    _interval: null,
    _running: false,

    init() {
        document.getElementById('btn-stats-start').addEventListener('click', () => StatsExplorer.start());
        document.getElementById('btn-stats-stop').addEventListener('click', () => StatsExplorer.stop());
        document.getElementById('stats-type-filter').addEventListener('change', () => {
            if (StatsExplorer._running) StatsExplorer._poll();
        });
    },

    start() {
        if (StatsExplorer._running) return;
        StatsExplorer._running = true;
        document.getElementById('btn-stats-start').classList.add('hidden');
        document.getElementById('btn-stats-stop').classList.remove('hidden');
        StatsExplorer._poll();
        StatsExplorer._interval = setInterval(() => StatsExplorer._poll(), 1000);
    },

    stop() {
        StatsExplorer._running = false;
        if (StatsExplorer._interval) {
            clearInterval(StatsExplorer._interval);
            StatsExplorer._interval = null;
        }
        document.getElementById('btn-stats-start').classList.remove('hidden');
        document.getElementById('btn-stats-stop').classList.add('hidden');
    },

    async _poll() {
        const peerId = document.getElementById('stats-peer-select').value;
        if (!peerId) {
            document.getElementById('stats-dump').textContent = 'No peer selected';
            return;
        }

        const conn = PeerManager.get(peerId);
        if (!conn) {
            document.getElementById('stats-dump').textContent = 'Peer not found';
            return;
        }

        const pc = conn.getRTCPeerConnection();
        if (!pc) {
            document.getElementById('stats-dump').textContent = 'No RTCPeerConnection';
            return;
        }

        try {
            const stats = await pc.getStats();
            const filter = document.getElementById('stats-type-filter').value;
            const grouped = {};

            stats.forEach((report) => {
                if (filter && report.type !== filter) return;

                if (!grouped[report.type]) grouped[report.type] = [];
                grouped[report.type].push(report);
            });

            let output = '';
            const timestamp = new Date().toLocaleTimeString();
            output += '=== Stats @ ' + timestamp + ' ===\n\n';

            const types = Object.keys(grouped).sort();
            for (const type of types) {
                output += '--- ' + type + ' (' + grouped[type].length + ') ---\n';
                for (const report of grouped[type]) {
                    const entries = Object.entries(report).filter(([k]) => k !== 'type');
                    for (const [key, value] of entries) {
                        output += '  ' + key + ': ' + value + '\n';
                    }
                    output += '\n';
                }
            }

            if (!output.includes('---')) {
                output += '(no reports' + (filter ? ' matching filter "' + filter + '"' : '') + ')\n';
            }

            const dump = document.getElementById('stats-dump');
            dump.textContent = output;

            if (document.getElementById('stats-autoscroll').checked) {
                dump.scrollTop = dump.scrollHeight;
            }
        } catch (err) {
            document.getElementById('stats-dump').textContent = 'Error: ' + err.message;
        }
    }
};
