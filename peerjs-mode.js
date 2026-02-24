// peerjs-mode.js — PeerJS-based single-scan connection mode

class PeerJSDataChannelAdapter {
    constructor(peerJsConn) {
        this._conn = peerJsConn;
        this._closeListeners = [];
        this.onmessage = null;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;

        peerJsConn.on('open', () => { if (this.onopen) this.onopen(); });
        peerJsConn.on('data', (data) => { if (this.onmessage) this.onmessage({ data }); });
        peerJsConn.on('close', () => {
            if (this.onclose) this.onclose();
            this._closeListeners.forEach(h => h());
        });
        peerJsConn.on('error', (err) => { if (this.onerror) this.onerror(err); });
    }

    get readyState() { return this._conn.open ? 'open' : 'closed'; }
    get binaryType() { return 'arraybuffer'; }
    set binaryType(_) { /* PeerJS sets this automatically with serialization:'raw' */ }

    get bufferedAmount() {
        return this._conn.dataChannel ? this._conn.dataChannel.bufferedAmount : 0;
    }
    set bufferedAmountLowThreshold(v) {
        if (this._conn.dataChannel) this._conn.dataChannel.bufferedAmountLowThreshold = v;
    }
    set onbufferedamountlow(handler) {
        if (this._conn.dataChannel) this._conn.dataChannel.onbufferedamountlow = handler;
    }

    send(data) { this._conn.send(data); }
    close() { this._conn.close(); }

    addEventListener(type, handler) {
        if (type === 'close') this._closeListeners.push(handler);
    }
    removeEventListener(type, handler) {
        if (type === 'close') {
            const idx = this._closeListeners.indexOf(handler);
            if (idx !== -1) this._closeListeners.splice(idx, 1);
        }
    }
}

const PeerJSMode = {
    _peer: null,

    // Device A: register with PeerJS, display peer ID as a URL QR code.
    // qrContainerId: element id for the QR code (default 'qr-peerjs')
    // onQRReady: called once the QR is rendered
    // onConnection: called when the incoming connection arrives (before _onConnection)
    startAsHost(qrContainerId, onQRReady, onConnection) {
        qrContainerId = qrContainerId || 'qr-peerjs';
        const peer = new Peer();
        PeerJSMode._peer = peer;

        peer.on('error', (err) => {
            App.showError('PeerJS error: ' + err.type +
                '. Ensure both devices have internet access.');
        });

        peer.on('open', (id) => {
            const url = location.origin + location.pathname + '#peerjs=' + id;
            QR.generateSingle(qrContainerId, url);
            if (onQRReady) onQRReady();
        });

        peer.on('connection', (conn) => {
            if (onConnection) onConnection();
            PeerJSMode._onConnection(conn);
        });
    },

    // Device B: called when app opens with #peerjs=ID in URL, or from in-app scan.
    // Callers are responsible for setting App.role, App._initPeerManager(), App.setState().
    joinWithId(hostId) {
        const peer = new Peer();
        PeerJSMode._peer = peer;

        peer.on('error', (err) => {
            App.showError('PeerJS connection failed: ' + err.type);
        });

        peer.on('open', () => {
            const conn = peer.connect(hostId, { serialization: 'raw' });
            conn.on('error', (err) => {
                App.showError('Could not reach peer: ' + (err.message || err.type));
            });
            PeerJSMode._onConnection(conn);
        });
    },

    // Extract a PeerJS peer ID from a URL string, or null if not a PeerJS URL
    parsePeerIdFromUrl(data) {
        const match = data.match(/#peerjs=([^&\s#]+)/);
        return match ? match[1] : null;
    },

    // Bridge a PeerJS DataConnection into the existing PeerConnection / PeerManager stack
    _onConnection(peerJsConn) {
        const adapter = new PeerJSDataChannelAdapter(peerJsConn);
        const tempId = 'peerjs-' + PeerManager._generateId();
        const conn = new PeerConnection(tempId, PeerManager._createCallbackProxy());
        conn._dc = adapter;
        conn._setupDataChannel(adapter);
        PeerManager._pendingConnections.set(tempId, conn);
    },

    cleanup() {
        if (PeerJSMode._peer) {
            PeerJSMode._peer.destroy();
            PeerJSMode._peer = null;
        }
    }
};
