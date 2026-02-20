# P2P WebRTC Framework

A serverless, QR-code-signaled peer-to-peer mesh networking library for the browser. No build step, no server required beyond static file hosting.

---

## File inventory

### Framework files — copy these into a new project

| File | Purpose |
|------|---------|
| `peer.js` | Core: `PeerConnection` class + `PeerManager` singleton |
| `signal.js` | SDP encoder/decoder (pako compression → base64url) |
| `qr.js` | QR generation with multi-part cycling + scanning *(optional — see [Swapping the transport](#swapping-the-signaling-transport))* |

### CDN dependencies (required by framework files)

```html
<!-- Required by signal.js -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js"></script>

<!-- Required by qr.js -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
```

### App-specific files — do not copy

`app.js`, `speedtest.js`, `stats-explorer.js`, `datachannel-tests.js`, `network-tests.js`, `media-extended.js`, `tools.js`, `ice-config.js`

---

## Connection flow

```
Device A (offerer)                             Device B (joiner)
─────────────────                              ─────────────────
PeerManager.createOffer()
  → encodes SDP with Signal.encode()
  → shows QR via QR.generate()
                          ── scan QR ──>
                                               QR.scan() → Signal.decode()
                                               PeerManager.processOfferAndCreateAnswer()
                                                 → Signal.encode(answer)
                                                 → QR.generate(answer)
                          <── scan QR ──
PeerManager.processAnswer()
                          ── data channel open ──>
                          <── introduce message ──>
onPeerJoined fires on both sides; peerId promoted from temp-xxxx to real ID
```

**Mesh joining**: when a third device connects to either A or B, the connected peer forwards a `peer-list` message. The new device automatically creates relay offers through the existing peer, completing the full mesh without further QR scanning.

---

## PeerManager API

### Initialisation

```js
PeerManager.init(name)
PeerManager.init(name, savedId, savedName)  // restore a previous session identity
```

Call once before any other method. `name` is the local display name (empty string for auto-generated). `savedId`/`savedName` are used to restore identity after a page reload (see Session persistence below).

```js
PeerManager.setIceServers(servers)
```

Set the ICE server list (array of `RTCIceServer` objects). Call before creating any connections. Defaults to `[]` (LAN-only). For remote connections use STUN/TURN servers.

```js
// Example — Google STUN + Open Relay TURN
PeerManager.setIceServers([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
]);
```

---

### Signaling (offer/answer exchange)

These three async methods cover the full initial handshake. They return the SDP descriptor; your code passes it through whatever transport you choose (QR, NFC, WebSocket, copy-paste, etc.).

```js
// Device A: create an offer
const { connId, desc } = await PeerManager.createOffer();
// connId  — opaque token, keep it; pass to processAnswer later
// desc    — RTCSessionDescription (type: 'offer')

// Device B: receive the offer, produce an answer
const { connId, desc } = await PeerManager.processOfferAndCreateAnswer(offerSdp);
// offerSdp — the raw SDP string from Signal.decode(scannedData).sdp

// Device A: receive the answer
await PeerManager.processAnswer(connId, answerSdp);
// connId   — the token returned by createOffer()
// answerSdp — Signal.decode(scannedData).sdp
```

---

### Callbacks

Assign these before creating any connections. All are optional (unassigned callbacks are silently skipped).

```js
// Peer lifecycle
PeerManager.onPeerJoined  = (peerId, name) => {}   // connection fully established
PeerManager.onPeerLeft    = (peerId) => {}          // peer closed cleanly
PeerManager.onGoodbye     = (peerId) => {}          // peer sent intentional disconnect signal
PeerManager.onStateChange = (peerId, state) => {}   // 'connected' | 'disconnected' | 'unresponsive' | 'failed'
PeerManager.onError       = (peerId, err) => {}

// Messaging
PeerManager.onMessage     = (peerId, text) => {}    // text message received
PeerManager.onTyping      = (peerId, isTyping) => {}

// File transfer
PeerManager.onFileMetadata = (peerId, meta) => {}   // meta: { name, size, mimeType }
PeerManager.onFileChunk    = (peerId, chunk, received, total) => {}
PeerManager.onFileComplete = (peerId, blob, name) => {}

// Media
PeerManager.onRemoteStream = (peerId, stream) => {} // MediaStream from remote peer
PeerManager.onMediaStats   = (peerId, stats) => {}  // stats: { resolution, framerate, videoBitrate, audioBitrate, packetsLost, jitter, rtt }

// Speed test (internal use in this app — omit if not needed)
PeerManager.onPong     = (peerId, msg) => {}
PeerManager.onSpeedData = (peerId, received, expected) => {}
PeerManager.onSpeedEnd  = (peerId, result) => {}    // result: { bytes, ms }

// Raw data channel (advanced)
PeerManager.onDataChannel = (peerId, dataChannel) => {} // secondary RTCDataChannel opened by remote
```

---

### Sending data

```js
// Broadcast to all connected peers
PeerManager.broadcastMessage(text)       // → bool (true if sent to at least one peer)
PeerManager.broadcastRaw(obj)            // send any JSON-serialisable object
PeerManager.broadcastTyping(isTyping)    // convenience for typing indicators
PeerManager.broadcastGoodbye()           // signal intentional disconnect before closing

// Targeted (single peer)
PeerManager.sendRaw(peerId, obj)         // send raw JSON to one peer → bool
PeerManager.sendFile(peerId, file)       // → Promise<void>  (File object)
PeerManager.sendPing(peerId, id)         // latency probe
```

---

### Custom message types

Register handlers on individual connections for application-specific message types. Call this inside `onPeerJoined`.

```js
PeerManager.onPeerJoined = (peerId, name) => {
    const conn = PeerManager.get(peerId);
    conn.registerHandler('my-event', (peerId, msg) => {
        console.log('Received my-event from', peerId, msg);
    });
};

// Send:
PeerManager.sendRaw(peerId, { type: 'my-event', payload: 'hello' });
// or broadcast to all:
PeerManager.broadcastRaw({ type: 'my-event', payload: 'hello' });
```

`registerHandler` is per-connection, so register it for every new peer in `onPeerJoined`.

---

### Media (WebRTC tracks)

```js
// Start sending local media to a peer
const stream = await PeerManager.startMedia(peerId, constraints);
// constraints — standard MediaStreamConstraints e.g.
//   { video: true, audio: true }
//   { video: true }
//   { audio: true }
// stream — the local MediaStream (attach to a <video> element)

// Stop sending local media (leaves remote stream intact)
PeerManager.stopMedia(peerId);
```

Remote streams arrive via `onRemoteStream`. The connection renegotiates automatically (via the data channel) when tracks are added or removed — no additional QR exchange is needed.

To start stats polling without sending (receive-only):
```js
PeerManager.onRemoteStream = (peerId, stream) => {
    const conn = PeerManager.get(peerId);
    conn.ensureStatsPolling();  // stats fire via onMediaStats
};
```

---

### Peer inspection

```js
PeerManager.get(peerId)             // → PeerConnection | null
PeerManager.getConnectedPeers()     // → Array<{ peerId, name, state, stats }>
// stats: { messagesSent, messagesReceived, bytesSent, bytesReceived, heartbeatState }
```

---

### Advanced: secondary data channels

For protocols that need separate channels (different ordering/reliability):

```js
// Offerer side — create before or after connection (triggers renegotiation if after)
const conn = PeerManager.get(peerId);
const dc = conn.createDataChannel('my-channel', { ordered: false, maxRetransmits: 0 });
dc.onmessage = (e) => { ... };

// Joiner side — register handler before the channel arrives
conn.registerDataChannelHandler('my-channel', (dc) => {
    dc.onmessage = (e) => { ... };
});

// OR handle all unexpected channels globally
PeerManager.onDataChannel = (peerId, dc) => { ... };
```

---

### Cleanup

```js
PeerManager.closeOne(peerId)  // close one connection, fires onPeerLeft
PeerManager.closeAll()        // close everything (no callbacks fired)
```

---

## Signal API

Encodes an `RTCSessionDescription` into a compact, URL-safe string suitable for QR codes or any text transport. Uses pako (zlib) compression + base64url encoding. For very large SDPs it falls back to extracting only the essential ICE fields.

```js
const encoded = Signal.encode(desc);
// desc    — RTCSessionDescription returned by createOffer / createAnswer / localDescription
// returns — string, typically 200–800 chars

const { sdp, type } = Signal.decode(encoded);
// sdp  — raw SDP string, pass to processOfferAndCreateAnswer / processAnswer
// type — 'offer' | 'answer'
```

**Dependency**: requires `pako` to be loaded first.

---

## QR API

### Display

```js
QR.generate(containerId, encodedData);
// Renders a large single QR inside the element with id=containerId.
// Below it, automatically appends a cycling multi-part fallback section
// for devices with weaker cameras.

QR.stopDisplay();
// Stops cycling timer and removes the multi-part section from the DOM.
// Call before scanning so the scanner can use the container.
```

### Scan

```js
const encodedData = await QR.scan(containerId);
// Opens the rear camera inside the element with id=containerId.
// Handles single QR codes and multi-part cycling QR sequences automatically.
// Resolves with the assembled encoded string.

await QR.stopScanner();
// Stops an in-progress scan and releases the camera.
```

**Dependencies**: requires `qrcodejs` and `html5-qrcode` to be loaded first.

---

## Minimal integration example

This is the smallest complete app — two pages (offerer and joiner) wired together.

```html
<!DOCTYPE html>
<html>
<body>
  <!-- Offerer UI -->
  <div id="offerer">
    <button id="btn-create">Create connection</button>
    <div id="qr-offer"></div>
    <button id="btn-scan-answer" style="display:none">Scan their response</button>
    <div id="scanner-answer" style="width:300px;height:300px"></div>
  </div>

  <!-- Joiner UI -->
  <div id="joiner" style="display:none">
    <button id="btn-join">Join connection</button>
    <div id="scanner-offer" style="width:300px;height:300px"></div>
    <div id="qr-answer"></div>
  </div>

  <!-- Connected UI -->
  <div id="connected" style="display:none">
    <p id="peer-name"></p>
    <input id="msg" type="text" placeholder="Message">
    <button id="btn-send">Send</button>
    <div id="log"></div>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <script src="signal.js"></script>
  <script src="qr.js"></script>
  <script src="peer.js"></script>
  <script>
    PeerManager.init('');

    PeerManager.onPeerJoined = (peerId, name) => {
        document.getElementById('offerer').style.display = 'none';
        document.getElementById('joiner').style.display = 'none';
        document.getElementById('connected').style.display = '';
        document.getElementById('peer-name').textContent = 'Connected to: ' + name;
    };

    PeerManager.onMessage = (peerId, text) => {
        const log = document.getElementById('log');
        log.insertAdjacentHTML('beforeend', '<p><b>Them:</b> ' + text + '</p>');
    };

    // ─── Offerer flow ───
    let offererConnId;

    document.getElementById('btn-create').addEventListener('click', async () => {
        const { connId, desc } = await PeerManager.createOffer();
        offererConnId = connId;
        QR.generate('qr-offer', Signal.encode(desc));
        document.getElementById('btn-scan-answer').style.display = '';
    });

    document.getElementById('btn-scan-answer').addEventListener('click', async () => {
        QR.stopDisplay();
        const data = await QR.scan('scanner-answer');
        const { sdp } = Signal.decode(data);
        await PeerManager.processAnswer(offererConnId, sdp);
    });

    // ─── Joiner flow ───
    document.getElementById('btn-join').addEventListener('click', async () => {
        document.getElementById('joiner').style.display = '';
        const data = await QR.scan('scanner-offer');
        const { sdp } = Signal.decode(data);
        const { connId, desc } = await PeerManager.processOfferAndCreateAnswer(sdp);
        QR.generate('qr-answer', Signal.encode(desc));
    });

    // ─── Messaging ───
    document.getElementById('btn-send').addEventListener('click', () => {
        const input = document.getElementById('msg');
        const text = input.value.trim();
        if (!text) return;
        PeerManager.broadcastMessage(text);
        document.getElementById('log').insertAdjacentHTML('beforeend', '<p><b>You:</b> ' + text + '</p>');
        input.value = '';
    });
  </script>
</body>
</html>
```

---

## Swapping the signaling transport

`Signal.encode` / `Signal.decode` produce and consume plain strings. `QR` is just one transport for those strings — it can be replaced with anything that moves a string from one device to another.

| Transport | Notes |
|-----------|-------|
| **QR codes** | Current default. Works offline, no server, all platforms |
| **Copy-paste** | `<textarea>` — zero dependencies, good for desktop testing |
| **WebSocket relay** | Server required; removes the manual scan step |
| **NFC** | Web NFC API; Android Chrome only; physical NFC tag required |
| **URL / deep link** | Encode SDP as a URL query param; share via any app |
| **Bluetooth** | Web Bluetooth has no raw transport API; not feasible |

To use copy-paste instead of QR, replace `QR.generate` / `QR.scan`:

```js
// Display
document.getElementById('offer-text').value = Signal.encode(desc);

// Receive
const encoded = document.getElementById('offer-text').value.trim();
const { sdp } = Signal.decode(encoded);
```

---

## Session persistence (reconnection after page reload)

The framework itself has no persistence — `PeerManager.init()` generates a fresh identity each call. To restore a session after a reload, save and restore `_localId` / `_localName` yourself:

```js
// Before unload — save identity and peer list
window.addEventListener('beforeunload', () => {
    sessionStorage.setItem('p2p-session', JSON.stringify({
        localId:   PeerManager._localId,
        localName: PeerManager._localName,
        peers:     PeerManager.getConnectedPeers().map(p => ({ peerId: p.peerId, name: p.name })),
        timestamp: Date.now()
    }));
});

// On load — restore identity so the other peer recognises you
const raw = sessionStorage.getItem('p2p-session');
if (raw) {
    const s = JSON.parse(raw);
    if (Date.now() - s.timestamp < 120000) {
        PeerManager.init('', s.localId, s.localName);
        // Then re-run the normal signaling flow (QR exchange) to reconnect
    }
}
```

The surviving peer must also re-create an offer — that is what the reconnect modal in this test app handles.

---

## Heartbeat and connection health

`PeerManager` sends a `heartbeat` message every 3 seconds and expects an `ack` back.

| Constant | Default | Effect |
|----------|---------|--------|
| `PeerManager.HEARTBEAT_INTERVAL` | 3000 ms | How often to ping |
| `PeerManager.HEARTBEAT_TIMEOUT` | 10000 ms | How long before `onStateChange(peerId, 'unresponsive')` |

When a data channel closes (network drop, tab close), `onStateChange(peerId, 'disconnected')` fires. There is no automatic reconnect inside the framework — that is application logic (see how `App._startGracePeriod` handles it in `app.js`).
