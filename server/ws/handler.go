package ws

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"claudex/claude"
	"claudex/session"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for development
	},
}

// Message represents a WebSocket message
type Message struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// OutputMessage represents terminal output
type OutputMessage struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	Data      string `json:"data"` // Base64 encoded for binary safety
}

// StatusMessage represents a status change
type StatusMessage struct {
	Type      string         `json:"type"`
	SessionID string         `json:"session_id"`
	Status    session.Status `json:"status"`
}

// ResizeData represents terminal resize request
type ResizeData struct {
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

// Handler manages WebSocket connections
type Handler struct {
	manager     *session.Manager
	connections map[*websocket.Conn]*connState // conn -> connection state
	saveTimers  map[string]*time.Timer         // session ID -> save timer
	mu          sync.RWMutex
}

// connState holds per-connection state with its own mutex for writes
type connState struct {
	subscriptions map[string]bool
	writeMu       sync.Mutex
}

// NewHandler creates a new WebSocket handler
func NewHandler(manager *session.Manager) *Handler {
	return &Handler{
		manager:     manager,
		connections: make(map[*websocket.Conn]*connState),
		saveTimers:  make(map[string]*time.Timer),
	}
}

// HandleConnection handles WebSocket connections
func (h *Handler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	h.mu.Lock()
	h.connections[conn] = &connState{subscriptions: make(map[string]bool)}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.connections, conn)
		h.mu.Unlock()
	}()

	for {
		_, messageBytes, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var msg Message
		if err := json.Unmarshal(messageBytes, &msg); err != nil {
			log.Printf("Invalid message: %v", err)
			continue
		}

		h.handleMessage(conn, msg)
	}
}

// handleMessage processes incoming WebSocket messages
func (h *Handler) handleMessage(conn *websocket.Conn, msg Message) {
	log.Printf("[WS] Received message: type=%s session_id=%s", msg.Type, msg.SessionID)
	switch msg.Type {
	case "subscribe":
		h.handleSubscribe(conn, msg.SessionID)

	case "unsubscribe":
		h.handleUnsubscribe(conn, msg.SessionID)

	case "input":
		h.handleInput(msg.SessionID, msg.Data)

	case "resize":
		h.handleResize(msg.SessionID, msg.Data)

	case "start":
		h.handleStart(conn, msg.SessionID, msg.Data)

	case "stop":
		h.handleStop(msg.SessionID)

	case "restart":
		h.handleRestart(conn, msg.SessionID, msg.Data)

	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

// handleSubscribe subscribes a connection to a session's output
func (h *Handler) handleSubscribe(conn *websocket.Conn, sessionID string) {
	h.mu.Lock()
	state, ok := h.connections[conn]
	if ok {
		state.subscriptions[sessionID] = true
	}
	h.mu.Unlock()

	if !ok {
		return
	}

	// Send existing scrollback to new subscriber
	sess, ok := h.manager.Get(sessionID)
	if ok {
		// Update cwd from process
		if sess.UpdateCwd() {
			h.manager.UpdateSession(sess)
		}

		scrollback := sess.GetScrollback()
		if len(scrollback) > 0 {
			msg := OutputMessage{
				Type:      "output",
				SessionID: sessionID,
				Data:      base64.StdEncoding.EncodeToString(scrollback),
			}
			msgBytes, _ := json.Marshal(msg)
			// Use per-connection mutex for writes
			state.writeMu.Lock()
			conn.WriteMessage(websocket.TextMessage, msgBytes)
			state.writeMu.Unlock()
		}
	}
}

// handleUnsubscribe unsubscribes a connection from a session
func (h *Handler) handleUnsubscribe(conn *websocket.Conn, sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if state, ok := h.connections[conn]; ok {
		delete(state.subscriptions, sessionID)
	}
}

// handleInput sends input to a session
func (h *Handler) handleInput(sessionID string, data json.RawMessage) {
	sess, ok := h.manager.Get(sessionID)
	if !ok {
		log.Printf("[WS] handleInput: session not found: %s", sessionID)
		return
	}

	var input string
	if err := json.Unmarshal(data, &input); err != nil {
		log.Printf("[WS] handleInput: failed to unmarshal: %v, raw: %s", err, string(data))
		return
	}

	// Track last input time
	sess.SetLastInputAt(time.Now())

	log.Printf("[WS] handleInput: writing %d bytes to session %s, raw input: %v", len(input), sessionID, []byte(input))
	n, err := sess.Write([]byte(input))
	if err != nil {
		log.Printf("[WS] handleInput: write error: %v", err)
	} else {
		log.Printf("[WS] handleInput: wrote %d bytes", n)
	}
}

// handleResize resizes a session's terminal
func (h *Handler) handleResize(sessionID string, data json.RawMessage) {
	sess, ok := h.manager.Get(sessionID)
	if !ok {
		log.Printf("[WS] handleResize: session not found: %s", sessionID)
		return
	}

	var resize ResizeData
	if err := json.Unmarshal(data, &resize); err != nil {
		log.Printf("[WS] handleResize: unmarshal error: %v, data: %s", err, string(data))
		return
	}

	log.Printf("[WS] handleResize: session=%s rows=%d cols=%d", sessionID, resize.Rows, resize.Cols)
	sess.Resize(resize.Rows, resize.Cols)
}

// handleStart starts a session
func (h *Handler) handleStart(conn *websocket.Conn, sessionID string, data json.RawMessage) {
	log.Printf("[WS] handleStart called for session: %s", sessionID)
	sess, ok := h.manager.Get(sessionID)
	if !ok {
		log.Printf("[WS] Session not found: %s", sessionID)
		return
	}

	// Parse initial size from data
	var startData struct {
		Rows uint16 `json:"rows"`
		Cols uint16 `json:"cols"`
	}
	rows := uint16(24)
	cols := uint16(80)
	if err := json.Unmarshal(data, &startData); err == nil {
		if startData.Rows > 0 && startData.Cols > 0 {
			rows = startData.Rows
			cols = startData.Cols
		}
	}
	log.Printf("[WS] handleStart: initial size rows=%d cols=%d", rows, cols)

	// Subscribe this connection to the session
	h.handleSubscribe(conn, sessionID)

	outputCallback := func(data []byte) {
		h.broadcastOutput(sessionID, data)
		h.broadcastStatus(sessionID, sess.GetStatus())
		h.scheduleScrollbackSave(sessionID, sess)
	}

	// Check for saved Claude Code session to resume (only resume the specific saved session)
	savedSessionID := sess.GetLastClaudeSessionID()
	if savedSessionID != "" {
		// Verify the saved session still exists and is recent
		claudeSession, err := claude.FindActiveSession(sess.Directory)
		if err == nil && claudeSession != nil && claudeSession.SessionID == savedSessionID {
			modified, err := time.Parse(time.RFC3339, claudeSession.Modified)
			if err == nil && time.Since(modified) < 24*time.Hour {
				log.Printf("[WS] Resuming saved Claude session %s for directory %s",
					savedSessionID, sess.Directory)

				err := sess.Resume(savedSessionID, rows, cols, outputCallback)
				if err == nil {
					return
				}
				log.Printf("[WS] Failed to resume saved Claude session, falling back to shell: %v", err)
			}
		}
	}

	// Start normal shell
	err := sess.Start(rows, cols, outputCallback)
	if err != nil {
		log.Printf("Failed to start session %s: %v", sessionID, err)
	}

	// Start background task to detect Claude session
	go h.detectClaudeSession(sessionID, sess)
}

// detectClaudeSession monitors for new Claude sessions and saves the session ID
func (h *Handler) detectClaudeSession(sessionID string, sess *session.Session) {
	// Check every 2 seconds for up to 5 minutes
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	timeout := time.After(5 * time.Minute)
	lastSessionID := ""

	for {
		select {
		case <-ticker.C:
			// Check if session is still running
			if sess.GetStatus() == session.StatusStopped {
				return
			}

			// Look for Claude session
			claudeSession, err := claude.FindActiveSession(sess.Directory)
			if err != nil || claudeSession == nil {
				continue
			}

			// If we found a new session, save it
			if claudeSession.SessionID != lastSessionID {
				lastSessionID = claudeSession.SessionID

				// Only save if it's different from what's already saved
				if sess.GetLastClaudeSessionID() != claudeSession.SessionID {
					log.Printf("[WS] Detected new Claude session %s for Claudex session %s",
						claudeSession.SessionID, sessionID)
					sess.SetLastClaudeSessionID(claudeSession.SessionID)
					h.manager.UpdateSession(sess)
				}
			}

		case <-timeout:
			return
		}
	}
}

// scheduleScrollbackSave schedules a debounced save of the scrollback
func (h *Handler) scheduleScrollbackSave(sessionID string, sess *session.Session) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Cancel existing timer if any
	if timer, ok := h.saveTimers[sessionID]; ok {
		timer.Stop()
	}

	// Schedule new save in 5 seconds
	h.saveTimers[sessionID] = time.AfterFunc(5*time.Second, func() {
		// Update cwd before saving
		if sess.UpdateCwd() {
			h.manager.UpdateSession(sess)
		}
		h.manager.SaveScrollback(sess)
	})
}

// handleStop stops a session
func (h *Handler) handleStop(sessionID string) {
	sess, ok := h.manager.Get(sessionID)
	if !ok {
		return
	}

	// Update cwd and save before stopping
	if sess.UpdateCwd() {
		h.manager.UpdateSession(sess)
	}
	h.manager.SaveScrollback(sess)

	sess.Stop()
	h.broadcastStatus(sessionID, session.StatusStopped)
}

// handleRestart restarts a stopped session
func (h *Handler) handleRestart(conn *websocket.Conn, sessionID string, data json.RawMessage) {
	log.Printf("[WS] handleRestart called for session: %s", sessionID)
	sess, ok := h.manager.Get(sessionID)
	if !ok {
		log.Printf("[WS] Session not found: %s", sessionID)
		return
	}

	// Reset the session for restart
	sess.Reset()

	// Parse size from data
	var restartData struct {
		Rows uint16 `json:"rows"`
		Cols uint16 `json:"cols"`
	}
	rows := uint16(24)
	cols := uint16(80)
	if err := json.Unmarshal(data, &restartData); err == nil {
		if restartData.Rows > 0 && restartData.Cols > 0 {
			rows = restartData.Rows
			cols = restartData.Cols
		}
	}

	outputCallback := func(data []byte) {
		h.broadcastOutput(sessionID, data)
		h.broadcastStatus(sessionID, sess.GetStatus())
		h.scheduleScrollbackSave(sessionID, sess)
	}

	// Check for saved Claude Code session to resume (only resume the specific saved session)
	savedSessionID := sess.GetLastClaudeSessionID()
	if savedSessionID != "" {
		claudeSession, err := claude.FindActiveSession(sess.Directory)
		if err == nil && claudeSession != nil && claudeSession.SessionID == savedSessionID {
			modified, err := time.Parse(time.RFC3339, claudeSession.Modified)
			if err == nil && time.Since(modified) < 24*time.Hour {
				log.Printf("[WS] Resuming saved Claude session %s on restart", savedSessionID)
				err := sess.Resume(savedSessionID, rows, cols, outputCallback)
				if err == nil {
					return
				}
				log.Printf("[WS] Failed to resume saved Claude session on restart: %v", err)
			}
		}
	}

	// Start normal shell
	err := sess.Start(rows, cols, outputCallback)
	if err != nil {
		log.Printf("Failed to restart session %s: %v", sessionID, err)
	}

	// Start background task to detect Claude session
	go h.detectClaudeSession(sessionID, sess)
}

// broadcastOutput sends output to all subscribed connections
func (h *Handler) broadcastOutput(sessionID string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	msg := OutputMessage{
		Type:      "output",
		SessionID: sessionID,
		Data:      base64.StdEncoding.EncodeToString(data), // Base64 encode for safe transmission
	}

	msgBytes, _ := json.Marshal(msg)

	for conn, state := range h.connections {
		if state.subscriptions[sessionID] {
			state.writeMu.Lock()
			conn.WriteMessage(websocket.TextMessage, msgBytes)
			state.writeMu.Unlock()
		}
	}
}

// broadcastStatus sends status updates to all subscribed connections
func (h *Handler) broadcastStatus(sessionID string, status session.Status) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	msg := StatusMessage{
		Type:      "status",
		SessionID: sessionID,
		Status:    status,
	}

	msgBytes, _ := json.Marshal(msg)

	for conn, state := range h.connections {
		if state.subscriptions[sessionID] {
			state.writeMu.Lock()
			conn.WriteMessage(websocket.TextMessage, msgBytes)
			state.writeMu.Unlock()
		}
	}
}

// HandleSessions returns the list of sessions (REST endpoint)
func (h *Handler) HandleSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Update cwds for all running sessions
	h.manager.UpdateAllSessionCwds()

	sessions := h.manager.List()
	json.NewEncoder(w).Encode(sessions)
}

// HandleCreateSession creates a new session (REST endpoint)
func (h *Handler) HandleCreateSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Name      string `json:"name"`
		Directory string `json:"directory"`
		HexQ      *int   `json:"hex_q"`
		HexR      *int   `json:"hex_r"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Directory == "" {
		// Default to home directory
		req.Directory, _ = os.UserHomeDir()
	} else {
		// Expand ~ to home directory
		req.Directory = expandHome(req.Directory)
	}

	sess, err := h.manager.Create(req.Name, req.Directory)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Set hex position if provided
	if req.HexQ != nil && req.HexR != nil {
		sess.HexQ = req.HexQ
		sess.HexR = req.HexR
		h.manager.UpdateSession(sess)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sess)
}

// findGitRoot finds the git root directory by searching up the tree
func findGitRoot(dir string) string {
	current := dir
	for {
		gitDir := filepath.Join(current, ".git")
		if _, err := os.Stat(gitDir); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			// Reached root
			return ""
		}
		current = parent
	}
}

// expandHome expands ~ to the user's home directory
func expandHome(path string) string {
	if len(path) == 0 || path[0] != '~' {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if len(path) == 1 {
		return home
	}
	return home + path[1:]
}

// HandleSessionUpdate handles session updates (name, etc.)
func (h *Handler) HandleSessionUpdate(w http.ResponseWriter, r *http.Request) {
	// Extract session ID from path: /api/sessions/{id} or /api/sessions/{id}/name
	path := r.URL.Path
	parts := strings.Split(strings.TrimPrefix(path, "/api/sessions/"), "/")
	if len(parts) < 1 || parts[0] == "" {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	sessionID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	sess, ok := h.manager.Get(sessionID)
	if !ok {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	// Handle DELETE for session itself (no action in path)
	if action == "" && r.Method == http.MethodDelete {
		// Save scrollback before deleting
		h.manager.SaveScrollback(sess)
		h.manager.Delete(sessionID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		return
	}

	switch action {
	case "claude-state":
		// Get Claude Code state for this session's directory
		state, err := claude.GetClaudeState(sess.Directory)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(state)
		return

	case "claude-session":
		// Get available Claude Code session for auto-resume
		claudeSession, err := claude.FindActiveSession(sess.Directory)
		if err != nil {
			// No session found is not an error
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{
				"available": false,
			})
			return
		}
		if claudeSession == nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{
				"available": false,
			})
			return
		}

		// Check if session is recent (within 24 hours)
		isRecent := false
		if modified, err := time.Parse(time.RFC3339, claudeSession.Modified); err == nil {
			isRecent = time.Since(modified) < 24*time.Hour
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"available":    isRecent,
			"sessionId":    claudeSession.SessionID,
			"firstPrompt":  claudeSession.FirstPrompt,
			"messageCount": claudeSession.MessageCount,
			"modified":     claudeSession.Modified,
			"gitBranch":    claudeSession.GitBranch,
		})
		return

	case "name":
		if r.Method != http.MethodPut {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		sess.Name = req.Name
		h.manager.UpdateSession(sess)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})

	case "customize":
		if r.Method != http.MethodPut {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Name           string `json:"name,omitempty"`
			RobotModel     string `json:"robot_model,omitempty"`
			RobotColor     string `json:"robot_color,omitempty"`
			RobotAccessory string `json:"robot_accessory,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// Update fields if provided
		if req.Name != "" {
			sess.Name = req.Name
		}
		if req.RobotModel != "" {
			sess.RobotModel = req.RobotModel
		}
		if req.RobotColor != "" {
			sess.RobotColor = req.RobotColor
		}
		if req.RobotAccessory != "" {
			sess.RobotAccessory = req.RobotAccessory
		}

		h.manager.UpdateSession(sess)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})

	default:
		http.Error(w, "Unknown action", http.StatusBadRequest)
	}
}

// HandleClientState handles GET/PUT for client UI state
func (h *Handler) HandleClientState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		state, err := h.manager.GetClientState()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(state)

	case http.MethodPut:
		var state session.ClientState
		if err := json.NewDecoder(r.Body).Decode(&state); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := h.manager.SaveClientState(&state); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleCreateExperiment creates a new experiment (git worktree) from a session
func (h *Handler) HandleCreateExperiment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		ParentID   string   `json:"parent_id"`
		BranchName string   `json:"branch_name"`
		CopyFiles  []string `json:"copy_files"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Get parent session
	parent, ok := h.manager.Get(req.ParentID)
	if !ok {
		http.Error(w, "Parent session not found", http.StatusNotFound)
		return
	}

	// Find git root directory (search up the tree)
	gitRoot := findGitRoot(parent.Directory)
	if gitRoot == "" {
		http.Error(w, "Parent directory is not a git repository", http.StatusBadRequest)
		return
	}

	// Get current branch name
	cmd := exec.Command("git", "branch", "--show-current")
	cmd.Dir = gitRoot
	currentBranchBytes, err := cmd.Output()
	if err != nil {
		http.Error(w, "Failed to get current branch", http.StatusInternalServerError)
		return
	}
	currentBranch := strings.TrimSpace(string(currentBranchBytes))

	// Generate branch name if not provided
	branchName := req.BranchName
	if branchName == "" {
		branchName = fmt.Sprintf("exp-%s-%d", currentBranch, time.Now().Unix())
	}

	// Create worktree path (sibling to git root)
	worktreePath := filepath.Join(filepath.Dir(gitRoot), branchName)

	// Create the git worktree
	cmd = exec.Command("git", "worktree", "add", "-b", branchName, worktreePath)
	cmd.Dir = gitRoot
	if output, err := cmd.CombinedOutput(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to create worktree: %s", string(output)), http.StatusInternalServerError)
		return
	}

	// Detect and copy config files from git root
	configFiles := []string{".env", "config.json", "config.local.json", ".env.local"}
	for _, file := range configFiles {
		srcPath := filepath.Join(gitRoot, file)
		if _, err := os.Stat(srcPath); err == nil {
			dstPath := filepath.Join(worktreePath, file)
			if data, err := os.ReadFile(srcPath); err == nil {
				os.WriteFile(dstPath, data, 0644)
			}
		}
	}

	// Copy any additional requested files
	for _, file := range req.CopyFiles {
		srcPath := filepath.Join(gitRoot, file)
		if _, err := os.Stat(srcPath); err == nil {
			dstPath := filepath.Join(worktreePath, file)
			if data, err := os.ReadFile(srcPath); err == nil {
				os.MkdirAll(filepath.Dir(dstPath), 0755)
				os.WriteFile(dstPath, data, 0644)
			}
		}
	}

	// Create the experiment session
	sess, err := h.manager.CreateExperiment(req.ParentID, branchName, worktreePath)
	if err != nil {
		// Cleanup worktree on failure
		exec.Command("git", "worktree", "remove", worktreePath).Run()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sess)
}
