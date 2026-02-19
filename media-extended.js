// media-extended.js — Extended media features

const MediaExtended = {
    _screenStream: null,
    _audioCtx: null,
    _analyser: null,
    _vizAnimFrame: null,
    _recorder: null,
    _recordChunks: [],

    init() {
        document.getElementById('btn-media-codecs').addEventListener('click', () => MediaExtended.detectCodecs());
        document.getElementById('btn-screen-share').addEventListener('click', () => MediaExtended.startScreenShare());
        document.getElementById('btn-screen-stop').addEventListener('click', () => MediaExtended.stopScreenShare());
        document.getElementById('btn-audio-viz').addEventListener('click', () => MediaExtended.startVisualizer());
        document.getElementById('btn-audio-viz-stop').addEventListener('click', () => MediaExtended.stopVisualizer());
        document.getElementById('btn-record-start').addEventListener('click', () => MediaExtended.startRecording());
        document.getElementById('btn-record-stop').addEventListener('click', () => MediaExtended.stopRecording());
        document.getElementById('btn-res-ladder').addEventListener('click', () => MediaExtended.runResolutionLadder());
        document.getElementById('btn-bw-apply').addEventListener('click', () => MediaExtended.applyBandwidthLimit());
        document.getElementById('btn-bw-remove').addEventListener('click', () => MediaExtended.removeBandwidthLimit());
    },

    _log(id, text) {
        const el = document.getElementById(id);
        el.textContent += text + '\n';
    },

    _clear(id) {
        document.getElementById(id).textContent = '';
    },

    // === CODEC DETECTION ===

    detectCodecs() {
        MediaExtended._clear('media-codec-results');

        if (!RTCRtpSender.getCapabilities) {
            MediaExtended._log('media-codec-results', 'RTCRtpSender.getCapabilities not supported in this browser');
            return;
        }

        MediaExtended._log('media-codec-results', '--- Video Codecs ---');
        const video = RTCRtpSender.getCapabilities('video');
        if (video && video.codecs) {
            for (const codec of video.codecs) {
                let line = '  ' + codec.mimeType;
                if (codec.clockRate) line += '  ' + codec.clockRate + ' Hz';
                if (codec.sdpFmtpLine) line += '  ' + codec.sdpFmtpLine;
                MediaExtended._log('media-codec-results', line);
            }
        }

        MediaExtended._log('media-codec-results', '\n--- Audio Codecs ---');
        const audio = RTCRtpSender.getCapabilities('audio');
        if (audio && audio.codecs) {
            for (const codec of audio.codecs) {
                let line = '  ' + codec.mimeType;
                if (codec.clockRate) line += '  ' + codec.clockRate + ' Hz';
                if (codec.channels) line += '  ' + codec.channels + ' ch';
                if (codec.sdpFmtpLine) line += '  ' + codec.sdpFmtpLine;
                MediaExtended._log('media-codec-results', line);
            }
        }

        const totalVideo = video && video.codecs ? video.codecs.length : 0;
        const totalAudio = audio && audio.codecs ? audio.codecs.length : 0;
        MediaExtended._log('media-codec-results', '\nTotal: ' + totalVideo + ' video, ' + totalAudio + ' audio');
    },

    // === SCREEN SHARING ===

    async startScreenShare() {
        const peerId = document.getElementById('media-peer-select').value;
        if (!peerId) { alert('No peer selected'); return; }

        const conn = PeerManager.get(peerId);
        if (!conn) { alert('Peer not connected'); return; }

        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            MediaExtended._screenStream = stream;

            const pc = conn.getRTCPeerConnection();
            for (const track of stream.getTracks()) {
                pc.addTrack(track, stream);
                // Handle user stopping via browser UI
                track.onended = () => MediaExtended.stopScreenShare();
            }

            document.getElementById('btn-screen-share').classList.add('hidden');
            document.getElementById('btn-screen-stop').classList.remove('hidden');
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                alert('Screen share failed: ' + err.message);
            }
        }
    },

    stopScreenShare() {
        if (MediaExtended._screenStream) {
            for (const track of MediaExtended._screenStream.getTracks()) {
                track.stop();
            }
            MediaExtended._screenStream = null;
        }

        document.getElementById('btn-screen-share').classList.remove('hidden');
        document.getElementById('btn-screen-stop').classList.add('hidden');
    },

    // === AUDIO VISUALIZER ===

    startVisualizer() {
        // Find a remote audio stream
        const remoteVideos = document.getElementById('remote-videos');
        const videoEl = remoteVideos.querySelector('video');
        if (!videoEl || !videoEl.srcObject) {
            alert('No active remote stream. Start a media call first.');
            return;
        }

        const stream = videoEl.srcObject;
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            alert('No audio track in remote stream');
            return;
        }

        if (!MediaExtended._audioCtx) {
            MediaExtended._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = MediaExtended._audioCtx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        MediaExtended._analyser = analyser;

        document.getElementById('btn-audio-viz').classList.add('hidden');
        document.getElementById('btn-audio-viz-stop').classList.remove('hidden');

        const canvas = document.getElementById('audio-visualizer');
        const canvasCtx = canvas.getContext('2d');
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            MediaExtended._vizAnimFrame = requestAnimationFrame(draw);

            analyser.getByteFrequencyData(dataArray);

            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvasCtx.scale(dpr, dpr);

            const w = rect.width;
            const h = rect.height;

            canvasCtx.fillStyle = '#0f172a';
            canvasCtx.fillRect(0, 0, w, h);

            const barWidth = (w / bufferLength) * 2.5;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const barHeight = (dataArray[i] / 255) * h;

                const hue = (i / bufferLength) * 240;
                canvasCtx.fillStyle = 'hsl(' + hue + ', 70%, 50%)';
                canvasCtx.fillRect(x, h - barHeight, barWidth, barHeight);

                x += barWidth + 1;
            }
        };

        draw();
    },

    stopVisualizer() {
        if (MediaExtended._vizAnimFrame) {
            cancelAnimationFrame(MediaExtended._vizAnimFrame);
            MediaExtended._vizAnimFrame = null;
        }
        MediaExtended._analyser = null;

        document.getElementById('btn-audio-viz').classList.remove('hidden');
        document.getElementById('btn-audio-viz-stop').classList.add('hidden');

        // Clear canvas
        const canvas = document.getElementById('audio-visualizer');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    },

    // === RECORDING ===

    startRecording() {
        const remoteVideos = document.getElementById('remote-videos');
        const videoEl = remoteVideos.querySelector('video');
        if (!videoEl || !videoEl.srcObject) {
            alert('No active remote stream. Start a media call first.');
            return;
        }

        const stream = videoEl.srcObject;
        MediaExtended._recordChunks = [];

        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : MediaRecorder.isTypeSupported('video/webm')
                ? 'video/webm'
                : '';

        try {
            const options = mimeType ? { mimeType } : {};
            MediaExtended._recorder = new MediaRecorder(stream, options);
        } catch (e) {
            alert('MediaRecorder not supported: ' + e.message);
            return;
        }

        MediaExtended._recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                MediaExtended._recordChunks.push(event.data);
            }
        };

        MediaExtended._recorder.onstop = () => {
            const blob = new Blob(MediaExtended._recordChunks, { type: mimeType || 'video/webm' });
            const url = URL.createObjectURL(blob);

            const container = document.getElementById('recording-downloads');
            const link = document.createElement('a');
            link.href = url;
            link.download = 'recording-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.webm';
            link.className = 'file-download';
            link.textContent = link.download + ' (' + MediaExtended._formatBytes(blob.size) + ')';
            container.appendChild(link);
        };

        MediaExtended._recorder.start(1000); // Collect data every second

        document.getElementById('btn-record-start').classList.add('hidden');
        document.getElementById('btn-record-stop').classList.remove('hidden');
    },

    stopRecording() {
        if (MediaExtended._recorder && MediaExtended._recorder.state !== 'inactive') {
            MediaExtended._recorder.stop();
        }
        MediaExtended._recorder = null;

        document.getElementById('btn-record-start').classList.remove('hidden');
        document.getElementById('btn-record-stop').classList.add('hidden');
    },

    // === RESOLUTION LADDER ===

    async runResolutionLadder() {
        const peerId = document.getElementById('media-peer-select').value;
        if (!peerId) { alert('No peer selected'); return; }

        const conn = PeerManager.get(peerId);
        if (!conn) { alert('Peer not connected'); return; }

        const pc = conn.getRTCPeerConnection();
        if (!pc) { alert('No peer connection'); return; }

        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (!videoSender) {
            alert('No active video sender. Start a video call first.');
            return;
        }

        MediaExtended._clear('res-ladder-results');
        MediaExtended._log('res-ladder-results', 'Running resolution ladder test...\n');

        const steps = [
            { label: '240p', width: 320, height: 240 },
            { label: '360p', width: 640, height: 360 },
            { label: '480p', width: 640, height: 480 },
            { label: '720p', width: 1280, height: 720 },
            { label: '1080p', width: 1920, height: 1080 }
        ];

        MediaExtended._log('res-ladder-results', 'Target     Actual      Bitrate');
        MediaExtended._log('res-ladder-results', '------     ------      -------');

        for (const step of steps) {
            try {
                await videoSender.track.applyConstraints({
                    width: { ideal: step.width },
                    height: { ideal: step.height }
                });

                // Wait for adaptation
                await new Promise(r => setTimeout(r, 3000));

                // Read stats
                const stats = await pc.getStats();
                let actualRes = '?';
                let bitrate = '?';

                stats.forEach((report) => {
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        if (report.frameWidth && report.frameHeight) {
                            actualRes = report.frameWidth + 'x' + report.frameHeight;
                        }
                    }
                });

                MediaExtended._log('res-ladder-results',
                    step.label.padEnd(11) +
                    actualRes.padEnd(12) +
                    bitrate);
            } catch (e) {
                MediaExtended._log('res-ladder-results',
                    step.label.padEnd(11) + 'FAILED: ' + e.message);
            }
        }

        MediaExtended._log('res-ladder-results', '\nTest complete.');
    },

    // === BANDWIDTH ADAPTATION ===

    async applyBandwidthLimit() {
        const peerId = document.getElementById('media-peer-select').value;
        if (!peerId) { alert('No peer selected'); return; }

        const conn = PeerManager.get(peerId);
        if (!conn) { alert('Peer not connected'); return; }

        const pc = conn.getRTCPeerConnection();
        if (!pc) { alert('No peer connection'); return; }

        const maxBitrate = parseInt(document.getElementById('bw-limit').value) * 1000; // Convert kbps to bps
        if (!maxBitrate || maxBitrate <= 0) { alert('Enter a valid bitrate'); return; }

        MediaExtended._clear('bw-results');

        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (!videoSender) {
            MediaExtended._log('bw-results', 'No active video sender. Start a video call first.');
            return;
        }

        try {
            const params = videoSender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = maxBitrate;
            await videoSender.setParameters(params);

            MediaExtended._log('bw-results', 'Bandwidth limit applied: ' + (maxBitrate / 1000) + ' kbps');
            MediaExtended._log('bw-results', 'Wait a few seconds for adaptation...');

            // Check after delay
            await new Promise(r => setTimeout(r, 3000));
            const stats = await pc.getStats();
            stats.forEach((report) => {
                if (report.type === 'outbound-rtp' && report.kind === 'video') {
                    if (report.bytesSent) {
                        MediaExtended._log('bw-results', 'Current encoder: ' + (report.qualityLimitationReason || 'none'));
                    }
                }
            });
        } catch (e) {
            MediaExtended._log('bw-results', 'Error: ' + e.message);
        }
    },

    async removeBandwidthLimit() {
        const peerId = document.getElementById('media-peer-select').value;
        if (!peerId) return;

        const conn = PeerManager.get(peerId);
        if (!conn) return;

        const pc = conn.getRTCPeerConnection();
        if (!pc) return;

        MediaExtended._clear('bw-results');

        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (!videoSender) {
            MediaExtended._log('bw-results', 'No active video sender');
            return;
        }

        try {
            const params = videoSender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
                delete params.encodings[0].maxBitrate;
            }
            await videoSender.setParameters(params);
            MediaExtended._log('bw-results', 'Bandwidth limit removed');
        } catch (e) {
            MediaExtended._log('bw-results', 'Error: ' + e.message);
        }
    },

    // === UTILITY ===

    _formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }
};
