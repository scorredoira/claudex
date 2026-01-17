package session

import (
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

// Status represents the current state of a Claude Code session
type Status string

const (
	StatusIdle         Status = "idle"          // Session created but not started
	StatusShell        Status = "shell"         // Normal shell, Claude not running
	StatusThinking     Status = "thinking"      // Claude is processing
	StatusExecuting    Status = "executing"     // Running a tool
	StatusWaitingInput Status = "waiting_input" // Waiting for user input
	StatusError        Status = "error"         // Error state
	StatusStopped      Status = "stopped"       // Session terminated
)

// StateTracker provides temporal and contextual state detection
type StateTracker struct {
	lastInputTime    time.Time     // When user last sent input
	lastOutputTime   time.Time     // When we last received output
	stateChangedAt   time.Time     // When state last changed
	confidence       float64       // Confidence in current state (0.0 - 1.0)

	// I/O rate tracking
	outputBytes      int64         // Bytes received in current window
	outputWindowStart time.Time    // Start of measurement window
	outputRate       float64       // Bytes per second

	// Multi-line context buffer
	lines            []LineEntry   // Circular buffer of recent lines
	maxLines         int           // Max lines to keep (default 50)

	// Claude session detection
	claudeActive     bool          // Whether we think Claude is running
	claudeStartedAt  time.Time     // When Claude was detected as started
}

// LineEntry represents a line with its timestamp
type LineEntry struct {
	Content   string
	Timestamp time.Time
	HasSpinner bool
	HasToolPattern bool
	HasClaudeUI bool
	HasShellPrompt bool
}

// Timeout configuration
const (
	ThinkingTimeout     = 60 * time.Second  // Max time in thinking before assuming waiting
	ExecutingTimeout    = 5 * time.Minute   // Max time executing a tool
	NoOutputTimeout     = 30 * time.Second  // No output = probably waiting for input
	InputToThinkingDelay = 500 * time.Millisecond // After input, wait before assuming thinking
	IOWindowDuration    = 2 * time.Second   // Window for I/O rate calculation
)

// Position3D represents coordinates in the 3D hex world (Phase 2)
type Position3D struct {
	Q     int     `json:"q"`     // Hex coordinate Q
	R     int     `json:"r"`     // Hex coordinate R
	Layer float64 `json:"layer"` // Vertical layer
}

// Session represents a Claude Code terminal session
type Session struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Status       Status            `json:"status"`
	Color        string            `json:"color"`                    // Hex color for UI
	Position     *Position3D       `json:"position,omitempty"`       // For Phase 2 3D world
	Metadata     map[string]any    `json:"metadata,omitempty"`       // Extensible metadata
	CreatedAt    time.Time         `json:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at"`
	LastInputAt  time.Time         `json:"last_input_at,omitempty"`  // Last user input time
	Directory    string            `json:"directory"`                // Working directory
	ParentID     string            `json:"parent_id,omitempty"`      // Parent session ID (for experiments)
	WorktreePath string            `json:"worktree_path,omitempty"`  // Git worktree path
	Branch       string            `json:"branch,omitempty"`         // Git branch name

	// Internal fields (not serialized)
	cmd        *exec.Cmd
	pty        *os.File
	mu         sync.RWMutex
	done       chan struct{}
	output     []byte       // Buffer for state detection (legacy, kept for compatibility)
	scrollback []byte       // Full terminal history buffer
	tracker    *StateTracker // Enhanced state tracking
	onStatusChange func(Status) // Callback when status changes
}

// NewSession creates a new session with default values
func NewSession(id, name, directory string) *Session {
	now := time.Now()
	return &Session{
		ID:        id,
		Name:      name,
		Status:    StatusIdle,
		Color:     "#6366f1", // Default indigo
		Metadata:  make(map[string]any),
		CreatedAt: now,
		UpdatedAt: now,
		Directory: directory,
		done:      make(chan struct{}),
		tracker:   newStateTracker(),
	}
}

// newStateTracker creates a new initialized StateTracker
func newStateTracker() *StateTracker {
	now := time.Now()
	return &StateTracker{
		lastOutputTime:    now,
		stateChangedAt:    now,
		outputWindowStart: now,
		confidence:        1.0,
		lines:             make([]LineEntry, 0, 50),
		maxLines:          50,
	}
}

// SetStatusChangeCallback sets a callback for status changes
func (s *Session) SetStatusChangeCallback(cb func(Status)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onStatusChange = cb
}

// SetLastInputAt updates the last input timestamp
func (s *Session) SetLastInputAt(t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastInputAt = t
}

// Start launches Claude Code in this session
func (s *Session) Start(rows, cols uint16, onOutput func([]byte)) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	log.Printf("[Session %s] Starting shell in directory: %s (size: %dx%d)", s.ID, s.Directory, cols, rows)

	// Get user's shell
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}

	// Create command with login shell
	s.cmd = exec.Command(shell, "-l")
	s.cmd.Dir = s.Directory
	s.cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"LANG=en_US.UTF-8",
		"LC_ALL=en_US.UTF-8",
	)

	// Start with PTY and initial size
	ptmx, err := pty.StartWithSize(s.cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		log.Printf("[Session %s] Failed to start PTY: %v", s.ID, err)
		s.Status = StatusError
		return err
	}
	s.pty = ptmx
	s.Status = StatusShell
	s.UpdatedAt = time.Now()

	// Initialize tracker timestamps
	now := time.Now()
	s.tracker.lastOutputTime = now
	s.tracker.stateChangedAt = now

	log.Printf("[Session %s] PTY started successfully", s.ID)

	// Read output in goroutine
	go s.readOutput(onOutput)

	// Start timeout monitor goroutine
	go s.monitorTimeouts()

	return nil
}

// Resume resumes a previous Claude Code session
func (s *Session) Resume(sessionID string, onOutput func([]byte)) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Create command with resume flag
	s.cmd = exec.Command("claude", "--resume", sessionID)
	s.cmd.Dir = s.Directory
	s.cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	// Start with PTY
	ptmx, err := pty.Start(s.cmd)
	if err != nil {
		s.Status = StatusError
		return err
	}
	s.pty = ptmx
	s.Status = StatusWaitingInput
	s.UpdatedAt = time.Now()

	// Initialize tracker for Claude session
	now := time.Now()
	s.tracker.lastOutputTime = now
	s.tracker.stateChangedAt = now
	s.tracker.claudeActive = true

	// Read output in goroutine
	go s.readOutput(onOutput)

	// Start timeout monitor
	go s.monitorTimeouts()

	return nil
}

// Write sends input to the session
func (s *Session) Write(data []byte) (int, error) {
	s.mu.Lock()
	s.tracker.lastInputTime = time.Now()
	ptyRef := s.pty
	s.mu.Unlock()

	if ptyRef == nil {
		return 0, os.ErrClosed
	}
	return ptyRef.Write(data)
}

// Resize changes the terminal size
func (s *Session) Resize(rows, cols uint16) error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.pty == nil {
		return os.ErrClosed
	}
	return pty.Setsize(s.pty, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
}

// Stop terminates the session
func (s *Session) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
	if s.pty != nil {
		s.pty.Close()
	}
	s.Status = StatusStopped
	s.UpdatedAt = time.Now()

	// Only close if not already closed
	select {
	case <-s.done:
		// Already closed
	default:
		close(s.done)
	}
	return nil
}

// Reset prepares the session for restart
func (s *Session) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Clean up old resources
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
	if s.pty != nil {
		s.pty.Close()
	}

	// Reset state
	s.cmd = nil
	s.pty = nil
	s.done = make(chan struct{})
	s.output = nil
	s.scrollback = nil
	s.tracker = newStateTracker() // Reset tracker
	s.Status = StatusIdle
	s.UpdatedAt = time.Now()
}

// readOutput continuously reads from PTY and detects state
func (s *Session) readOutput(onOutput func([]byte)) {
	log.Printf("[Session %s] readOutput goroutine started", s.ID)
	buf := make([]byte, 4096)
	var pending []byte // Holds incomplete UTF-8 sequences

	for {
		select {
		case <-s.done:
			log.Printf("[Session %s] readOutput done signal received", s.ID)
			return
		default:
			n, err := s.pty.Read(buf)
			if err != nil {
				log.Printf("[Session %s] PTY read error: %v", s.ID, err)
				s.mu.Lock()
				s.Status = StatusStopped
				s.mu.Unlock()
				return
			}
			if n > 0 {
				// Combine pending bytes with new data
				data := append(pending, buf[:n]...)
				pending = nil

				// Find last complete UTF-8 sequence
				validLen := findLastValidUTF8(data)
				if validLen < len(data) {
					pending = make([]byte, len(data)-validLen)
					copy(pending, data[validLen:])
					data = data[:validLen]
				}

				if len(data) > 0 {
					log.Printf("[Session %s] Sending %d bytes", s.ID, len(data))

					// Save to scrollback buffer (keep last 1MB)
					s.mu.Lock()
					s.scrollback = append(s.scrollback, data...)
					if len(s.scrollback) > 1024*1024 {
						s.scrollback = s.scrollback[len(s.scrollback)-1024*1024:]
					}
					s.mu.Unlock()
					s.detectStatus(data)
					if onOutput != nil {
						onOutput(data)
					}
				}
			}
		}
	}
}

// findLastValidUTF8 returns the length of the longest prefix that is valid UTF-8
func findLastValidUTF8(data []byte) int {
	// Check from the end for incomplete multi-byte sequences
	n := len(data)
	if n == 0 {
		return 0
	}

	// Check last 1-3 bytes for start of incomplete sequence
	for i := 1; i <= 3 && i <= n; i++ {
		b := data[n-i]
		if b&0x80 == 0 {
			// ASCII byte, everything before is complete
			return n
		}
		if b&0xC0 == 0xC0 {
			// Start of multi-byte sequence
			// Check if it's complete
			expectedLen := 0
			if b&0xE0 == 0xC0 {
				expectedLen = 2
			} else if b&0xF0 == 0xE0 {
				expectedLen = 3
			} else if b&0xF8 == 0xF0 {
				expectedLen = 4
			}
			if i < expectedLen {
				// Incomplete sequence
				return n - i
			}
			return n
		}
	}
	return n
}

// monitorTimeouts watches for state timeouts and recovers stuck states
func (s *Session) monitorTimeouts() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.checkTimeouts()
		}
	}
}

// checkTimeouts evaluates if current state has timed out
func (s *Session) checkTimeouts() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.Status == StatusStopped || s.Status == StatusError || s.Status == StatusIdle {
		return
	}

	now := time.Now()
	timeSinceOutput := now.Sub(s.tracker.lastOutputTime)
	timeSinceInput := now.Sub(s.tracker.lastInputTime)
	timeSinceStateChange := now.Sub(s.tracker.stateChangedAt)

	oldStatus := s.Status

	switch s.Status {
	case StatusThinking:
		// If thinking for too long without output, probably waiting for input
		if timeSinceOutput > ThinkingTimeout {
			log.Printf("[Session %s] Thinking timeout (%.1fs), transitioning to waiting_input",
				s.ID, timeSinceOutput.Seconds())
			s.Status = StatusWaitingInput
			s.tracker.confidence = 0.6
		}

	case StatusExecuting:
		// Tool execution timeout
		if timeSinceStateChange > ExecutingTimeout {
			log.Printf("[Session %s] Executing timeout (%.1fs), transitioning to waiting_input",
				s.ID, timeSinceStateChange.Seconds())
			s.Status = StatusWaitingInput
			s.tracker.confidence = 0.5
		}

	case StatusShell, StatusWaitingInput:
		// If we sent input recently but no output, might be thinking
		if !s.tracker.lastInputTime.IsZero() &&
			timeSinceInput > InputToThinkingDelay &&
			timeSinceInput < 5*time.Second &&
			s.tracker.lastInputTime.After(s.tracker.lastOutputTime) {
			// Input was sent, no response yet - probably thinking
			if s.tracker.claudeActive {
				s.Status = StatusThinking
				s.tracker.confidence = 0.7
			}
		}
	}

	if s.Status != oldStatus {
		s.tracker.stateChangedAt = now
		s.UpdatedAt = now
		if s.onStatusChange != nil {
			// Call outside of lock
			cb := s.onStatusChange
			status := s.Status
			go cb(status)
		}
	}
}

// detectStatus analyzes output to determine session state (hybrid approach)
func (s *Session) detectStatus(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	s.tracker.lastOutputTime = now

	// Update I/O rate tracking
	s.updateIORate(len(data), now)

	// Append to legacy buffer for compatibility
	s.output = append(s.output, data...)
	if len(s.output) > 4096 {
		s.output = s.output[len(s.output)-4096:]
	}

	// Parse new data into lines and add to context buffer
	newLines := s.parseLines(string(data))
	s.addLinesToBuffer(newLines, now)

	// Hybrid detection: combine multiple signals
	oldStatus := s.Status
	newStatus, confidence := s.analyzeState()

	// Only change state if confidence is high enough or it's a clear transition
	if newStatus != oldStatus {
		if confidence >= 0.6 || s.isStrongTransition(oldStatus, newStatus) {
			s.Status = newStatus
			s.tracker.stateChangedAt = now
			s.tracker.confidence = confidence
			s.UpdatedAt = now
			log.Printf("[Session %s] State: %s -> %s (confidence: %.2f)",
				s.ID, oldStatus, newStatus, confidence)
		}
	} else {
		// Same state, but update confidence
		s.tracker.confidence = confidence
	}
}

// updateIORate tracks output velocity
func (s *Session) updateIORate(bytes int, now time.Time) {
	// Reset window if expired
	if now.Sub(s.tracker.outputWindowStart) > IOWindowDuration {
		s.tracker.outputRate = float64(s.tracker.outputBytes) / IOWindowDuration.Seconds()
		s.tracker.outputBytes = 0
		s.tracker.outputWindowStart = now
	}
	s.tracker.outputBytes += int64(bytes)
}

// parseLines splits data into individual lines with analysis
func (s *Session) parseLines(data string) []LineEntry {
	rawLines := strings.Split(data, "\n")
	entries := make([]LineEntry, 0, len(rawLines))

	for _, line := range rawLines {
		if len(strings.TrimSpace(line)) == 0 {
			continue
		}

		entry := LineEntry{
			Content:        line,
			Timestamp:      time.Now(),
			HasSpinner:     s.detectSpinner(line),
			HasToolPattern: s.detectToolPattern(line),
			HasClaudeUI:    s.detectClaudeUI(line),
			HasShellPrompt: s.detectShellPrompt(line),
		}
		entries = append(entries, entry)
	}
	return entries
}

// addLinesToBuffer adds lines to the circular buffer
func (s *Session) addLinesToBuffer(lines []LineEntry, now time.Time) {
	for _, line := range lines {
		line.Timestamp = now
		s.tracker.lines = append(s.tracker.lines, line)
	}

	// Trim to max size
	if len(s.tracker.lines) > s.tracker.maxLines {
		excess := len(s.tracker.lines) - s.tracker.maxLines
		s.tracker.lines = s.tracker.lines[excess:]
	}
}

// analyzeState performs hybrid state analysis
func (s *Session) analyzeState() (Status, float64) {
	// 1. Check high-confidence patterns in recent lines (last 5)
	recentLines := s.getRecentLines(5)

	// Spinner = definitely thinking
	for _, line := range recentLines {
		if line.HasSpinner {
			s.tracker.claudeActive = true
			return StatusThinking, 0.95
		}
	}

	// Tool patterns = executing
	for _, line := range recentLines {
		if line.HasToolPattern {
			s.tracker.claudeActive = true
			return StatusExecuting, 0.90
		}
	}

	// 2. Analyze context from all buffered lines
	contextStatus, contextConf := s.analyzeContext()
	if contextConf >= 0.8 {
		return contextStatus, contextConf
	}

	// 3. I/O behavior analysis
	ioStatus, ioConf := s.analyzeIOBehavior()
	if ioConf >= 0.7 {
		return ioStatus, ioConf
	}

	// 4. Combine signals
	if contextConf >= 0.5 && ioConf >= 0.5 {
		// Both agree moderately
		if contextStatus == ioStatus {
			return contextStatus, (contextConf + ioConf) / 2
		}
	}

	// 5. Fall back to context analysis
	if contextConf >= 0.5 {
		return contextStatus, contextConf
	}

	// 6. Default: maintain current state with lower confidence
	return s.Status, 0.4
}

// getRecentLines returns the N most recent lines
func (s *Session) getRecentLines(n int) []LineEntry {
	if len(s.tracker.lines) <= n {
		return s.tracker.lines
	}
	return s.tracker.lines[len(s.tracker.lines)-n:]
}

// analyzeContext looks at the full line buffer for patterns
func (s *Session) analyzeContext() (Status, float64) {
	if len(s.tracker.lines) == 0 {
		return StatusShell, 0.3
	}

	// Count different indicators
	var spinnerCount, toolCount, claudeUICount, shellPromptCount int
	var lastClaudeUI, lastShellPrompt int = -1, -1

	for i, line := range s.tracker.lines {
		if line.HasSpinner {
			spinnerCount++
		}
		if line.HasToolPattern {
			toolCount++
		}
		if line.HasClaudeUI {
			claudeUICount++
			lastClaudeUI = i
		}
		if line.HasShellPrompt {
			shellPromptCount++
			lastShellPrompt = i
		}
	}

	totalLines := len(s.tracker.lines)

	// Recent spinner activity
	if spinnerCount > 0 {
		s.tracker.claudeActive = true
		return StatusThinking, 0.85
	}

	// Recent tool activity
	if toolCount > 0 {
		s.tracker.claudeActive = true
		return StatusExecuting, 0.80
	}

	// Claude UI present and more recent than shell prompt
	if claudeUICount > 0 && lastClaudeUI > lastShellPrompt {
		s.tracker.claudeActive = true
		// Check if it looks like a prompt (waiting for input)
		lastLine := s.tracker.lines[len(s.tracker.lines)-1]
		if s.looksLikeClaudePrompt(lastLine.Content) {
			return StatusWaitingInput, 0.85
		}
		return StatusWaitingInput, 0.70
	}

	// Shell prompt is most recent
	if shellPromptCount > 0 && lastShellPrompt > lastClaudeUI {
		// Check if Claude might still be active in background
		if claudeUICount > totalLines/4 {
			s.tracker.claudeActive = true
			return StatusWaitingInput, 0.55
		}
		s.tracker.claudeActive = false
		return StatusShell, 0.80
	}

	// No clear indicators
	if s.tracker.claudeActive {
		return StatusWaitingInput, 0.50
	}
	return StatusShell, 0.50
}

// analyzeIOBehavior uses I/O patterns to infer state
func (s *Session) analyzeIOBehavior() (Status, float64) {
	now := time.Now()
	timeSinceInput := now.Sub(s.tracker.lastInputTime)
	timeSinceOutput := now.Sub(s.tracker.lastOutputTime)

	// High output rate = probably executing
	if s.tracker.outputRate > 1000 { // > 1KB/s
		return StatusExecuting, 0.75
	}

	// Input sent recently, no output = thinking
	if !s.tracker.lastInputTime.IsZero() &&
		timeSinceInput < 10*time.Second &&
		s.tracker.lastInputTime.After(s.tracker.lastOutputTime) {
		if s.tracker.claudeActive {
			return StatusThinking, 0.65
		}
	}

	// No activity for a while = probably waiting
	if timeSinceOutput > 5*time.Second && s.tracker.claudeActive {
		return StatusWaitingInput, 0.60
	}

	return s.Status, 0.3
}

// isStrongTransition checks if state transition should override confidence threshold
func (s *Session) isStrongTransition(from, to Status) bool {
	// Shell -> anything Claude is strong (Claude just started)
	if from == StatusShell && (to == StatusThinking || to == StatusExecuting || to == StatusWaitingInput) {
		return true
	}
	// Thinking/Executing -> WaitingInput is natural
	if (from == StatusThinking || from == StatusExecuting) && to == StatusWaitingInput {
		return true
	}
	return false
}

// Detection helper functions
func (s *Session) detectSpinner(line string) bool {
	spinnerChars := "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
	for _, r := range spinnerChars {
		if containsRune(line, r) {
			return true
		}
	}
	return false
}

func (s *Session) detectToolPattern(line string) bool {
	toolPatterns := []string{
		"Reading", "Writing", "Executing", "Searching",
		"── Edit", "── Bash", "── Read", "── Glob", "── Grep", "── Task",
		"── Write", "── WebFetch", "── WebSearch", "── LSP",
		"✓ Edit", "✓ Bash", "✓ Read", "✓ Write",
		"⠋ Edit", "⠋ Bash", "⠋ Read", "⠋ Task",
	}
	for _, pattern := range toolPatterns {
		if containsString(line, pattern) {
			return true
		}
	}
	return false
}

func (s *Session) detectClaudeUI(line string) bool {
	claudePatterns := []string{
		"╭─", "╰─", "│ ",
		"Claude Code", "claude>",
		"cost:", "tokens:",
		"Tool Result", "Tool Call",
	}
	for _, pattern := range claudePatterns {
		if containsString(line, pattern) {
			return true
		}
	}
	return false
}

func (s *Session) detectShellPrompt(line string) bool {
	line = strings.TrimSpace(line)
	if len(line) == 0 {
		return false
	}

	// Common prompt endings
	lastChar := line[len(line)-1]
	if lastChar == '$' || lastChar == '%' || lastChar == '#' {
		return true
	}

	// Fish/Starship style prompts
	if containsString(line, "❯") && !containsString(line, "Claude") {
		return true
	}

	// user@host patterns
	if containsString(line, "@") && (containsString(line, ":") || containsString(line, "~")) {
		// But not if it's clearly Claude output
		if !containsString(line, "Claude") && !containsString(line, "│") {
			return true
		}
	}

	return false
}

func (s *Session) looksLikeClaudePrompt(line string) bool {
	line = strings.TrimSpace(line)
	// Claude's input prompt typically ends with "> " or similar
	if strings.HasSuffix(line, "> ") || strings.HasSuffix(line, ">") {
		return true
	}
	// Or contains the prompt marker with Claude context
	if containsString(line, "> ") && containsString(line, "│") {
		return true
	}
	return false
}

// getLastNonEmptyLine returns the last non-empty line from a string
func getLastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		// Skip empty lines and lines that are just ANSI codes
		if len(line) > 0 && !isOnlyAnsiCodes(line) {
			return line
		}
	}
	return ""
}

// isOnlyAnsiCodes checks if a string contains only ANSI escape codes
func isOnlyAnsiCodes(s string) bool {
	cleaned := s
	// Remove ANSI escape sequences
	for strings.Contains(cleaned, "\x1b[") {
		start := strings.Index(cleaned, "\x1b[")
		end := start + 2
		for end < len(cleaned) && !isAnsiTerminator(cleaned[end]) {
			end++
		}
		if end < len(cleaned) {
			end++ // Include terminator
		}
		cleaned = cleaned[:start] + cleaned[end:]
	}
	return len(strings.TrimSpace(cleaned)) == 0
}

func isAnsiTerminator(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}

func containsString(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && findSubstring(s, substr))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// GetStatus returns current status thread-safely
func (s *Session) GetStatus() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Status
}

// SetColor updates the session color
func (s *Session) SetColor(color string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Color = color
	s.UpdatedAt = time.Now()
}

// SetPosition updates the 3D position (Phase 2)
func (s *Session) SetPosition(pos *Position3D) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Position = pos
	s.UpdatedAt = time.Now()
}

// SetMetadata sets a metadata value
func (s *Session) SetMetadata(key string, value any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Metadata[key] = value
	s.UpdatedAt = time.Now()
}

// GetScrollback returns the terminal scrollback buffer
func (s *Session) GetScrollback() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]byte, len(s.scrollback))
	copy(result, s.scrollback)
	return result
}
