// signal.js — SDP compression/decompression for QR code transport

const Signal = {
    encode(desc) {
        const typePrefix = desc.type === 'offer' ? 'O' : 'A';
        const compressed = pako.deflate(desc.sdp);
        const base64 = Signal._uint8ToBase64url(compressed);
        const full = typePrefix + base64;

        if (full.length <= 2500) {
            return full;
        }

        // Tier 2: semantic extraction for oversized SDPs
        return typePrefix + Signal._encodeMinimal(desc);
    },

    decode(encoded) {
        const type = encoded[0] === 'O' ? 'offer' : 'answer';
        const payload = encoded.slice(1);

        if (payload[0] === 'M') {
            const sdp = Signal._decodeMinimal(payload);
            return { type, sdp };
        }

        const compressed = Signal._base64urlToUint8(payload);
        const sdp = pako.inflate(compressed, { to: 'string' });
        return { type, sdp };
    },

    _encodeMinimal(desc) {
        const lines = desc.sdp.split('\r\n');
        const data = { ufrag: '', pwd: '', fp: '', setup: '', candidates: [] };

        for (const line of lines) {
            if (line.startsWith('a=ice-ufrag:')) data.ufrag = line.slice(12);
            else if (line.startsWith('a=ice-pwd:')) data.pwd = line.slice(10);
            else if (line.startsWith('a=fingerprint:sha-256 ')) data.fp = line.slice(22);
            else if (line.startsWith('a=setup:')) data.setup = line.slice(8);
            else if (line.startsWith('a=candidate:')) data.candidates.push(line.slice(12));
        }

        const json = JSON.stringify(data);
        const compressed = pako.deflate(json);
        return 'M' + Signal._uint8ToBase64url(compressed);
    },

    _decodeMinimal(payload) {
        const compressed = Signal._base64urlToUint8(payload.slice(1));
        const json = pako.inflate(compressed, { to: 'string' });
        const data = JSON.parse(json);

        return [
            'v=0',
            'o=- 0 0 IN IP4 0.0.0.0',
            's=-',
            't=0 0',
            'a=group:BUNDLE 0',
            'a=extmap-allow-mixed',
            'a=msid-semantic:WMS',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
            'c=IN IP4 0.0.0.0',
            'a=ice-ufrag:' + data.ufrag,
            'a=ice-pwd:' + data.pwd,
            'a=ice-options:trickle',
            'a=fingerprint:sha-256 ' + data.fp,
            'a=setup:' + data.setup,
            'a=mid:0',
            'a=sctp-port:5000',
            'a=max-message-size:262144',
            ...data.candidates.map(c => 'a=candidate:' + c),
            ''
        ].join('\r\n');
    },

    _uint8ToBase64url(uint8) {
        let binary = '';
        for (let i = 0; i < uint8.length; i++) {
            binary += String.fromCharCode(uint8[i]);
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },

    _base64urlToUint8(str) {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        const binary = atob(str);
        const uint8 = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            uint8[i] = binary.charCodeAt(i);
        }
        return uint8;
    }
};
