# P2P Connect

A pure JavaScript peer-to-peer app that connects two phones using QR codes — no signaling server, no accounts, no infrastructure beyond a static web page.

Devices exchange WebRTC signaling data by scanning QR codes from each other's screens. Once connected, they communicate directly over a P2P data channel and media streams.

## How It Works

```
Phone A: "Create Connection"          Phone B: "Join Connection"
  |                                      |
  Create WebRTC offer                    |
  Compress SDP → QR code  ----------->  Scan QR with camera
  |                                      Create answer → QR code
  Scan QR with camera  <--------------  Show answer QR
  |                                      |
  v                                      v
         Direct P2P connection
         Messages, files, video, speed tests
```

1. **Phone A** creates a WebRTC offer, compresses it, and displays it as a QR code
2. **Phone B** scans that QR, generates an answer, and displays its own QR code
3. **Phone A** scans Phone B's QR code — connection established
4. Both devices can now exchange data directly with no server in between

## Features

- **Text Messaging** — real-time chat over the data channel
- **File Transfer** — send files of any size with progress tracking
- **Speed Testing** — latency (ping), throughput (1MB/10MB), and sustained transfer benchmarks
- **Media Streaming** — live video and audio via WebRTC media tracks with real-time stats (bitrate, resolution, packet loss, jitter)

## Requirements

- Two devices on the **same WiFi network** (LAN only, no STUN/TURN)
- A modern browser with WebRTC support (Chrome, Safari, Firefox)

## Tech Stack

- **Pure vanilla JavaScript** — no frameworks, no build tools
- **WebRTC** — RTCPeerConnection for P2P data channels and media streams
- **pako** — deflate compression to fit SDP into QR codes
- **QRCode.js** — QR code generation
- **html5-qrcode** — camera-based QR code scanning

## Deployment

Hosted via GitHub Pages with HTTPS provided automatically.

## Why?

This is a test bed for low-infrastructure, low-environmental-power distributed applications — synchronising data between accounts, sharing files, or communicating without relying on centralised servers.
