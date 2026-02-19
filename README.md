# P2P Connect

A pure JavaScript peer-to-peer application that connects devices using QR codes — no signaling server, no accounts, no infrastructure beyond a static web page. Devices exchange WebRTC signaling data by scanning QR codes from each other's screens, then communicate directly over P2P data channels and media streams.

This is a test bed for low-infrastructure distributed applications — synchronising data between devices, sharing files, or communicating without relying on centralised servers.

## How It Works

```
Device A: "Create Connection"          Device B: "Join Connection"
  │                                      │
  Create WebRTC offer                    │
  Compress SDP → QR code  ──────────>  Scan QR with camera
  │                                      Create answer → QR code
  Scan QR with camera  <──────────────  Show answer QR
  │                                      │
  ▼                                      ▼
         Direct P2P connection
         Messages, files, video, tools...
```

1. **Device A** creates a WebRTC offer, compresses it, and displays it as a QR code
2. **Device B** scans that QR code, generates an answer, and displays its own QR code
3. **Device A** scans Device B's QR code — connection established
4. Both devices can now exchange data directly with no server in between

Additional devices can join the mesh at any time via the **Add Peer** button, forming a full mesh where every device connects directly to every other device.

## Features

### Messaging
- **Text chat** — broadcast messages to all connected peers, displayed in a chat log with sender names
- **Typing indicators** — real-time "X is typing..." with support for multiple peers ("X and Y are typing")
- **Camera photos** — capture photos from front or rear camera, compressed to JPEG, and sent as inline image messages (tap to view full size)

### File Transfer
- **Send files** to a selected peer with chunked transfer (16 KB chunks) and backpressure handling
- **Progress bar** for both sending and receiving
- **Download links** for received files

### Speed Test
- **Quick test** — 1 MB throughput measurement
- **Full test suite** — latency (20 ping round-trips with min/avg/max), 1 MB throughput, 10 MB throughput, and 5-second sustained throughput test

### Data Channel Tests
A suite of experiments for exploring WebRTC data channel behaviour:

- **Max message size** — binary search from 1 KB to 1 MB to find the largest single message the channel supports
- **Binary vs text throughput** — sends 1 MB as ArrayBuffer and as text strings, compares MB/s
- **Ordered vs unordered** — creates a secondary unordered channel, sends N messages on each, and compares send times and reordering on the receiver
- **Reliable vs unreliable** — compares reliable delivery vs `maxRetransmits=0` for delivery rate
- **Stress test** — floods messages at a configurable rate and duration; the remote peer reports received count, loss %, and out-of-order count
- **Concurrent transfers** — sends multiple files sequentially vs concurrently on parallel data channels, compares speedup

### Media
- **Video/audio calling** — video+audio or audio-only via getUserMedia, with local and remote video display
- **Live media stats** — resolution, framerate, video/audio bitrate, packets lost, jitter, and round-trip time (polled every second)
- **Screen sharing** — share your screen via getDisplayMedia
- **Audio visualizer** — frequency bar visualisation of incoming audio using the Web Audio API
- **Stream recording** — record the remote media stream to a downloadable WebM file
- **Codec detection** — lists all supported video and audio codecs via RTCRtpSender.getCapabilities
- **Resolution ladder** — steps through 240p → 1080p, applies constraints, and reads actual achieved resolution at each step
- **Bandwidth adaptation** — set or remove a max bitrate cap on the video encoder and observe quality adaptation

### Network
- **Mesh visualization** — canvas-rendered network graph showing all peers with colour-coded connection lines (green = connected, amber = unresponsive, red = failed)
- **Traffic statistics** — live table of per-peer messages and bytes sent/received
- **ICE candidate inspector** — gathers and displays local ICE candidates grouped by type (host, srflx, relay)
- **Connection type detection** — reports the active candidate pair: direct/reflexive/relayed, protocol (UDP/TCP), addresses, RTT, and available bandwidth
- **STUN/TURN testing** — tests reachability of arbitrary STUN or TURN server URLs
- **MTU discovery** — sends increasing-size probe messages to find the effective maximum chunk size
- **ICE restart** — triggers an ICE restart over the data channel and measures recovery time
- **Packet loss/jitter simulation** — patches incoming message handlers to randomly drop or delay messages at configurable rates (local side only)

### Stats
- **Raw WebRTC stats explorer** — polls `RTCPeerConnection.getStats()` every second, filterable by report type (candidate-pair, inbound-rtp, outbound-rtp, transport, codec, data-channel, etc.) with auto-scroll

### Tools
- **Encryption verification** — compares local and remote DTLS fingerprints and shows DTLS transport state
- **Clipboard sync** — send your clipboard text to all peers; receivers get a card with a one-click copy button
- **Geolocation sharing** — shares GPS coordinates with all peers and calculates the Haversine distance between devices
- **Shared whiteboard** — collaborative drawing canvas with colour picker and brush size; strokes are broadcast to all peers in real time
- **Sensor streaming** — streams device accelerometer and gyroscope data to peers at 10 Hz (supports the iOS permission flow)

### Connection Management
- **Multi-peer mesh** — full mesh topology where every device connects directly to every other device
- **Add Peer modal** — add new peers to the mesh without leaving the connected view
- **Auto-generated names** — devices get random names like "Brave Fox" or "Calm Owl" (or you can set your own)
- **Heartbeat monitoring** — 3-second heartbeat with 10-second timeout; peers are marked "unresponsive" if silent
- **Reconnect after refresh** — if a page is refreshed, the surviving peer shows a reconnect QR with a 60-second countdown; the refreshed peer sees a "Reconnect" prompt to restore its identity and scan back in
- **Goodbye messages** — intentional disconnects send a goodbye so peers clean up immediately instead of waiting through the grace period
- **Duplicate connection prevention** — if two peers try to connect to each other simultaneously, the deterministic tiebreaker (lexicographic peer ID comparison) keeps exactly one connection

### QR Signaling
- **SDP compression** — deflate compression + base64url encoding to fit WebRTC session descriptions into QR codes
- **Minimal encoding fallback** — for oversized SDPs (>2500 chars), extracts only the essential fields (ICE credentials, fingerprint, candidates) and compresses those instead
- **Multi-part QR cycling** — if the data is still too large for a single QR code, it auto-splits into smaller cycling QR codes (0.5s or 1s speed) with a reassembly scanner that tracks progress

## Local Network vs Remote Network

### How connectivity works

WebRTC uses ICE (Interactive Connectivity Establishment) to find a path between two devices. The type of ICE candidates available determines what works:

| Candidate type | How it's obtained | When it's available |
|---|---|---|
| **host** | Local network interfaces | Always — no server needed |
| **srflx** (server-reflexive) | A STUN server reveals your public IP | Only with a STUN server configured |
| **relay** | A TURN server relays all traffic | Only with a TURN server configured |

### What works on a local network (no servers needed)

**Everything.** When devices are on the same WiFi or LAN, WebRTC discovers direct host-to-host connections without any STUN or TURN servers. This is the primary use case — the app ships with no ICE servers configured by default.

All features listed above work on a local network:
- Messaging, photos, file transfer
- Video/audio calls, screen sharing, recording
- All speed tests and data channel experiments
- All network analysis tools
- All tools (clipboard, whiteboard, geolocation, sensors)
- Multi-peer mesh with any number of devices

Connection type detection will show **DIRECT (host-to-host)** with UDP transport.

### What's different on a remote network (across the internet)

Connecting devices on different networks (e.g. home WiFi to mobile data, or two different offices) requires NAT traversal, which needs external servers:

| Requirement | What's needed | Why |
|---|---|---|
| **NAT traversal (most cases)** | A STUN server | Devices behind NAT routers don't know their public IP. STUN reveals it so peers can find each other. Free public STUN servers exist (e.g. `stun:stun.l.google.com:19302`) |
| **Symmetric NAT / firewall** | A TURN server | When both sides are behind restrictive NATs, direct connections are impossible. TURN relays all traffic through a server. TURN servers typically cost money to run |

**To enable remote connections**, you would need to configure ICE servers by calling `PeerManager.setIceServers()` before creating a connection, e.g.:

```js
PeerManager.setIceServers([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:your-turn-server.com', username: 'user', credential: 'pass' }
]);
```

This is not currently exposed in the UI — it would require a code change or a settings panel.

### Features that become more relevant on remote networks

These features work on LAN too, but are primarily designed for diagnosing and testing remote connections:

- **STUN/TURN testing** — verifying that external servers are reachable before attempting a connection
- **Connection type detection** — will show REFLEXIVE (via STUN) or RELAYED (via TURN) instead of DIRECT
- **ICE candidate inspector** — on LAN you'll only see host candidates; with STUN/TURN configured you'll also see srflx and relay candidates
- **ICE restart** — more useful when network conditions change (e.g. switching from WiFi to mobile)
- **Bandwidth adaptation** — more relevant when bandwidth is constrained over WAN
- **Packet loss/jitter simulation** — on LAN there's typically zero loss and sub-millisecond jitter; this tool lets you simulate WAN conditions locally
- **MTU discovery** — the effective max message size may differ across network paths

### Features that are identical regardless of network

All application-level features behave the same once connected — the only difference is the underlying transport path and its performance characteristics:

- Messaging, photos, typing indicators
- File transfer
- Video/audio calling, screen sharing, recording
- Whiteboard, clipboard sync, geolocation, sensors
- Data channel experiments (binary vs text, ordered vs unordered, etc.)

The **speed test** results will differ significantly: LAN connections typically achieve 50-200+ MB/s with sub-millisecond latency, while remote connections are limited by internet bandwidth and may show 1-50 MB/s with 10-100+ ms latency.

## Tech Stack

- **Pure vanilla JavaScript** — no frameworks, no build tools, no package.json
- **WebRTC** — RTCPeerConnection for P2P data channels and media streams
- **pako** — deflate compression to fit SDP into QR codes
- **QRCode.js** — QR code generation
- **html5-qrcode** — camera-based QR code scanning

All dependencies are loaded from CDN via script tags.

## Requirements

- Two or more devices with a modern browser (Chrome, Safari, Firefox)
- A camera for QR code scanning
- HTTPS (required by WebRTC and camera APIs) — served automatically via GitHub Pages
- For local connections: devices on the same WiFi/LAN
- For remote connections: STUN/TURN servers configured (see above)

## Deployment

Serve the files over HTTPS. GitHub Pages works out of the box — push to the repository and enable Pages in settings.

For local development, use any HTTPS-capable static server. Many browsers block camera and WebRTC APIs on plain HTTP (except `localhost`).
