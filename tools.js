// tools.js — Utility tools (clipboard, whiteboard, encryption, geo, sensors)

const Tools = {
    _sensorInterval: null,
    _whiteboardDrawing: false,
    _whiteboardCtx: null,
    _whiteboardPoints: [],
    _localGeo: null,

    init() {
        // Encryption
        document.getElementById('btn-encrypt-verify').addEventListener('click', () => Tools.verifyEncryption());

        // Clipboard
        document.getElementById('btn-clipboard-send').addEventListener('click', () => Tools.sendClipboard());

        // Geolocation
        document.getElementById('btn-geo-share').addEventListener('click', () => Tools.shareLocation());

        // Whiteboard
        Tools._initWhiteboard();
        document.getElementById('btn-wb-clear').addEventListener('click', () => Tools.clearWhiteboard());

        // Sensors
        document.getElementById('btn-sensor-start').addEventListener('click', () => Tools.startSensors());
        document.getElementById('btn-sensor-stop').addEventListener('click', () => Tools.stopSensors());
    },

    registerHandlers(conn) {
        conn.registerHandler('clipboard-sync', (peerId, msg) => Tools._handleClipboard(peerId, msg));
        conn.registerHandler('geo-share', (peerId, msg) => Tools._handleGeo(peerId, msg));
        conn.registerHandler('whiteboard-draw', (peerId, msg) => Tools._handleWhiteboard(peerId, msg));
        conn.registerHandler('sensor-data', (peerId, msg) => Tools._handleSensor(peerId, msg));
    },

    _log(id, text) {
        const el = document.getElementById(id);
        el.textContent += text + '\n';
    },

    _clear(id) {
        document.getElementById(id).textContent = '';
    },

    // === ENCRYPTION VERIFICATION ===

    verifyEncryption() {
        const peerId = document.getElementById('encrypt-peer-select').value;
        if (!peerId) { alert('No peer selected'); return; }

        const conn = PeerManager.get(peerId);
        if (!conn) { alert('Peer not connected'); return; }

        Tools._clear('encrypt-results');

        const pc = conn.getRTCPeerConnection();
        if (!pc) {
            Tools._log('encrypt-results', 'No RTCPeerConnection');
            return;
        }

        const localSdp = pc.localDescription ? pc.localDescription.sdp : '';
        const remoteSdp = pc.remoteDescription ? pc.remoteDescription.sdp : '';

        const extractFingerprint = (sdp) => {
            const match = sdp.match(/a=fingerprint:(\S+ \S+)/);
            return match ? match[1] : 'Not found';
        };

        const localFp = extractFingerprint(localSdp);
        const remoteFp = extractFingerprint(remoteSdp);

        Tools._log('encrypt-results', 'DTLS Encryption Verification\n');
        Tools._log('encrypt-results', 'Local fingerprint:');
        Tools._log('encrypt-results', '  ' + localFp);
        Tools._log('encrypt-results', '');
        Tools._log('encrypt-results', 'Remote fingerprint:');
        Tools._log('encrypt-results', '  ' + remoteFp);
        Tools._log('encrypt-results', '');

        // Check DTLS transport state
        const sctpTransport = pc.sctp;
        if (sctpTransport && sctpTransport.transport) {
            Tools._log('encrypt-results', 'DTLS state: ' + sctpTransport.transport.state);
        }

        Tools._log('encrypt-results', 'Connection encrypted: Yes (WebRTC uses mandatory DTLS)');
        Tools._log('encrypt-results', '\nVerify these fingerprints match on both devices.');
    },

    // === CLIPBOARD SYNC ===

    async sendClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) {
                alert('Clipboard is empty');
                return;
            }
            PeerManager.broadcastRaw({ type: 'clipboard-sync', text });
            alert('Clipboard sent to all peers');
        } catch (e) {
            alert('Clipboard access denied: ' + e.message);
        }
    },

    _handleClipboard(peerId, msg) {
        const container = document.getElementById('clipboard-received');
        const name = App._peerNames.get(peerId) || peerId;

        const item = document.createElement('div');
        item.style.cssText = 'background:var(--surface);border-radius:8px;padding:10px;margin-bottom:8px;';

        const header = document.createElement('div');
        header.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-bottom:4px;';
        header.textContent = 'From ' + name + ' at ' + new Date().toLocaleTimeString();

        const content = document.createElement('div');
        content.style.cssText = 'font-size:0.8125rem;word-break:break-all;white-space:pre-wrap;';
        content.textContent = msg.text;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn secondary';
        copyBtn.style.cssText = 'margin-top:6px;padding:4px 10px;font-size:0.75rem;min-height:28px;';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(msg.text).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
            });
        });

        item.appendChild(header);
        item.appendChild(content);
        item.appendChild(copyBtn);
        container.appendChild(item);
    },

    // === GEOLOCATION SHARING ===

    shareLocation() {
        if (!navigator.geolocation) {
            alert('Geolocation not supported');
            return;
        }

        Tools._clear('geo-results');
        Tools._log('geo-results', 'Getting location...');

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                const accuracy = pos.coords.accuracy;

                Tools._localGeo = { lat, lon };

                PeerManager.broadcastRaw({
                    type: 'geo-share',
                    lat,
                    lon,
                    accuracy: Math.round(accuracy)
                });

                Tools._clear('geo-results');
                Tools._log('geo-results', 'Your location shared:');
                Tools._log('geo-results', '  Latitude:  ' + lat.toFixed(6));
                Tools._log('geo-results', '  Longitude: ' + lon.toFixed(6));
                Tools._log('geo-results', '  Accuracy:  ' + Math.round(accuracy) + ' m');
            },
            (err) => {
                Tools._clear('geo-results');
                Tools._log('geo-results', 'Error: ' + err.message);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    },

    _handleGeo(peerId, msg) {
        const name = App._peerNames.get(peerId) || peerId;
        Tools._log('geo-results', '\n' + name + '\'s location:');
        Tools._log('geo-results', '  Latitude:  ' + msg.lat.toFixed(6));
        Tools._log('geo-results', '  Longitude: ' + msg.lon.toFixed(6));
        Tools._log('geo-results', '  Accuracy:  ' + msg.accuracy + ' m');

        if (Tools._localGeo) {
            const dist = Tools._haversine(Tools._localGeo.lat, Tools._localGeo.lon, msg.lat, msg.lon);
            if (dist < 1) {
                Tools._log('geo-results', '  Distance:  ' + (dist * 1000).toFixed(0) + ' m');
            } else {
                Tools._log('geo-results', '  Distance:  ' + dist.toFixed(2) + ' km');
            }
        }
    },

    _haversine(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth radius in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    },

    // === SHARED WHITEBOARD ===

    _initWhiteboard() {
        const canvas = document.getElementById('whiteboard-canvas');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        Tools._whiteboardCtx = ctx;

        // Set white background
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const getPos = (e) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            if (e.touches) {
                return {
                    x: (e.touches[0].clientX - rect.left) * scaleX,
                    y: (e.touches[0].clientY - rect.top) * scaleY
                };
            }
            return {
                x: (e.clientX - rect.left) * scaleX,
                y: (e.clientY - rect.top) * scaleY
            };
        };

        const startDraw = (e) => {
            e.preventDefault();
            Tools._whiteboardDrawing = true;
            Tools._whiteboardPoints = [getPos(e)];
        };

        const moveDraw = (e) => {
            if (!Tools._whiteboardDrawing) return;
            e.preventDefault();
            const pos = getPos(e);
            Tools._whiteboardPoints.push(pos);

            // Draw locally
            const color = document.getElementById('wb-color').value;
            const size = parseInt(document.getElementById('wb-size').value) || 3;
            const pts = Tools._whiteboardPoints;
            if (pts.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
                ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
                ctx.strokeStyle = color;
                ctx.lineWidth = size;
                ctx.lineCap = 'round';
                ctx.stroke();
            }
        };

        const endDraw = () => {
            if (!Tools._whiteboardDrawing) return;
            Tools._whiteboardDrawing = false;

            if (Tools._whiteboardPoints.length > 0) {
                const color = document.getElementById('wb-color').value;
                const size = parseInt(document.getElementById('wb-size').value) || 3;
                PeerManager.broadcastRaw({
                    type: 'whiteboard-draw',
                    action: 'stroke',
                    color,
                    size,
                    points: Tools._whiteboardPoints
                });
            }
            Tools._whiteboardPoints = [];
        };

        canvas.addEventListener('mousedown', startDraw);
        canvas.addEventListener('mousemove', moveDraw);
        canvas.addEventListener('mouseup', endDraw);
        canvas.addEventListener('mouseleave', endDraw);
        canvas.addEventListener('touchstart', startDraw, { passive: false });
        canvas.addEventListener('touchmove', moveDraw, { passive: false });
        canvas.addEventListener('touchend', endDraw);
    },

    clearWhiteboard() {
        const canvas = document.getElementById('whiteboard-canvas');
        const ctx = Tools._whiteboardCtx;
        if (ctx) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        PeerManager.broadcastRaw({ type: 'whiteboard-draw', action: 'clear' });
    },

    _handleWhiteboard(peerId, msg) {
        const canvas = document.getElementById('whiteboard-canvas');
        const ctx = Tools._whiteboardCtx;
        if (!ctx) return;

        if (msg.action === 'clear') {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return;
        }

        if (msg.action === 'stroke' && msg.points && msg.points.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(msg.points[0].x, msg.points[0].y);
            for (let i = 1; i < msg.points.length; i++) {
                ctx.lineTo(msg.points[i].x, msg.points[i].y);
            }
            ctx.strokeStyle = msg.color || '#000';
            ctx.lineWidth = msg.size || 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
        }
    },

    // === SENSOR STREAMING ===

    async startSensors() {
        // Request permission on iOS
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
            try {
                const perm = await DeviceMotionEvent.requestPermission();
                if (perm !== 'granted') {
                    alert('Motion permission denied');
                    return;
                }
            } catch (e) {
                alert('Permission request failed: ' + e.message);
                return;
            }
        }

        document.getElementById('btn-sensor-start').classList.add('hidden');
        document.getElementById('btn-sensor-stop').classList.remove('hidden');

        Tools._clear('sensor-results');
        Tools._log('sensor-results', 'Streaming sensor data at 10 Hz...\n');

        let lastAccel = null;
        let lastOrient = null;

        const motionHandler = (e) => {
            if (e.accelerationIncludingGravity) {
                lastAccel = {
                    x: (e.accelerationIncludingGravity.x || 0).toFixed(2),
                    y: (e.accelerationIncludingGravity.y || 0).toFixed(2),
                    z: (e.accelerationIncludingGravity.z || 0).toFixed(2)
                };
            }
        };

        const orientHandler = (e) => {
            lastOrient = {
                a: (e.alpha || 0).toFixed(1),
                b: (e.beta || 0).toFixed(1),
                g: (e.gamma || 0).toFixed(1)
            };
        };

        window.addEventListener('devicemotion', motionHandler);
        window.addEventListener('deviceorientation', orientHandler);

        Tools._sensorInterval = setInterval(() => {
            const data = {
                type: 'sensor-data',
                accel: lastAccel || { x: 0, y: 0, z: 0 },
                orient: lastOrient || { a: 0, b: 0, g: 0 }
            };
            PeerManager.broadcastRaw(data);

            Tools._clear('sensor-results');
            Tools._log('sensor-results', 'Streaming sensor data at 10 Hz\n');
            Tools._log('sensor-results', 'Acceleration (with gravity):');
            Tools._log('sensor-results', '  X: ' + data.accel.x + '  Y: ' + data.accel.y + '  Z: ' + data.accel.z);
            Tools._log('sensor-results', 'Orientation:');
            Tools._log('sensor-results', '  Alpha: ' + data.orient.a + '  Beta: ' + data.orient.b + '  Gamma: ' + data.orient.g);
        }, 100);

        Tools._sensorCleanup = () => {
            window.removeEventListener('devicemotion', motionHandler);
            window.removeEventListener('deviceorientation', orientHandler);
        };
    },

    stopSensors() {
        if (Tools._sensorInterval) {
            clearInterval(Tools._sensorInterval);
            Tools._sensorInterval = null;
        }
        if (Tools._sensorCleanup) {
            Tools._sensorCleanup();
            Tools._sensorCleanup = null;
        }

        document.getElementById('btn-sensor-start').classList.remove('hidden');
        document.getElementById('btn-sensor-stop').classList.add('hidden');

        Tools._log('sensor-results', '\nSensor streaming stopped.');
    },

    _sensorCleanup: null,

    _handleSensor(peerId, msg) {
        const name = App._peerNames.get(peerId) || peerId;
        const el = document.getElementById('sensor-results');

        // Update display with remote sensor data
        el.textContent = 'Remote sensor data from ' + name + ':\n\n' +
            'Acceleration (with gravity):\n' +
            '  X: ' + msg.accel.x + '  Y: ' + msg.accel.y + '  Z: ' + msg.accel.z + '\n' +
            'Orientation:\n' +
            '  Alpha: ' + msg.orient.a + '  Beta: ' + msg.orient.b + '  Gamma: ' + msg.orient.g;
    }
};
