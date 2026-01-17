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
	connections map[*websocket.Conn]map[string]bool // conn -> subscribed session IDs
	saveTimers  map[string]*time.Timer              // session ID -> save timer
	mu          sync.RWMutex
}

// NewHandler creates a new WebSocket handler
func NewHandler(manager *session.Manager) *Handler {
	return &Handler{
		manager:     manager,
		connections: make(map[*websocket.Conn]map[string]bool),
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
	h.connections[conn] = make(map[string]bool)
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
	if subs, ok := h.connections[conn]; ok {
		subs[sessionID] = true
	}
	h.mu.Unlock()

	// Send existing scrollback to new subscriber
	sess, ok := h.manager.Get(sessionID)
	if ok {
		scrollback := sess.GetScrollback()
		if len(scrollback) > 0 {
			msg := OutputMessage{
				Type:      "output",
				SessionID: sessionID,
				Data:      base64.StdEncoding.EncodeToString(scrollback),
			}
			msgBytes, _ := json.Marshal(msg)
			conn.WriteMessage(websocket.TextMessage, msgBytes)
		}
	}
}

// handleUnsubscribe unsubscribes a connection from a session
func (h *Handler) handleUnsubscribe(conn *websocket.Conn, sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if subs, ok := h.connections[conn]; ok {
		delete(subs, sessionID)
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
	var size ResizeData
	rows := uint16(24)
	cols := uint16(80)
	if err := json.Unmarshal(data, &size); err == nil && size.Rows > 0 && size.Cols > 0 {
		rows = size.Rows
		cols = size.Cols
	}
	log.Printf("[WS] handleStart: initial size rows=%d cols=%d", rows, cols)

	// Subscribe this connection to the session
	h.handleSubscribe(conn, sessionID)

	// Start the session with output callback
	err := sess.Start(rows, cols, func(data []byte) {
		h.broadcastOutput(sessionID, data)
		h.broadcastStatus(sessionID, sess.GetStatus())
		h.scheduleScrollbackSave(sessionID, sess)
	})

	if err != nil {
		log.Printf("Failed to start session %s: %v", sessionID, err)
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
		h.manager.SaveScrollback(sess)
	})
}

// handleStop stops a session
func (h *Handler) handleStop(sessionID string) {
	sess, ok := h.manager.Get(sessionID)
	if !ok {
		return
	}

	// Save scrollback before stopping
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
	var size ResizeData
	rows := uint16(24)
	cols := uint16(80)
	if err := json.Unmarshal(data, &size); err == nil && size.Rows > 0 && size.Cols > 0 {
		rows = size.Rows
		cols = size.Cols
	}

	// Start the session again
	err := sess.Start(rows, cols, func(data []byte) {
		h.broadcastOutput(sessionID, data)
		h.broadcastStatus(sessionID, sess.GetStatus())
		h.scheduleScrollbackSave(sessionID, sess)
	})

	if err != nil {
		log.Printf("Failed to restart session %s: %v", sessionID, err)
	}
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

	for conn, subs := range h.connections {
		if subs[sessionID] {
			conn.WriteMessage(websocket.TextMessage, msgBytes)
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

	for conn, subs := range h.connections {
		if subs[sessionID] {
			conn.WriteMessage(websocket.TextMessage, msgBytes)
		}
	}
}

// HandleSessions returns the list of sessions (REST endpoint)
func (h *Handler) HandleSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

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
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Directory == "" {
		req.Directory, _ = os.Getwd()
	} else {
		// Expand ~ to home directory
		req.Directory = expandHome(req.Directory)
	}

	sess, err := h.manager.Create(req.Name, req.Directory)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
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

	default:
		http.Error(w, "Unknown action", http.StatusBadRequest)
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
