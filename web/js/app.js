// Claudex - Claude Code Session Manager

class Claudex {
    constructor() {
        this.sessions = new Map();
        this.ws = null;
        this.activeSessionId = null;
        this.world3d = null;
        this.is3DView = false;
        this.clientState = null;
        this._saveStateTimeout = null;

        // Multi-pane support with nested splits
        this.panes = new Map(); // paneId -> { terminal, fitAddon, element, paneId, sessionId }
        this.activePaneId = null;
        this.splitInstances = []; // Array of Split.js instances for cleanup
        this.paneCounter = 0;
        // Split tree: { type: 'pane', paneId, sessionId } or { type: 'split', direction, children: [node, node] }
        this.splitTree = null;
        this.primarySessionId = null; // The session that was originally opened (for saving layout)

        this.init();
    }

    async init() {
        await this.loadClientState();
        await this.checkWorktree();
        this.connectWebSocket();
        this.setupEventListeners();
        await this.loadSessions();
    }

    // Check if we're in a git worktree
    async checkWorktree() {
        try {
            const response = await fetch('/api/worktree');
            const info = await response.json();

            if (info.is_worktree) {
                const bar = document.getElementById('worktree-bar');
                const branchEl = document.getElementById('worktree-branch');

                branchEl.textContent = info.branch;
                bar.classList.remove('hidden');

                // Setup merge button
                document.getElementById('worktree-merge').onclick = async () => {
                    if (!confirm(`Merge "${info.branch}" into master and close this worktree?`)) return;

                    try {
                        const res = await fetch('/api/worktree/merge', { method: 'POST' });
                        if (res.ok) {
                            alert('Merged successfully! The server will restart.');
                            // Server will be gone, try to redirect to main repo
                            window.location.href = '/';
                        } else {
                            const err = await res.text();
                            alert('Merge failed: ' + err);
                        }
                    } catch (e) {
                        alert('Merge failed: ' + e.message);
                    }
                };

                // Setup discard button
                document.getElementById('worktree-discard').onclick = async () => {
                    if (!confirm(`Discard all changes in "${info.branch}" and close this worktree?`)) return;

                    try {
                        const res = await fetch('/api/worktree/discard', { method: 'POST' });
                        if (res.ok) {
                            alert('Worktree discarded! The server will stop.');
                            window.location.href = '/';
                        } else {
                            const err = await res.text();
                            alert('Discard failed: ' + err);
                        }
                    } catch (e) {
                        alert('Discard failed: ' + e.message);
                    }
                };
            }
        } catch (err) {
            console.error('Failed to check worktree:', err);
        }
    }

    // Client state persistence (server-side)
    async loadClientState() {
        try {
            const response = await fetch('/api/client-state');
            this.clientState = await response.json();
        } catch (err) {
            console.error('Failed to load client state:', err);
            this.clientState = { theme: 'light', view3d: false };
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

        // Find the pane that has this sessionId and write to it
        this.panes.forEach(pane => {
            if (pane.sessionId === sessionId) {
                pane.terminal.write(decoded);
                if (this.scrollToBottomPending) {
                    setTimeout(() => pane.terminal.scrollToBottom(), 50);
                }
            }
        });

        if (this.scrollToBottomPending) {
            this.scrollToBottomPending = false;
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

        // Update session header if this session is active
        if (this.activeSessionId === sessionId) {
            const statusBadge = document.getElementById('session-status');
            statusBadge.textContent = status.replace('_', ' ');
            statusBadge.className = `status-badge ${status}`;

            // Show/hide restart button
            const restartBtn = document.getElementById('session-restart');
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

            const list = document.getElementById('sessions-list');
            list.innerHTML = '';

            if (sessions.length === 0) {
                document.getElementById('empty-content').classList.remove('hidden');
                return;
            }

            document.getElementById('empty-content').classList.add('hidden');

            // Add ALL sessions to the map (needed for split panes)
            sessions.forEach(session => {
                this.sessions.set(session.id, session);
            });

            // Filter out split child sessions for UI display only
            const visibleSessions = sessions.filter(s => !s.split_parent_id);

            // Sort: parents first by date, then their experiments right after
            const parents = visibleSessions.filter(s => !s.parent_id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            const experiments = visibleSessions.filter(s => s.parent_id);

            const sorted = [];
            parents.forEach(parent => {
                sorted.push(parent);
                // Add experiments for this parent
                experiments.filter(e => e.parent_id === parent.id).forEach(exp => sorted.push(exp));
            });
            // Add orphan experiments (parent deleted)
            experiments.filter(e => !parents.find(p => p.id === e.parent_id)).forEach(exp => sorted.push(exp));

            sorted.forEach(session => {
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

            // Auto-open first session or saved active session
            if (sorted.length > 0 && !this.activeSessionId) {
                const savedSession = this.clientState?.activeSession;
                const sessionToOpen = savedSession && this.sessions.has(savedSession) ? savedSession : sorted[0].id;
                this.openSession(sessionToOpen);
            }
        } catch (err) {
            console.error('Failed to load sessions:', err);
        }
    }

    createCard(session) {
        const list = document.getElementById('sessions-list');

        const card = document.createElement('div');
        card.className = `session-card ${session.status || 'idle'}`;
        card.dataset.sessionId = session.id;
        card.draggable = true;
        const isExperiment = !!session.parent_id;
        if (isExperiment) {
            card.classList.add('experiment');
        }

        const gitBranchIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>`;
        const closeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`;

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
        `;

        card.onclick = (e) => {
            if (!e.target.closest('.btn-delete') && !e.target.closest('.btn-experiment')) {
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
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    list.insertBefore(draggedCard, card);
                } else {
                    list.insertBefore(draggedCard, card.nextSibling);
                }
                this.saveSessionOrder();
            }
        };

        list.appendChild(card);
    }

    saveSessionOrder() {
        const list = document.getElementById('sessions-list');
        const order = Array.from(list.querySelectorAll('.session-card'))
            .map(card => card.dataset.sessionId);
        this.clientState.sessionOrder = order;
        this.saveClientState();
    }

    applySavedOrder() {
        const order = this.clientState?.sessionOrder;
        if (!order || !order.length) return;

        const list = document.getElementById('sessions-list');

        order.forEach(id => {
            const card = list.querySelector(`[data-session-id="${id}"]`);
            if (card) {
                list.appendChild(card);
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

            // If modal is open, open experiment in a split pane
            const modal = document.getElementById('modal');
            if (!modal.classList.contains('hidden') && this.activePaneId) {
                await this.openExperimentInSplit(session);
            } else {
                // Open the new experiment session
                this.openSession(session.id);
            }
        } catch (err) {
            console.error('Failed to create experiment:', err);
            alert('Failed to create experiment: ' + err.message);
        }
    }

    async openExperimentInSplit(session) {
        // Create new pane for experiment (don't add to container yet)
        const newPane = this.createPane(session.id, false);

        // Update split tree with vertical split
        this.updateSplitTree(this.activePaneId, newPane.paneId, 'horizontal');

        // Re-render the tree
        this.renderSplitTree();

        // Subscribe and start the new session
        this.ws.send(JSON.stringify({
            type: 'subscribe',
            session_id: session.id
        }));

        this.ws.send(JSON.stringify({
            type: 'start',
            session_id: session.id,
            data: { rows: newPane.terminal.rows, cols: newPane.terminal.cols }
        }));

        // Focus new pane
        this.setActivePane(newPane.paneId);

        // Save layout
        this.saveSplitLayout();
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

            // If this session was active, open another or show empty state
            if (this.activeSessionId === sessionId) {
                this.closeCurrentSession();
                this.activeSessionId = null;

                // Open next available session
                const nextSession = this.sessions.values().next().value;
                if (nextSession) {
                    this.openSession(nextSession.id);
                } else {
                    // No sessions left
                    document.getElementById('session-header').classList.add('hidden');
                    document.getElementById('empty-content').classList.remove('hidden');
                }
            }

            // Show empty state if no sessions left
            if (this.sessions.size === 0) {
                document.getElementById('empty-content').classList.remove('hidden');
            }
        } catch (err) {
            console.error('Failed to delete session:', err);
        }
    }

    async closeAllSessions() {
        const sessionIds = Array.from(this.sessions.keys());
        for (const sessionId of sessionIds) {
            try {
                await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
            } catch (err) {
                console.error('Failed to delete session:', sessionId, err);
            }
        }
        this.sessions.clear();
        document.getElementById('sessions-list').innerHTML = '';
        this.closeCurrentSession();
        this.activeSessionId = null;
        document.getElementById('session-header').classList.add('hidden');
        document.getElementById('empty-content').classList.remove('hidden');
        if (this.world3d) {
            this.world3d.updateSessions(this.sessions);
        }
    }

    async mergeExperiment(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.parent_id) return;

        const parentSession = this.sessions.get(session.parent_id);
        const parentName = parentSession?.name || session.parent_id;

        this.showConfirm(`Merge "${session.name}" into "${parentName}"?`, async () => {
            try {
                const response = await fetch(`/api/sessions/${sessionId}/merge`, {
                    method: 'POST'
                });

                if (!response.ok) {
                    const error = await response.text();
                    alert('Merge failed: ' + error);
                    return;
                }

                // Close the pane for this session
                const paneId = this.findPaneBySessionId(sessionId);
                if (paneId) {
                    this.closePane(paneId);
                }

                // Remove session from list
                this.sessions.delete(sessionId);
                const card = document.querySelector(`[data-session-id="${sessionId}"]`);
                if (card) card.remove();

                // Update 3D world
                if (this.world3d) {
                    this.world3d.updateSessions(this.sessions);
                }
            } catch (err) {
                console.error('Failed to merge experiment:', err);
                alert('Failed to merge experiment: ' + err.message);
            }
        });
    }

    async discardExperiment(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.parent_id) return;

        this.showConfirm(`Discard "${session.name}" and all its changes?`, async () => {
            try {
                const response = await fetch(`/api/sessions/${sessionId}/discard`, {
                    method: 'POST'
                });

                if (!response.ok) {
                    const error = await response.text();
                    alert('Discard failed: ' + error);
                    return;
                }

                // Close the pane for this session
                const paneId = this.findPaneBySessionId(sessionId);
                if (paneId) {
                    this.closePane(paneId);
                }

                // Remove session from list
                this.sessions.delete(sessionId);
                const card = document.querySelector(`[data-session-id="${sessionId}"]`);
                if (card) card.remove();

                // Update 3D world
                if (this.world3d) {
                    this.world3d.updateSessions(this.sessions);
                }
            } catch (err) {
                console.error('Failed to discard experiment:', err);
                alert('Failed to discard experiment: ' + err.message);
            }
        });
    }

    findPaneBySessionId(sessionId) {
        for (const [paneId, pane] of this.panes) {
            if (pane.sessionId === sessionId) {
                return paneId;
            }
        }
        return null;
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

        // Close previous session if different
        if (this.activeSessionId && this.activeSessionId !== sessionId) {
            this.closeCurrentSession();
        }

        this.activeSessionId = sessionId;
        this.primarySessionId = sessionId;
        this.clientState.activeSession = sessionId;
        this.saveClientState();

        // Update sidebar card selection
        document.querySelectorAll('.session-card').forEach(card => {
            card.classList.toggle('active', card.dataset.sessionId === sessionId);
        });

        // Show session header
        const header = document.getElementById('session-header');
        header.classList.remove('hidden');

        // Hide empty content
        document.getElementById('empty-content').classList.add('hidden');

        // Update session header
        const titleInput = document.getElementById('session-title');
        titleInput.value = session.name || sessionId;
        titleInput.onchange = () => this.updateSessionName(sessionId, titleInput.value);
        titleInput.onkeydown = (e) => {
            if (e.key === 'Enter') titleInput.blur();
            e.stopPropagation();
        };
        titleInput.onkeypress = (e) => e.stopPropagation();
        titleInput.onkeyup = (e) => e.stopPropagation();
        titleInput.onblur = () => this.focusActivePane();

        const statusBadge = document.getElementById('session-status');
        statusBadge.textContent = (session.status || 'idle').replace('_', ' ');
        statusBadge.className = `status-badge ${session.status || 'idle'}`;

        const restartBtn = document.getElementById('session-restart');
        restartBtn.classList.toggle('hidden', session.status !== 'stopped');

        // Update experiment buttons
        this.updateExperimentButtons(sessionId);

        // Clear panes
        this.panes.clear();
        this.activePaneId = null;
        this.paneCounter = 0;
        this.splitInstances.forEach(s => s.destroy());
        this.splitInstances = [];
        this.splitTree = null;

        // Setup panes container
        const panesContainer = document.getElementById('session-panes');
        panesContainer.innerHTML = '';
        panesContainer.className = '';

        // Check for saved split layout
        const savedLayout = this.loadSplitLayout(sessionId);
        if (savedLayout && savedLayout.splitTree) {
            this.restoreSplitLayout(savedLayout);
        } else {
            // Create single pane
            const pane = this.createPane(sessionId);
            this.splitTree = { type: 'pane', paneId: pane.paneId, sessionId: sessionId };
            this.subscribeAndStartSession(sessionId, pane);
        }

        this.scrollToBottomPending = true;
    }

    closeCurrentSession() {
        // Unsubscribe from all pane sessions
        const sessionIds = new Set();
        this.panes.forEach(pane => {
            sessionIds.add(pane.sessionId);
        });
        sessionIds.forEach(sessionId => {
            this.ws.send(JSON.stringify({
                type: 'unsubscribe',
                session_id: sessionId
            }));
        });

        // Cleanup all panes
        this.panes.forEach(pane => {
            if (pane.resizeObserver) pane.resizeObserver.disconnect();
            pane.terminal.dispose();
        });
        this.panes.clear();
        this.activePaneId = null;

        // Cleanup all split instances
        this.splitInstances.forEach(s => s.destroy());
        this.splitInstances = [];
        this.splitTree = null;
    }

    subscribeAndStartSession(sessionId, pane) {
        const session = this.sessions.get(sessionId);

        this.ws.send(JSON.stringify({
            type: 'subscribe',
            session_id: sessionId
        }));

        if ((session?.status === 'idle' || !session?.status) && pane) {
            this.ws.send(JSON.stringify({
                type: 'start',
                session_id: sessionId,
                data: { rows: pane.terminal.rows, cols: pane.terminal.cols }
            }));
        }

        if (pane) {
            pane.terminal.focus();
        }
    }

    // Save split layout to server (via clientState)
    saveSplitLayout() {
        if (!this.primarySessionId || !this.splitTree) return;

        // Convert splitTree to use sessionIds instead of paneIds for persistence
        const persistentTree = this.convertTreeForStorage(this.splitTree);

        // Initialize splitLayouts if needed
        if (!this.clientState.splitLayouts) {
            this.clientState.splitLayouts = {};
        }

        this.clientState.splitLayouts[this.primarySessionId] = {
            splitTree: persistentTree
        };

        this.saveClientState();
    }

    // Convert tree to use sessionIds for storage
    convertTreeForStorage(node) {
        if (node.type === 'pane') {
            const pane = this.panes.get(node.paneId);
            return { type: 'pane', sessionId: pane?.sessionId || node.sessionId };
        }
        if (node.type === 'split') {
            return {
                type: 'split',
                direction: node.direction,
                children: node.children.map(c => this.convertTreeForStorage(c))
            };
        }
        return node;
    }

    // Load split layout from server (via clientState)
    loadSplitLayout(sessionId) {
        if (!this.clientState.splitLayouts) return null;
        return this.clientState.splitLayouts[sessionId] || null;
    }

    // Clear saved layout
    clearSplitLayout(sessionId) {
        if (this.clientState.splitLayouts && this.clientState.splitLayouts[sessionId]) {
            delete this.clientState.splitLayouts[sessionId];
            this.saveClientState();
        }
    }

    // Restore split layout from saved data
    restoreSplitLayout(layout) {
        // Recursively create panes from the saved tree
        const createPanesFromTree = (node) => {
            if (node.type === 'pane') {
                // Check if session still exists
                if (!this.sessions.has(node.sessionId)) {
                    // Session was deleted, skip
                    return null;
                }
                const pane = this.createPane(node.sessionId, false);
                this.subscribeAndStartSession(node.sessionId, pane);
                return { type: 'pane', paneId: pane.paneId, sessionId: node.sessionId };
            }
            if (node.type === 'split') {
                const children = node.children.map(c => createPanesFromTree(c)).filter(c => c !== null);
                if (children.length === 0) return null;
                if (children.length === 1) return children[0];
                return {
                    type: 'split',
                    direction: node.direction,
                    children: children
                };
            }
            return null;
        };

        this.splitTree = createPanesFromTree(layout.splitTree);

        if (!this.splitTree) {
            // All sessions were deleted, create fresh pane
            const pane = this.createPane(this.primarySessionId);
            this.splitTree = { type: 'pane', paneId: pane.paneId, sessionId: this.primarySessionId };
            this.subscribeAndStartSession(this.primarySessionId, pane);
            this.clearSplitLayout(this.primarySessionId);
        } else {
            this.renderSplitTree();
        }
    }

    createPane(sessionId, addToContainer = true) {
        const paneId = `pane-${++this.paneCounter}`;

        // Create pane element
        const paneEl = document.createElement('div');
        paneEl.className = 'pane';
        paneEl.dataset.paneId = paneId;

        // Close button
        const header = document.createElement('div');
        header.className = 'pane-header';
        header.innerHTML = `<button class="pane-close" title="Close pane">&times;</button>`;
        header.querySelector('.pane-close').onclick = (e) => {
            e.stopPropagation();
            this.closePane(paneId);
        };
        paneEl.appendChild(header);

        // Terminal container
        const termContainer = document.createElement('div');
        termContainer.className = 'terminal-container';
        paneEl.appendChild(termContainer);

        // Only add to container if requested (for initial pane)
        if (addToContainer) {
            const panesContainer = document.getElementById('session-panes');
            panesContainer.appendChild(paneEl);
        }

        // Create terminal
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const terminal = new Terminal({
            fontSize: 14,
            theme: this.getTerminalTheme(isDark),
            cursorBlink: true,
            allowProposedApi: true,
            scrollback: 10000
        });

        const fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon.WebLinksAddon());
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();
        terminal.loadAddon(unicode11Addon);
        terminal.unicode.activeVersion = '11';

        terminal.open(termContainer);
        fitAddon.fit();

        // Input handling - send to this pane's session
        terminal.onData(data => {
            this.sendInput(sessionId, data);
        });

        // Custom key handlers
        terminal.attachCustomKeyEventHandler((event) => {
            if (event.type === 'keydown') {
                if (event.key === 'Enter' && event.shiftKey) {
                    this.sendInput(sessionId, '\n');
                    return false;
                }
                if (event.key === 'Escape' && event.shiftKey) {
                    this.closeModal();
                    return false;
                }
            }
            return true;
        });

        // Focus handling
        paneEl.onclick = () => this.setActivePane(paneId);

        // Store pane with its sessionId
        const pane = { paneId, sessionId, terminal, fitAddon, element: paneEl };
        this.panes.set(paneId, pane);

        // Set as active if first pane
        if (this.panes.size === 1) {
            this.setActivePane(paneId);
        }

        // Setup resize observer
        this.setupPaneResizeObserver(pane);

        return pane;
    }

    setupPaneResizeObserver(pane) {
        let resizeTimeout;
        const observer = new ResizeObserver(() => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                pane.fitAddon.fit();
                this.sendResize(pane.sessionId, pane.terminal.rows, pane.terminal.cols);
            }, 100);
        });
        observer.observe(pane.element);
        pane.resizeObserver = observer;
    }

    setActivePane(paneId) {
        // Remove active class from all panes
        this.panes.forEach(p => p.element.classList.remove('active'));

        // Set new active pane
        const pane = this.panes.get(paneId);
        if (pane) {
            pane.element.classList.add('active');
            this.activePaneId = paneId;
            pane.terminal.focus();

            // Update experiment buttons visibility
            this.updateExperimentButtons(pane.sessionId);
        }
    }

    updateExperimentButtons(sessionId) {
        const session = this.sessions.get(sessionId);
        const mergeBtn = document.getElementById('session-exp-merge');
        const discardBtn = document.getElementById('session-exp-discard');

        if (session && session.parent_id) {
            // This is an experiment, show buttons
            mergeBtn.classList.remove('hidden');
            discardBtn.classList.remove('hidden');
        } else {
            // Not an experiment, hide buttons
            mergeBtn.classList.add('hidden');
            discardBtn.classList.add('hidden');
        }
    }

    focusActivePane() {
        if (this.activePaneId) {
            const pane = this.panes.get(this.activePaneId);
            if (pane) pane.terminal.focus();
        }
    }

    closePane(paneId) {
        const pane = this.panes.get(paneId);
        if (!pane) return;

        // Unsubscribe from the pane's session
        this.ws.send(JSON.stringify({
            type: 'unsubscribe',
            session_id: pane.sessionId
        }));

        // Cleanup
        if (pane.resizeObserver) pane.resizeObserver.disconnect();
        pane.terminal.dispose();
        this.panes.delete(paneId);

        // If no panes left, show empty state and clear saved layout
        if (this.panes.size === 0) {
            this.splitTree = null;
            this.clearSplitLayout(this.primarySessionId);
            this.activeSessionId = null;
            document.getElementById('session-header').classList.add('hidden');
            document.getElementById('empty-content').classList.remove('hidden');
            document.querySelectorAll('.session-card').forEach(card => card.classList.remove('active'));
            return;
        }

        // Update split tree - remove this pane and collapse single-child splits
        this.removePaneFromTree(paneId);

        // Re-render
        this.renderSplitTree();

        // Save updated layout
        this.saveSplitLayout();

        // Set new active pane
        if (this.activePaneId === paneId) {
            const firstPane = this.panes.values().next().value;
            if (firstPane) this.setActivePane(firstPane.paneId);
        }
    }

    // Remove pane from tree and collapse single-child splits
    removePaneFromTree(paneId) {
        if (!this.splitTree) return;

        // If root is the pane being removed
        if (this.splitTree.type === 'pane' && this.splitTree.paneId === paneId) {
            this.splitTree = null;
            return;
        }

        // Recursive function to remove pane and collapse
        const removeFromNode = (node, parent, childIndex) => {
            if (node.type === 'pane') {
                return node.paneId === paneId;
            }

            if (node.type === 'split') {
                for (let i = 0; i < node.children.length; i++) {
                    if (node.children[i].type === 'pane' && node.children[i].paneId === paneId) {
                        // Remove this child
                        node.children.splice(i, 1);

                        // If only one child left, collapse this split
                        if (node.children.length === 1) {
                            if (parent) {
                                parent.children[childIndex] = node.children[0];
                            } else {
                                // This is the root
                                this.splitTree = node.children[0];
                            }
                        }
                        return true;
                    } else if (removeFromNode(node.children[i], node, i)) {
                        // Child was modified, check if we need to collapse
                        if (node.children.length === 1) {
                            if (parent) {
                                parent.children[childIndex] = node.children[0];
                            } else {
                                this.splitTree = node.children[0];
                            }
                        }
                        return true;
                    }
                }
            }
            return false;
        };

        removeFromNode(this.splitTree, null, 0);
    }

    async splitPane(direction) {
        if (!this.activePaneId) return;

        const activePane = this.panes.get(this.activePaneId);
        if (!activePane) return;

        // Get the original session to copy its directory
        const originalSession = this.sessions.get(activePane.sessionId);
        if (!originalSession) return;

        // Create a new session with the same directory
        // Mark it as a split child so it doesn't get its own robot in 3D view
        try {
            const response = await fetch('/api/sessions/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: `${originalSession.name} (split)`,
                    directory: originalSession.directory,
                    split_parent_id: this.primarySessionId
                })
            });

            if (!response.ok) throw new Error('Failed to create session');

            const newSession = await response.json();
            this.sessions.set(newSession.id, newSession);

            // Create new pane (don't add to container yet)
            const newPane = this.createPane(newSession.id, false);

            // Update split tree
            this.updateSplitTree(this.activePaneId, newPane.paneId, direction);

            // Re-render the tree
            this.renderSplitTree();

            // Subscribe and start the new session
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                session_id: newSession.id
            }));

            this.ws.send(JSON.stringify({
                type: 'start',
                session_id: newSession.id,
                data: { rows: newPane.terminal.rows, cols: newPane.terminal.cols }
            }));

            // Focus new pane
            this.setActivePane(newPane.paneId);

            // Save layout
            this.saveSplitLayout();

        } catch (err) {
            console.error('Failed to split pane:', err);
        }
    }

    // Update split tree: replace pane node with a split containing old and new pane
    updateSplitTree(oldPaneId, newPaneId, direction) {
        const oldPane = this.panes.get(oldPaneId);
        const newPane = this.panes.get(newPaneId);
        const oldPaneNode = { type: 'pane', paneId: oldPaneId, sessionId: oldPane?.sessionId };
        const newPaneNode = { type: 'pane', paneId: newPaneId, sessionId: newPane?.sessionId };

        if (!this.splitTree) {
            // First split: create root split node
            this.splitTree = {
                type: 'split',
                direction: direction,
                children: [oldPaneNode, newPaneNode]
            };
            return;
        }

        // Find and replace the old pane node in the tree
        const replaceInTree = (node) => {
            if (node.type === 'pane') {
                return node.paneId === oldPaneId;
            }
            if (node.type === 'split') {
                for (let i = 0; i < node.children.length; i++) {
                    if (node.children[i].type === 'pane' && node.children[i].paneId === oldPaneId) {
                        // Replace this pane with a split
                        node.children[i] = {
                            type: 'split',
                            direction: direction,
                            children: [oldPaneNode, newPaneNode]
                        };
                        return true;
                    } else if (replaceInTree(node.children[i])) {
                        return true;
                    }
                }
            }
            return false;
        };

        // Handle case where root is the pane being split
        if (this.splitTree.type === 'pane' && this.splitTree.paneId === oldPaneId) {
            this.splitTree = {
                type: 'split',
                direction: direction,
                children: [oldPaneNode, newPaneNode]
            };
        } else {
            replaceInTree(this.splitTree);
        }
    }

    // Render the split tree to DOM
    renderSplitTree() {
        const panesContainer = document.getElementById('session-panes');

        // Destroy all existing split instances
        this.splitInstances.forEach(s => s.destroy());
        this.splitInstances = [];

        // Clear container
        panesContainer.innerHTML = '';
        panesContainer.className = '';

        if (!this.splitTree) {
            // No tree yet, just add single pane
            if (this.panes.size === 1) {
                const pane = this.panes.values().next().value;
                panesContainer.appendChild(pane.element);
            }
            return;
        }

        // Recursively render tree
        const renderNode = (node, container) => {
            if (node.type === 'pane') {
                const pane = this.panes.get(node.paneId);
                if (pane) {
                    container.appendChild(pane.element);
                }
                return [pane?.element];
            }

            if (node.type === 'split') {
                // Create container for this split level
                const splitContainer = document.createElement('div');
                splitContainer.className = `split-container ${node.direction}`;
                container.appendChild(splitContainer);

                // Render children
                const childElements = [];
                node.children.forEach(child => {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'split-child';
                    splitContainer.appendChild(wrapper);
                    renderNode(child, wrapper);
                    childElements.push(wrapper);
                });

                // Initialize Split.js for this level
                if (childElements.length >= 2) {
                    const splitInstance = Split(childElements, {
                        direction: node.direction,
                        sizes: childElements.map(() => 100 / childElements.length),
                        minSize: 50,
                        gutterSize: 4,
                        onDragEnd: () => {
                            // Refit all terminals after resize
                            this.panes.forEach(pane => {
                                pane.fitAddon.fit();
                                this.sendResize(pane.sessionId, pane.terminal.rows, pane.terminal.cols);
                            });
                        }
                    });
                    this.splitInstances.push(splitInstance);
                }

                return childElements;
            }
        };

        renderNode(this.splitTree, panesContainer);

        // Refit all terminals after rendering
        setTimeout(() => {
            this.panes.forEach(pane => {
                pane.fitAddon.fit();
            });
        }, 50);
    }

    // Legacy function for compatibility
    rebuildSplit(direction) {
        this.renderSplitTree();
    }

    closeModal() {
        // Legacy function - now just clears the current session view
        this.closeCurrentSession();
        this.activeSessionId = null;
        document.getElementById('session-header').classList.add('hidden');
        document.getElementById('empty-content').classList.remove('hidden');
        document.querySelectorAll('.session-card').forEach(card => card.classList.remove('active'));
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

        // Close all sessions button
        document.getElementById('close-all-sessions').onclick = () => {
            if (this.sessions.size === 0) return;
            this.showConfirm(`Close all ${this.sessions.size} sessions?`, () => {
                this.closeAllSessions();
            });
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

        // Restart session
        document.getElementById('session-restart').onclick = () => this.restartSession();

        // Split panes
        document.getElementById('session-split-h').onclick = () => this.splitPane('horizontal');
        document.getElementById('session-split-v').onclick = () => this.splitPane('vertical');

        // Experiment from session header
        document.getElementById('session-experiment').onclick = () => {
            if (this.activePaneId) {
                const pane = this.panes.get(this.activePaneId);
                if (pane) {
                    this.createExperiment(pane.sessionId);
                }
            }
        };

        // Merge experiment
        document.getElementById('session-exp-merge').onclick = () => {
            if (this.activePaneId) {
                const pane = this.panes.get(this.activePaneId);
                if (pane) {
                    this.mergeExperiment(pane.sessionId);
                }
            }
        };

        // Discard experiment
        document.getElementById('session-exp-discard').onclick = () => {
            if (this.activePaneId) {
                const pane = this.panes.get(this.activePaneId);
                if (pane) {
                    this.discardExperiment(pane.sessionId);
                }
            }
        };

        // Delete from session header
        document.getElementById('session-delete').onclick = () => {
            if (this.activeSessionId) {
                const session = this.sessions.get(this.activeSessionId);
                const name = session?.name || this.activeSessionId;
                this.showConfirm(`Delete "${name}"?`, () => {
                    this.deleteSession(this.activeSessionId);
                });
            }
        };

        // Keyboard shortcuts
        this.setupKeyboardShortcuts();

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

        // Update all pane terminals theme
        this.panes.forEach(pane => {
            pane.terminal.options.theme = this.getTerminalTheme(isDark);
        });
    }

    // Keyboard shortcuts system
    getShortcutsList() {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmd = isMac ? 'Cmd' : 'Ctrl';

        return [
            { category: 'General', shortcuts: [
                { keys: `F1`, action: 'Show shortcuts help', id: 'showHelp' },
                { keys: `Esc`, action: 'Close dialogs', id: 'closeDialog' },
            ]},
            { category: 'Pane Navigation', shortcuts: [
                { keys: `${cmd}+1-9`, action: 'Switch to pane N', id: 'switchPane' },
                { keys: `${cmd}+Arrow`, action: 'Navigate between panes', id: 'navigatePane' },
                { keys: `${cmd}+]`, action: 'Next pane', id: 'nextPane' },
                { keys: `${cmd}+[`, action: 'Previous pane', id: 'prevPane' },
            ]},
            { category: '3D View', shortcuts: [
                { keys: 'Space', action: 'Reset camera view', id: 'resetCamera' },
                { keys: 'Cmd (hold)', action: 'Show robot names', id: 'showLabels' },
            ]},
            { category: 'Terminal', shortcuts: [
                { keys: 'Shift+Enter', action: 'Send special Enter', id: 'shiftEnter' },
            ]},
        ];
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const dialog = document.getElementById('new-session-dialog');
            const shortcutsModal = document.getElementById('shortcuts-modal');
            const shortcutsOpen = shortcutsModal && !shortcutsModal.classList.contains('hidden');
            const hasActiveSession = this.activeSessionId !== null;

            // F1 - Show shortcuts help
            if (e.key === 'F1') {
                e.preventDefault();
                this.toggleShortcutsModal();
                return;
            }

            // Escape closes shortcuts modal first
            if (e.key === 'Escape' && shortcutsOpen) {
                e.preventDefault();
                this.hideShortcutsModal();
                return;
            }

            // Escape closes dialogs
            if (e.key === 'Escape' && !e.shiftKey) {
                if (!dialog.classList.contains('hidden')) {
                    dialog.classList.add('hidden');
                }
            }

            // Pane navigation shortcuts (only when a session is open)
            if (hasActiveSession && (e.metaKey || e.ctrlKey)) {
                // Cmd+1-9 - Switch to pane by number
                const num = parseInt(e.key);
                if (num >= 1 && num <= 9) {
                    e.preventDefault();
                    this.switchToPaneByIndex(num - 1);
                    return;
                }

                // Cmd+] - Next pane
                if (e.key === ']') {
                    e.preventDefault();
                    this.navigateToNextPane(1);
                    return;
                }

                // Cmd+[ - Previous pane
                if (e.key === '[') {
                    e.preventDefault();
                    this.navigateToNextPane(-1);
                    return;
                }

                // Cmd+Arrow - Navigate between panes
                if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                    e.preventDefault();
                    this.navigatePaneByDirection(e.key);
                    return;
                }
            }
        });
    }

    switchToPaneByIndex(index) {
        const paneIds = Array.from(this.panes.keys());
        if (index >= 0 && index < paneIds.length) {
            this.setActivePane(paneIds[index]);
        }
    }

    navigateToNextPane(direction) {
        const paneIds = Array.from(this.panes.keys());
        if (paneIds.length < 2) return;

        const currentIndex = paneIds.indexOf(this.activePaneId);
        let newIndex = currentIndex + direction;

        // Wrap around
        if (newIndex < 0) newIndex = paneIds.length - 1;
        if (newIndex >= paneIds.length) newIndex = 0;

        this.setActivePane(paneIds[newIndex]);
    }

    navigatePaneByDirection(arrowKey) {
        const panes = Array.from(this.panes.values());
        if (panes.length < 2) return;

        const activePane = this.panes.get(this.activePaneId);
        if (!activePane) return;

        const activeRect = activePane.element.getBoundingClientRect();
        const activeCenterX = activeRect.left + activeRect.width / 2;
        const activeCenterY = activeRect.top + activeRect.height / 2;

        let bestPane = null;
        let bestScore = Infinity;

        for (const pane of panes) {
            if (pane.paneId === this.activePaneId) continue;

            const rect = pane.element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const dx = centerX - activeCenterX;
            const dy = centerY - activeCenterY;

            let score = Infinity;
            const threshold = 20; // Minimum distance in the right direction

            switch (arrowKey) {
                case 'ArrowLeft':
                    if (dx < -threshold) score = Math.abs(dy) - dx;
                    break;
                case 'ArrowRight':
                    if (dx > threshold) score = Math.abs(dy) + dx;
                    break;
                case 'ArrowUp':
                    if (dy < -threshold) score = Math.abs(dx) - dy;
                    break;
                case 'ArrowDown':
                    if (dy > threshold) score = Math.abs(dx) + dy;
                    break;
            }

            if (score < bestScore) {
                bestScore = score;
                bestPane = pane;
            }
        }

        if (bestPane) {
            this.setActivePane(bestPane.paneId);
        }
    }

    toggleShortcutsModal() {
        const modal = document.getElementById('shortcuts-modal');
        if (modal) {
            modal.classList.toggle('hidden');
        } else {
            this.showShortcutsModal();
        }
    }

    showShortcutsModal() {
        let modal = document.getElementById('shortcuts-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'shortcuts-modal';
            modal.className = 'shortcuts-modal';
            document.body.appendChild(modal);
        }

        const shortcuts = this.getShortcutsList();

        modal.innerHTML = `
            <div class="shortcuts-content">
                <div class="shortcuts-header">
                    <h2>Keyboard Shortcuts</h2>
                    <button class="shortcuts-close">&times;</button>
                </div>
                <div class="shortcuts-body">
                    ${shortcuts.map(cat => `
                        <div class="shortcuts-category">
                            <h3>${cat.category}</h3>
                            <div class="shortcuts-list">
                                ${cat.shortcuts.map(s => `
                                    <div class="shortcut-item">
                                        <span class="shortcut-keys">${this.formatKeys(s.keys)}</span>
                                        <span class="shortcut-action">${s.action}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        modal.classList.remove('hidden');

        modal.querySelector('.shortcuts-close').onclick = () => this.hideShortcutsModal();
        modal.onclick = (e) => {
            if (e.target === modal) this.hideShortcutsModal();
        };
    }

    hideShortcutsModal() {
        const modal = document.getElementById('shortcuts-modal');
        if (modal) modal.classList.add('hidden');
    }

    formatKeys(keys) {
        return keys
            .split('+')
            .map(k => `<kbd>${k}</kbd>`)
            .join(' + ');
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

        const mainLayout = document.getElementById('main-layout');
        const world3d = document.getElementById('world-3d');
        const viewToggle = document.getElementById('view-toggle');
        const viewIcon = viewToggle.querySelector('.view-icon');

        if (this.is3DView) {
            // Switch to 3D
            mainLayout.classList.add('hidden');
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
            mainLayout.classList.remove('hidden');
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
        // Default to 2D view unless explicitly set to true
        if (this.clientState?.view3d === true) {
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
