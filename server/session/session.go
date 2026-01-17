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
	Directory    string            `json:"directory"`                // Working directory
	ParentID     string            `json:"parent_id,omitempty"`      // Parent session ID (for experiments)
	WorktreePath string            `json:"worktree_path,omitempty"`  // Git worktree path
	Branch       string            `json:"branch,omitempty"`         // Git branch name

	// Internal fields (not serialized)
	cmd       *exec.Cmd
	pty       *os.File
	mu        sync.RWMutex
	done      chan struct{}
	output    []byte // Buffer for state detection
	scrollback []byte // Full terminal history buffer
}

// NewSession creates a new session with default values
func NewSession(id, name, directory string) *Session {
	return &Session{
		ID:        id,
		Name:      name,
		Status:    StatusIdle,
		Color:     "#6366f1", // Default indigo
		Metadata:  make(map[string]any),
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		Directory: directory,
		done:      make(chan struct{}),
	}
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

	log.Printf("[Session %s] PTY started successfully", s.ID)

	// Read output in goroutine
	go s.readOutput(onOutput)

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

	// Read output in goroutine
	go s.readOutput(onOutput)

	return nil
}

// Write sends input to the session
func (s *Session) Write(data []byte) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.pty == nil {
		return 0, os.ErrClosed
	}
	return s.pty.Write(data)
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

					// Save to scrollback buffer (keep last 64KB)
					s.mu.Lock()
					s.scrollback = append(s.scrollback, data...)
					if len(s.scrollback) > 64*1024 {
						s.scrollback = s.scrollback[len(s.scrollback)-64*1024:]
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

// detectStatus analyzes output to determine session state
func (s *Session) detectStatus(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Append to buffer for analysis (keep last 4KB for better context)
	s.output = append(s.output, data...)
	if len(s.output) > 4096 {
		s.output = s.output[len(s.output)-4096:]
	}

	str := string(s.output)
	recentStr := string(data) // Just the new data

	// Check for spinner characters first (thinking) - highest priority
	spinnerChars := "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
	for _, r := range spinnerChars {
		if containsRune(recentStr, r) {
			s.Status = StatusThinking
			s.UpdatedAt = time.Now()
			return
		}
	}

	// Check for tool execution patterns in recent output
	toolPatterns := []string{"Reading", "Writing", "Executing", "Searching", "── Edit", "── Bash", "── Read", "── Glob", "── Grep", "── Task"}
	for _, pattern := range toolPatterns {
		if containsString(recentStr, pattern) {
			s.Status = StatusExecuting
			s.UpdatedAt = time.Now()
			return
		}
	}

	// Look at the last line to determine state
	lastLine := getLastNonEmptyLine(str)

	// Shell prompt patterns (bash/zsh) - typically end with $ or %
	// and often have user@host or path patterns
	isShellPrompt := (len(lastLine) > 0 && (lastLine[len(lastLine)-1] == '$' || lastLine[len(lastLine)-1] == '%')) ||
		containsString(lastLine, "❯") && !containsString(str, "Claude") ||
		containsString(lastLine, "@") && (containsString(lastLine, ":") || containsString(lastLine, "~"))

	// Claude prompt patterns
	isClaudePrompt := containsString(lastLine, "> ") && (containsString(str, "Claude") || containsString(str, "claude") || containsString(str, "╭") || containsString(str, "│"))

	// Check for Claude-specific UI elements in buffer
	hasClaudeUI := containsString(str, "╭─") || containsString(str, "╰─") ||
		containsString(str, "│ ") || containsString(str, "Claude Code") ||
		containsString(str, "cost:") || containsString(str, "tokens:")

	if isShellPrompt && !hasClaudeUI {
		s.Status = StatusShell
		s.UpdatedAt = time.Now()
		return
	}

	if isClaudePrompt || hasClaudeUI {
		s.Status = StatusWaitingInput
		s.UpdatedAt = time.Now()
		return
	}

	// If we were in a Claude state, stay there unless clearly shell
	if s.Status == StatusThinking || s.Status == StatusExecuting || s.Status == StatusWaitingInput {
		// Keep current status if no clear indicator
		return
	}

	// Default to shell for new sessions
	s.Status = StatusShell
	s.UpdatedAt = time.Now()
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
