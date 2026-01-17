// Claudex - Claude Code Session Manager

class Claudex {
    constructor() {
        this.sessions = new Map();
        this.ws = null;
        this.activeSessionId = null;
        this.modalTerminal = null;

        this.init();
    }

    async init() {
        this.connectWebSocket();
        this.setupEventListeners();
        await this.loadSessions();
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
                setTimeout(() => {
                    if (this.modalTerminal) {
                        this.modalTerminal.scrollToBottom();
                    }
                }, 50);
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

        // Notification when finished (was thinking/executing, now waiting)
        if ((oldStatus === 'thinking' || oldStatus === 'executing') &&
            status === 'waiting_input') {
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
        localStorage.setItem('sessionOrder', JSON.stringify(order));
    }

    applySavedOrder() {
        const savedOrder = localStorage.getItem('sessionOrder');
        if (!savedOrder) return;

        const order = JSON.parse(savedOrder);
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

            // Open the new experiment session
            this.openSession(session.id);
        } catch (err) {
            console.error('Failed to create experiment:', err);
            alert('Failed to create experiment: ' + err.message);
        }
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
        } catch (err) {
            console.error('Failed to update session name:', err);
        }
    }

    openSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        this.activeSessionId = sessionId;

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

    restartSession() {
        if (!this.activeSessionId || !this.modalTerminal) return;

        const sessionId = this.activeSessionId;

        // Clear terminal
        this.modalTerminal.clear();

        // Send restart message
        this.ws.send(JSON.stringify({
            type: 'restart',
            session_id: sessionId,
            data: { rows: this.modalTerminal.rows, cols: this.modalTerminal.cols }
        }));

        // Hide restart button
        document.getElementById('modal-restart').classList.add('hidden');
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
        // Theme toggle
        const themeToggle = document.getElementById('theme-toggle');
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);

        themeToggle.onclick = () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            this.setTheme(newTheme);
            localStorage.setItem('theme', newTheme);
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
        document.getElementById('modal').onclick = (e) => {
            if (e.target.id === 'modal') this.closeModal();
        };

        // Escape to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const dialog = document.getElementById('new-session-dialog');
                const modal = document.getElementById('modal');

                if (!dialog.classList.contains('hidden')) {
                    dialog.classList.add('hidden');
                } else if (!modal.classList.contains('hidden')) {
                    // Don't close modal on Escape - let it go to the terminal
                    // The terminal might need Escape for Claude Code
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
        };

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
