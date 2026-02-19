// ice-config.js — ICE server configuration UI for remote connections

const IceConfig = {
    PRESETS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],

    STORAGE_KEY: 'p2p-ice-config',

    _config: { enabled: false, customServers: [] },

    init() {
        IceConfig._loadConfig();
        IceConfig._applyConfig();
        IceConfig._bindUI();
        IceConfig._updateUI();
    },

    _loadConfig() {
        try {
            const raw = localStorage.getItem(IceConfig.STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                IceConfig._config.enabled = !!parsed.enabled;
                IceConfig._config.customServers = Array.isArray(parsed.customServers)
                    ? parsed.customServers : [];
            }
        } catch (e) {
            // ignore corrupt data
        }
    },

    _saveConfig() {
        try {
            localStorage.setItem(IceConfig.STORAGE_KEY, JSON.stringify(IceConfig._config));
        } catch (e) {
            // localStorage may be unavailable
        }
    },

    _applyConfig() {
        const servers = [];
        if (IceConfig._config.enabled) {
            servers.push(...IceConfig.PRESETS);
        }
        for (const s of IceConfig._config.customServers) {
            const entry = { urls: s.url };
            if (s.username) entry.username = s.username;
            if (s.credential) entry.credential = s.credential;
            servers.push(entry);
        }
        PeerManager.setIceServers(servers);
    },

    _bindUI() {
        const toggle = document.getElementById('ice-remote-toggle');
        if (!toggle) return;

        toggle.addEventListener('change', () => {
            IceConfig._config.enabled = toggle.checked;
            IceConfig._saveConfig();
            IceConfig._applyConfig();
            IceConfig._updateUI();
        });

        document.getElementById('btn-ice-add-server').addEventListener('click', () => {
            IceConfig._addCustomServer();
        });
    },

    _updateUI() {
        const toggle = document.getElementById('ice-remote-toggle');
        const badge = document.getElementById('ice-config-badge');
        const hint = document.getElementById('ice-remote-hint');

        if (!toggle || !badge) return;

        toggle.checked = IceConfig._config.enabled;

        // Badge text
        const serverCount = IceConfig._getServerCount();
        if (serverCount === 0) {
            badge.textContent = 'LAN only';
            badge.className = 'ice-config-badge';
        } else {
            badge.textContent = serverCount + ' server' + (serverCount !== 1 ? 's' : '') + ' configured';
            badge.className = 'ice-config-badge active';
        }

        // Toggle hint visibility
        if (hint) {
            hint.classList.toggle('hidden', !IceConfig._config.enabled);
        }

        IceConfig._renderCustomServers();
    },

    _getServerCount() {
        let count = 0;
        if (IceConfig._config.enabled) count += IceConfig.PRESETS.length;
        count += IceConfig._config.customServers.length;
        return count;
    },

    _addCustomServer() {
        const urlInput = document.getElementById('ice-custom-url');
        const userInput = document.getElementById('ice-custom-username');
        const credInput = document.getElementById('ice-custom-credential');

        const url = (urlInput.value || '').trim();
        if (!url) return;

        // Basic validation
        if (!/^(stun|turn|turns):/.test(url)) {
            urlInput.setCustomValidity('Must start with stun:, turn:, or turns:');
            urlInput.reportValidity();
            return;
        }
        urlInput.setCustomValidity('');

        const server = { url };
        const username = (userInput.value || '').trim();
        const credential = (credInput.value || '').trim();
        if (username) server.username = username;
        if (credential) server.credential = credential;

        IceConfig._config.customServers.push(server);
        IceConfig._saveConfig();
        IceConfig._applyConfig();
        IceConfig._updateUI();

        // Clear inputs
        urlInput.value = '';
        userInput.value = '';
        credInput.value = '';
    },

    _removeCustomServer(index) {
        IceConfig._config.customServers.splice(index, 1);
        IceConfig._saveConfig();
        IceConfig._applyConfig();
        IceConfig._updateUI();
    },

    _renderCustomServers() {
        const list = document.getElementById('ice-custom-list');
        if (!list) return;
        list.innerHTML = '';

        IceConfig._config.customServers.forEach((server, i) => {
            const row = document.createElement('div');
            row.className = 'ice-custom-row';

            const urlSpan = document.createElement('span');
            urlSpan.className = 'ice-custom-url';
            urlSpan.textContent = server.url;
            if (server.username) {
                urlSpan.textContent += ' (' + server.username + ')';
            }

            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn-icon ice-custom-remove';
            removeBtn.innerHTML = '&#x2715;';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', () => IceConfig._removeCustomServer(i));

            row.appendChild(urlSpan);
            row.appendChild(removeBtn);
            list.appendChild(row);
        });
    }
};
