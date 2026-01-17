// Claudex - Claude Code Session Manager

class Claudex {
    constructor() {
        this.sessions = new Map();
        this.ws = null;
        this.activeSessionId = null;
        this.modalTerminal = null;
        this.world3d = null;
        this.is3DView = false;
        this.clientState = null;
        this._saveStateTimeout = null;

        this.init();
    }

    async init() {
        await this.loadClientState();
        this.connectWebSocket();
        this.setupEventListeners();
        await this.loadSessions();
    }

    // Client state persistence (server-side)
    async loadClientState() {
        try {
            const response = await fetch('/api/client-state');
            this.clientState = await response.json();
        } catch (err) {
            console.error('Failed to load client state:', err);
            this.clientState = { theme: 'light', view3d: true };
        }
    }

    saveClientState() {
        // Debounce saves to avoid excessive requests
        if (this._saveStateTimeout) {
            clearTimeout(this._saveStateTimeout);
        }
        this._saveStateTimeout = setTimeout(async () => {
            try {
                await fetch('/api/client-state', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.clientState)
                });
            } catch (err) {
                console.error('Failed to save client state:', err);
            }
        }, 500);
    }

    // WebSocket connection
    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
        };

        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            this.handleMessage(msg);
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected, reconnecting...');
            setTimeout(() => this.connectWebSocket(), 2000);
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
        };
    }

    handleMessage(msg) {
        switch (msg.type) {
            case 'output':
                this.handleOutput(msg.session_id, msg.data);
                break;
            case 'status':
                this.handleStatus(msg.session_id, msg.status);
                break;
        }
    }

    handleOutput(sessionId, data) {
        // Decode Base64 data to Uint8Array, then to UTF-8 string
        const binaryString = atob(data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const decoded = new TextDecoder('utf-8').decode(bytes);

        // Write to modal terminal if this session is active
        if (this.activeSessionId === sessionId && this.modalTerminal) {
            this.modalTerminal.write(decoded);

            // Scroll to bottom after scrollback is written
            if (this.scrollToBottomPending) {
                this.scrollToBottomPending = false;
                // Multiple attempts to ensure scroll works after large data loads
                [50, 200, 500].forEach(delay => {
                    setTimeout(() => {
                        if (this.modalTerminal) {
                            this.modalTerminal.scrollToBottom();
                        }
                    }, delay);
                });
            }
        }
    }

    handleStatus(sessionId, status) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const oldStatus = session.status;
        session.status = status;

        // Update UI
        this.updateCardStatus(sessionId, status);

        // Update 3D world
        if (this.world3d) {
            this.world3d.updateSessionStatus(sessionId, status);
        }

        // Notification when finished (was thinking/executing, now waiting)
        // But not if we're already viewing this session
        if ((oldStatus === 'thinking' || oldStatus === 'executing') &&
            status === 'waiting_input' &&
            this.activeSessionId !== sessionId) {
            this.showNotification(session.name, 'Ready for input');
        }
    }

    updateCardStatus(sessionId, status) {
        const card = document.querySelector(`[data-session-id="${sessionId}"]`);
        if (!card) return;

        // Remove old status classes
        card.classList.remove('thinking', 'executing', 'waiting_input', 'idle', 'stopped', 'shell');
        card.classList.add(status);

        // Update badge
        const badge = card.querySelector('.status-badge');
        if (badge) {
            badge.textContent = status.replace('_', ' ');
            badge.className = `status-badge ${status}`;
        }

        // Update timestamp
        const timestamp = card.querySelector('.card-timestamp');
        if (timestamp) {
            timestamp.textContent = this.formatTimestamp(new Date().toISOString());
        }

        // Update session data
        const session = this.sessions.get(sessionId);
        if (session) {
            session.updated_at = new Date().toISOString();
        }

        // Update modal if open
        if (this.activeSessionId === sessionId) {
            const modalBadge = document.getElementById('modal-status');
            modalBadge.textContent = status.replace('_', ' ');
            modalBadge.className = `status-badge ${status}`;

            // Show/hide restart button
            const restartBtn = document.getElementById('modal-restart');
            if (status === 'stopped') {
                restartBtn.classList.remove('hidden');
            } else {
                restartBtn.classList.add('hidden');
            }
        }
    }

    showNotification(title, message) {
        // Browser notification
        if (Notification.permission === 'granted') {
            new Notification(`Claudex: ${title}`, { body: message });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission();
        }

        // Toast notification
        const toast = document.createElement('div');
        toast.className = 'toast attention';
        toast.textContent = `${title}: ${message}`;
        toast.onclick = () => toast.remove();
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
    }

    // Sessions management
    async loadSessions() {
        try {
            const response = await fetch('/api/sessions');
            let sessions = await response.json();

            const grid = document.getElementById('sessions-grid');
            grid.innerHTML = '';

            if (sessions.length === 0) {
                grid.innerHTML = `
                    <div class="empty-state">
                        <h2>No sessions yet</h2>
                        <p>Click "+ New Session" to create your first Claude Code session</p>
                    </div>
                `;
                return;
            }

            // Sort: parents first by date, then their experiments right after
            const parents = sessions.filter(s => !s.parent_id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            const experiments = sessions.filter(s => s.parent_id);

            const sorted = [];
            parents.forEach(parent => {
                sorted.push(parent);
                // Add experiments for this parent
                experiments.filter(e => e.parent_id === parent.id).forEach(exp => sorted.push(exp));
            });
            // Add orphan experiments (parent deleted)
            experiments.filter(e => !parents.find(p => p.id === e.parent_id)).forEach(exp => sorted.push(exp));

            sorted.forEach(session => {
                this.sessions.set(session.id, session);
                this.createCard(session);
            });

            // Apply saved order only if no experiments (experiments have fixed grouping)
            if (experiments.length === 0) {
                this.applySavedOrder();
            }

            // Update 3D world if active
            if (this.world3d) {
                this.world3d.updateSessions(this.sessions);
            }

            // Restore 3D view preference after sessions are loaded
            this.restore3DViewPreference();
        } catch (err) {
            console.error('Failed to load sessions:', err);
        }
    }

    createCard(session) {
        const grid = document.getElementById('sessions-grid');

        // Remove empty state if exists
        const emptyState = grid.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        const card = document.createElement('div');
        card.className = `session-card ${session.status || 'idle'}`;
        card.dataset.sessionId = session.id;
        card.draggable = true;
        const isExperiment = !!session.parent_id;
        if (isExperiment) {
            card.classList.add('experiment');
        }

        const gitBranchIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>`;
        const closeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`;

        card.innerHTML = `
            <div class="card-row">
                <span class="card-title">${session.name || session.id}</span>
                <div>
                    ${!isExperiment ? `<button class="btn-experiment" title="New experiment">${gitBranchIcon}</button>` : ''}
                    <button class="btn-delete" title="Delete session">${closeIcon}</button>
                </div>
            </div>
            ${isExperiment ? `<span class="experiment-badge">↳ ${session.branch || 'experiment'}</span>` : ''}
            <span class="status-badge ${session.status || 'idle'}">${(session.status || 'idle').replace('_', ' ')}</span>
            <span class="card-timestamp">${this.formatTimestamp(session.updated_at)}</span>
        `;

        card.onclick = (e) => {
            if (!e.target.classList.contains('btn-delete') && !e.target.classList.contains('btn-experiment')) {
                this.openSession(session.id);
            }
        };
        card.querySelector('.btn-delete').onclick = (e) => {
            e.stopPropagation();
            this.showConfirm(`Delete "${session.name || session.id}"?`, () => {
                this.deleteSession(session.id);
            });
        };
        const expBtn = card.querySelector('.btn-experiment');
        if (expBtn) {
            expBtn.onclick = (e) => {
                e.stopPropagation();
                this.createExperiment(session.id);
            };
        }

        // Drag and drop
        card.ondragstart = (e) => {
            card.classList.add('dragging');
            e.dataTransfer.setData('text/plain', session.id);
        };
        card.ondragend = () => {
            card.classList.remove('dragging');
        };
        card.ondragover = (e) => {
            e.preventDefault();
            card.classList.add('drag-over');
        };
        card.ondragleave = () => {
            card.classList.remove('drag-over');
        };
        card.ondrop = (e) => {
            e.preventDefault();
            card.classList.remove('drag-over');
            const draggedId = e.dataTransfer.getData('text/plain');
            const draggedCard = document.querySelector(`[data-session-id="${draggedId}"]`);
            if (draggedCard && draggedCard !== card) {
                const rect = card.getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                if (e.clientX < midX) {
                    grid.insertBefore(draggedCard, card);
                } else {
                    grid.insertBefore(draggedCard, card.nextSibling);
                }
                this.saveSessionOrder();
            }
        };

        grid.appendChild(card);
    }

    saveSessionOrder() {
        const grid = document.getElementById('sessions-grid');
        const order = Array.from(grid.querySelectorAll('.session-card'))
            .map(card => card.dataset.sessionId);
        this.clientState.sessionOrder = order;
        this.saveClientState();
    }

    applySavedOrder() {
        const order = this.clientState?.sessionOrder;
        if (!order || !order.length) return;

        const grid = document.getElementById('sessions-grid');

        order.forEach(id => {
            const card = grid.querySelector(`[data-session-id="${id}"]`);
            if (card) {
                grid.appendChild(card);
            }
        });
    }

    async createSession(name) {
        try {
            const response = await fetch('/api/sessions/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });

            const session = await response.json();
            this.sessions.set(session.id, session);
            this.createCard(session);

            // Update 3D world
            if (this.world3d) {
                this.world3d.updateSessions(this.sessions);
            }

            // Open the new session
            this.openSession(session.id);
        } catch (err) {
            console.error('Failed to create session:', err);
        }
    }

    async createExperiment(parentId) {
        try {
            const response = await fetch('/api/sessions/experiment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_id: parentId })
            });

            if (!response.ok) {
                const error = await response.text();
                alert('Error: ' + error);
                return;
            }

            const session = await response.json();
            this.sessions.set(session.id, session);
            this.createCard(session);

            // Update 3D world
            if (this.world3d) {
                this.world3d.updateSessions(this.sessions);
            }

            // Open the new experiment session
            this.openSession(session.id);
        } catch (err) {
            console.error('Failed to create experiment:', err);
            alert('Failed to create experiment: ' + err.message);
        }
    }

    confirmDelete(sessionId) {
        const session = this.sessions.get(sessionId);
        const name = session?.name || sessionId;
        this.showConfirm(`Delete "${name}"? This action cannot be undone.`, () => {
            this.deleteSession(sessionId);
        });
    }

    showExperimentDialog(sessionId) {
        // For now, create directly. Could show a dialog for branch name in future.
        this.createExperiment(sessionId);
    }

    async deleteSession(sessionId) {
        try {
            await fetch(`/api/sessions/${sessionId}`, {
                method: 'DELETE'
            });

            // Remove from local state
            this.sessions.delete(sessionId);

            // Remove card
            const card = document.querySelector(`[data-session-id="${sessionId}"]`);
            if (card) {
                card.remove();
            }

            // Update 3D world
            if (this.world3d) {
                this.world3d.updateSessions(this.sessions);
            }

            // Close modal if this session is open
            if (this.activeSessionId === sessionId) {
                this.closeModal();
            }

            // Show empty state if no sessions left
            if (this.sessions.size === 0) {
                document.getElementById('sessions-grid').innerHTML = `
                    <div class="empty-state">
                        <h2>No sessions yet</h2>
                        <p>Click "+ New Session" to create your first Claude Code session</p>
                    </div>
                `;
            }
        } catch (err) {
            console.error('Failed to delete session:', err);
        }
    }

    async updateSessionName(sessionId, newName) {
        try {
            await fetch(`/api/sessions/${sessionId}/name`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });

            // Update local state
            const session = this.sessions.get(sessionId);
            if (session) {
                session.name = newName;
            }

            // Update card title
            const card = document.querySelector(`[data-session-id="${sessionId}"]`);
            if (card) {
                const titleEl = card.querySelector('.card-title');
                if (titleEl) {
                    titleEl.textContent = newName;
                }
            }

            // Update 3D world label
            if (this.world3d) {
                this.world3d.updateSessionName(sessionId, newName);
            }
        } catch (err) {
            console.error('Failed to update session name:', err);
        }
    }

    openSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        this.activeSessionId = sessionId;
        this.clientState.activeSession = sessionId;
        this.saveClientState();

        // Update modal
        const titleInput = document.getElementById('modal-title');
        titleInput.value = session.name || sessionId;
        titleInput.onchange = () => this.updateSessionName(sessionId, titleInput.value);
        titleInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                titleInput.blur();
            }
            e.stopPropagation(); // Don't send to terminal
        };
        titleInput.onkeypress = (e) => e.stopPropagation();
        titleInput.onkeyup = (e) => e.stopPropagation();
        titleInput.onblur = () => {
            // Refocus terminal when title input loses focus
            if (this.modalTerminal) {
                this.modalTerminal.focus();
            }
        };

        const modalBadge = document.getElementById('modal-status');
        modalBadge.textContent = (session.status || 'idle').replace('_', ' ');
        modalBadge.className = `status-badge ${session.status || 'idle'}`;

        // Show restart button if session is stopped
        const restartBtn = document.getElementById('modal-restart');
        if (session.status === 'stopped') {
            restartBtn.classList.remove('hidden');
        } else {
            restartBtn.classList.add('hidden');
        }

        // Create/show modal terminal
        const container = document.getElementById('modal-terminal');
        container.innerHTML = '';

        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        this.modalTerminal = new Terminal({
            fontSize: 14,
            theme: this.getTerminalTheme(isDark),
            cursorBlink: true,
            allowProposedApi: true,
            scrollback: 10000
        });

        const fitAddon = new FitAddon.FitAddon();
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();

        this.modalTerminal.loadAddon(fitAddon);
        this.modalTerminal.loadAddon(webLinksAddon);
        this.modalTerminal.loadAddon(unicode11Addon);
        this.modalTerminal.unicode.activeVersion = '11';

        // Show modal FIRST so container has dimensions
        document.getElementById('modal').classList.remove('hidden');

        // Now open and fit terminal
        this.modalTerminal.open(container);
        fitAddon.fit();

        // Send initial size to server
        this.sendResize(sessionId, this.modalTerminal.rows, this.modalTerminal.cols);

        // Handle input
        this.modalTerminal.onData(data => {
            this.sendInput(sessionId, data);
        });

        // Custom key handlers for terminal
        this.modalTerminal.attachCustomKeyEventHandler((event) => {
            if (event.type === 'keydown') {
                // Shift+Enter: multiline input for Claude Code
                if (event.key === 'Enter' && event.shiftKey) {
                    this.sendInput(sessionId, '\x1b[13;2u');
                    return false;
                }
                // Shift+Escape: close session modal
                if (event.key === 'Escape' && event.shiftKey) {
                    this.closeModal();
                    return false;
                }
            }
            return true;
        });

        // Click on terminal container refocuses terminal
        container.onclick = () => {
            if (this.modalTerminal) {
                this.modalTerminal.focus();
            }
        };

        // Handle resize with debounce
        let resizeTimeout;
        this.resizeObserver = new ResizeObserver(() => {
            if (this.modalTerminal) {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    fitAddon.fit();
                    this.sendResize(sessionId, this.modalTerminal.rows, this.modalTerminal.cols);
                }, 100);
            }
        });
        this.resizeObserver.observe(container);

        // Subscribe to session output and start if not running
        this.ws.send(JSON.stringify({
            type: 'subscribe',
            session_id: sessionId
        }));

        if (session.status === 'idle' || !session.status) {
            this.ws.send(JSON.stringify({
                type: 'start',
                session_id: sessionId,
                data: { rows: this.modalTerminal.rows, cols: this.modalTerminal.cols }
            }));
        }

        this.modalTerminal.focus();

        // Scroll to bottom after scrollback is loaded
        this.scrollToBottomPending = true;
    }

    closeModal() {
        if (this.activeSessionId) {
            this.ws.send(JSON.stringify({
                type: 'unsubscribe',
                session_id: this.activeSessionId
            }));
        }

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        this.activeSessionId = null;
        this.modalTerminal = null;
        document.getElementById('modal').classList.add('hidden');
    }

    restartSession(sessionId = null) {
        const targetId = sessionId || this.activeSessionId;
        if (!targetId) return;

        // If restarting the currently open session
        if (targetId === this.activeSessionId && this.modalTerminal) {
            this.modalTerminal.clear();
            this.ws.send(JSON.stringify({
                type: 'restart',
                session_id: targetId,
                data: { rows: this.modalTerminal.rows, cols: this.modalTerminal.cols }
            }));
            document.getElementById('modal-restart').classList.add('hidden');
        } else {
            // Restart a session that's not currently open
            this.ws.send(JSON.stringify({
                type: 'restart',
                session_id: targetId,
                data: { rows: 24, cols: 80 }
            }));
        }
    }

    sendInput(sessionId, data) {
        if (this.ws.readyState !== WebSocket.OPEN) return;

        this.ws.send(JSON.stringify({
            type: 'input',
            session_id: sessionId,
            data: data
        }));
    }

    sendResize(sessionId, rows, cols) {
        if (this.ws.readyState !== WebSocket.OPEN) return;

        this.ws.send(JSON.stringify({
            type: 'resize',
            session_id: sessionId,
            data: { rows, cols }
        }));
    }

    // Event listeners
    setupEventListeners() {
        // 3D View toggle
        document.getElementById('view-toggle').onclick = () => {
            this.toggle3DView();
        };

        // Theme toggle
        const themeToggle = document.getElementById('theme-toggle');
        const savedTheme = this.clientState?.theme || 'light';
        this.setTheme(savedTheme);

        themeToggle.onclick = () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            this.setTheme(newTheme);
            this.clientState.theme = newTheme;
            this.saveClientState();
        };

        // New session button
        document.getElementById('new-session').onclick = () => {
            document.getElementById('new-session-dialog').classList.remove('hidden');
            const nameInput = document.getElementById('session-name');
            nameInput.value = 'New Session';
            nameInput.focus();
            nameInput.select();
        };

        // Cancel new session
        document.getElementById('cancel-new-session').onclick = () => {
            document.getElementById('new-session-dialog').classList.add('hidden');
        };

        // Create session form
        document.getElementById('new-session-form').onsubmit = (e) => {
            e.preventDefault();
            const name = document.getElementById('session-name').value;
            this.createSession(name);
            document.getElementById('new-session-dialog').classList.add('hidden');
            document.getElementById('new-session-form').reset();
        };

        // Close modal
        document.getElementById('modal-close').onclick = () => this.closeModal();

        // Restart session
        document.getElementById('modal-restart').onclick = () => this.restartSession();

        // Experiment from modal
        document.getElementById('modal-experiment').onclick = () => {
            if (this.activeSessionId) {
                this.createExperiment(this.activeSessionId);
            }
        };

        // Customize from modal
        document.getElementById('modal-customize').onclick = () => {
            if (this.activeSessionId && this.world3d) {
                this.closeModal();
                this.world3d.onCustomizeSession(this.activeSessionId);
            }
        };

        // Delete from modal
        document.getElementById('modal-delete').onclick = () => {
            if (this.activeSessionId) {
                const session = this.sessions.get(this.activeSessionId);
                const name = session?.name || this.activeSessionId;
                this.showConfirm(`Delete "${name}"?`, () => {
                    this.deleteSession(this.activeSessionId);
                    this.closeModal();
                });
            }
        };

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            const dialog = document.getElementById('new-session-dialog');
            const modal = document.getElementById('modal');

            // Escape closes dialogs
            if (e.key === 'Escape' && !e.shiftKey) {
                if (!dialog.classList.contains('hidden')) {
                    dialog.classList.add('hidden');
                }
            }

            // Shift+Escape closes session modal
            if (e.key === 'Escape' && e.shiftKey) {
                if (!modal.classList.contains('hidden')) {
                    e.preventDefault();
                    this.closeModal();
                }
            }
        });

        // Request notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    setTheme(theme) {
        const isDark = theme === 'dark';
        if (isDark) {
            document.documentElement.setAttribute('data-theme', 'dark');
            document.querySelector('.theme-icon').textContent = '🌙';
            document.querySelector('.theme-label').textContent = 'Light';
        } else {
            document.documentElement.removeAttribute('data-theme');
            document.querySelector('.theme-icon').textContent = '☀️';
            document.querySelector('.theme-label').textContent = 'Dark';
        }

        // Update modal terminal theme
        if (this.modalTerminal) {
            this.modalTerminal.options.theme = this.getTerminalTheme(isDark);
        }
    }

    // 3D View methods
    init3DWorld() {
        if (this.world3d) return;

        const canvas = document.getElementById('canvas-3d');
        if (!canvas) return;

        this.world3d = new World3D(
            canvas,
            // On session click
            (sessionId) => {
                this.openSession(sessionId);
            },
            // On create session (click on empty parcel)
            (q, r) => {
                this.createSessionAt3D(q, r);
            }
        );

        // Connect radial menu callbacks
        this.world3d.onDeleteSession = (sessionId) => {
            this.confirmDelete(sessionId);
        };
        this.world3d.onRestartSession = async (sessionId) => {
            await this.restartSession(sessionId);
        };
        this.world3d.onExperimentSession = (sessionId) => {
            this.showExperimentDialog(sessionId);
        };
        this.world3d.onCustomizeSession = (sessionId) => {
            this.showCustomizePanel(sessionId);
        };

        // Camera state callbacks
        this.world3d.onSaveCamera = (cameraData) => {
            this.clientState.camera = cameraData;
            this.saveClientState();
        };
        this.world3d.getInitialCamera = () => {
            return this.clientState?.camera || null;
        };

        // Empty islands callbacks
        this.world3d.onSaveEmptyIslands = (islands) => {
            this.clientState.emptyIslands = islands;
            this.saveClientState();
        };
        this.world3d.getEmptyIslands = () => {
            return this.clientState?.emptyIslands || [];
        };

        // Claude state callback
        this.world3d.fetchClaudeState = async (sessionId) => {
            try {
                const response = await fetch(`/api/sessions/${sessionId}/claude-state`);
                if (response.ok) {
                    return await response.json();
                }
            } catch (err) {
                console.error('Failed to fetch Claude state:', err);
            }
            return null;
        };

        // Restore camera position now that callbacks are set
        this.world3d.restoreCameraPosition();

        // Sync current sessions
        this.world3d.updateSessions(this.sessions);
    }

    showCustomizePanel(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const panel = document.getElementById('customize-panel');
        const nameInput = document.getElementById('customize-name');

        // Store current session being customized
        this.customizingSessionId = sessionId;

        // Load current values
        nameInput.value = session.name || '';

        // Select current model
        const currentModel = session.robot_model || 'classic';
        panel.querySelectorAll('.robot-model-option').forEach(opt => {
            opt.classList.toggle('selected', opt.dataset.model === currentModel);
        });

        // Select current color
        const currentColor = session.robot_color || '#6366f1';
        panel.querySelectorAll('.color-option').forEach(opt => {
            opt.classList.toggle('selected', opt.dataset.color === currentColor);
        });

        // Select current accessory
        const currentAccessory = session.robot_accessory || 'none';
        panel.querySelectorAll('.accessory-option').forEach(opt => {
            opt.classList.toggle('selected', opt.dataset.accessory === currentAccessory);
        });

        // Show panel
        panel.classList.add('active');

        // Setup event handlers (only once)
        if (!this.customizePanelInitialized) {
            this.initCustomizePanel();
            this.customizePanelInitialized = true;
        }
    }

    initCustomizePanel() {
        const panel = document.getElementById('customize-panel');

        // Close button
        document.getElementById('customize-close').onclick = () => {
            panel.classList.remove('active');
        };

        // Click on canvas closes panel
        const canvas = document.getElementById('canvas-3d');
        if (canvas) {
            canvas.addEventListener('click', () => {
                if (panel.classList.contains('active')) {
                    panel.classList.remove('active');
                    this.customizingSessionId = null;
                }
            });
        }

        // Name change
        document.getElementById('customize-name').onchange = (e) => {
            if (this.customizingSessionId) {
                this.updateSessionName(this.customizingSessionId, e.target.value);
            }
        };

        // Model selection
        panel.querySelectorAll('.robot-model-option').forEach(opt => {
            opt.onclick = () => {
                panel.querySelectorAll('.robot-model-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                this.updateSessionCustomization('robotModel', opt.dataset.model);
            };
        });

        // Color selection
        panel.querySelectorAll('.color-option').forEach(opt => {
            opt.onclick = () => {
                panel.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                this.updateSessionCustomization('robotColor', opt.dataset.color);
            };
        });

        // Accessory selection
        panel.querySelectorAll('.accessory-option').forEach(opt => {
            opt.onclick = () => {
                panel.querySelectorAll('.accessory-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                this.updateSessionCustomization('robotAccessory', opt.dataset.accessory);
            };
        });
    }

    async updateSessionCustomization(key, value) {
        if (!this.customizingSessionId) return;

        const session = this.sessions.get(this.customizingSessionId);
        if (!session) return;

        // Map camelCase key to snake_case for session storage
        const keyMap = {
            robotModel: 'robot_model',
            robotColor: 'robot_color',
            robotAccessory: 'robot_accessory'
        };
        const snakeKey = keyMap[key] || key;

        // Update local state
        session[snakeKey] = value;

        // Update 3D world immediately
        if (this.world3d) {
            this.world3d.updateRobotCustomization(this.customizingSessionId, {
                model: session.robot_model || 'classic',
                color: session.robot_color || '#6366f1',
                accessory: session.robot_accessory || 'none'
            });
        }

        // Save to server
        try {
            await fetch(`/api/sessions/${this.customizingSessionId}/customize`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    robot_model: session.robot_model,
                    robot_color: session.robot_color,
                    robot_accessory: session.robot_accessory
                })
            });
        } catch (err) {
            console.error('Failed to save customization:', err);
        }
    }

    async createSessionAt3D(q, r) {
        // Generate a fun name based on position
        const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'];
        const adjectives = ['Happy', 'Busy', 'Clever', 'Swift', 'Bright', 'Calm'];
        const name = `${adjectives[Math.abs(q + r) % adjectives.length]} ${names[Math.abs(q * 2 + r) % names.length]}`;

        // Remove this position from empty islands if it was one
        if (this.clientState.emptyIslands) {
            this.clientState.emptyIslands = this.clientState.emptyIslands.filter(
                pos => !(pos.q === q && pos.r === r)
            );
            this.saveClientState();
        }

        try {
            const response = await fetch('/api/sessions/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, hex_q: q, hex_r: r })
            });

            const session = await response.json();
            this.sessions.set(session.id, session);
            this.createCard(session);

            // Update 3D world
            if (this.world3d) {
                this.world3d.updateSessions(this.sessions);
            }

            // Open the new session
            this.openSession(session.id);
        } catch (err) {
            console.error('Failed to create session:', err);
        }
    }

    toggle3DView() {
        this.is3DView = !this.is3DView;

        const grid = document.getElementById('sessions-grid');
        const world3d = document.getElementById('world-3d');
        const viewToggle = document.getElementById('view-toggle');
        const viewIcon = viewToggle.querySelector('.view-icon');

        if (this.is3DView) {
            // Switch to 3D
            grid.classList.add('hidden');
            world3d.classList.remove('hidden');
            viewIcon.textContent = '2D';
            viewToggle.classList.add('active');

            // Initialize if needed
            if (!this.world3d) {
                this.init3DWorld();
            }
            this.world3d.activate();
            this.world3d.updateSessions(this.sessions);
        } else {
            // Switch to 2D
            grid.classList.remove('hidden');
            world3d.classList.add('hidden');
            viewIcon.textContent = '3D';
            viewToggle.classList.remove('active');

            if (this.world3d) {
                this.world3d.deactivate();
            }
        }

        this.clientState.view3d = this.is3DView;
        this.saveClientState();
    }

    restore3DViewPreference() {
        // Default to 3D view (true) unless explicitly set to false
        if (this.clientState?.view3d !== false) {
            this.toggle3DView();
        }
    }

    getTerminalTheme(isDark) {
        if (isDark) {
            return {
                background: '#1a1a1a',
                foreground: '#ffffff',
                cursor: '#ffffff',
                cursorAccent: '#1a1a1a',
                selectionBackground: '#444444'
            };
        } else {
            return {
                background: '#ffffff',
                foreground: '#1a1a1a',
                cursor: '#1a1a1a',
                cursorAccent: '#ffffff',
                selectionBackground: '#c0c0c0'
            };
        }
    }

    formatTimestamp(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${day}/${month} ${hours}:${minutes}`;
    }

    showConfirm(message, onConfirm) {
        const dialog = document.getElementById('confirm-dialog');
        const msgEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok');
        const cancelBtn = document.getElementById('confirm-cancel');

        msgEl.textContent = message;
        dialog.classList.remove('hidden');

        const cleanup = () => {
            dialog.classList.add('hidden');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            document.removeEventListener('keydown', handleKey);
        };

        const handleKey = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                cleanup();
                onConfirm();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cleanup();
            }
        };

        document.addEventListener('keydown', handleKey);

        okBtn.onclick = () => {
            cleanup();
            onConfirm();
        };

        cancelBtn.onclick = cleanup;
        dialog.onclick = (e) => {
            if (e.target === dialog) cleanup();
        };
    }
}

// Initialize app
const app = new Claudex();
