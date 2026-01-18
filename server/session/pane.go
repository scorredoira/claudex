package session

import (
	"bufio"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"claudex/claude"

	"github.com/creack/pty"
)

// GetProcessCwd returns the current working directory of the shell process
func (p *Pane) GetProcessCwd() (string, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if p.cmd == nil || p.cmd.Process == nil {
		return p.directory, nil
	}

	pid := p.cmd.Process.Pid
	return getProcessCwd(pid)
}

// getProcessCwd gets the cwd of a process by PID (cross-platform)
func getProcessCwd(pid int) (string, error) {
	switch runtime.GOOS {
	case "linux":
		link := "/proc/" + itoa(pid) + "/cwd"
		cwd, err := os.Readlink(link)
		if err != nil {
			return "", err
		}
		return cwd, nil

	case "darwin":
		cmd := exec.Command("lsof", "-a", "-d", "cwd", "-p", itoa(pid), "-Fn")
		output, err := cmd.Output()
		if err != nil {
			return "", err
		}
		scanner := bufio.NewScanner(strings.NewReader(string(output)))
		for scanner.Scan() {
			line := scanner.Text()
			if len(line) > 1 && line[0] == 'n' {
				return line[1:], nil
			}
		}
		return "", os.ErrNotExist

	default:
		return "", os.ErrNotExist
	}
}

// itoa converts int to string without importing strconv
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	n := len(b)
	neg := i < 0
	if neg {
		i = -i
	}
	for i > 0 {
		n--
		b[n] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		n--
		b[n] = '-'
	}
	return string(b[n:])
}

// Pane represents a single terminal pane within a session
type Pane struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"created_at"`

	// Internal fields (not serialized)
	cmd        *exec.Cmd
	pty        *os.File
	mu         sync.RWMutex
	done       chan struct{}
	scrollback []byte        // Full terminal history buffer
	tracker    *StateTracker // State tracking for this pane
	directory  string        // Working directory
	onOutput   func([]byte)  // Callback for output
	onStatus   func(Status)  // Callback for status changes
	status     Status        // Current status of this pane
}

// NewPane creates a new pane
func NewPane(id, directory string) *Pane {
	return &Pane{
		ID:        id,
		CreatedAt: time.Now(),
		done:      make(chan struct{}),
		tracker:   newStateTracker(),
		directory: directory,
		status:    StatusIdle,
	}
}

// Start launches a shell in this pane
func (p *Pane) Start(rows, cols uint16, onOutput func([]byte), onStatus func(Status)) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.onOutput = onOutput
	p.onStatus = onStatus

	log.Printf("[Pane %s] Starting shell in directory: %s (size: %dx%d)", p.ID, p.directory, cols, rows)

	// Get user's shell
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}

	// Create command with login shell
	p.cmd = exec.Command(shell, "-l")
	p.cmd.Dir = p.directory
	p.cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"LANG=en_US.UTF-8",
		"LC_ALL=en_US.UTF-8",
	)

	// Start with PTY and initial size
	ptmx, err := pty.StartWithSize(p.cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		log.Printf("[Pane %s] Failed to start PTY: %v", p.ID, err)
		p.status = StatusError
		return err
	}
	p.pty = ptmx
	p.status = StatusShell

	// Initialize tracker timestamps
	now := time.Now()
	p.tracker.lastOutputTime = now
	p.tracker.stateChangedAt = now

	log.Printf("[Pane %s] PTY started successfully", p.ID)

	// Read output in goroutine
	go p.readOutput()

	// Start timeout monitor goroutine
	go p.monitorTimeouts()

	return nil
}

// Resume resumes a Claude Code session in this pane
func (p *Pane) Resume(claudeSessionID string, rows, cols uint16, onOutput func([]byte), onStatus func(Status)) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.onOutput = onOutput
	p.onStatus = onStatus

	log.Printf("[Pane %s] Resuming Claude session: %s", p.ID, claudeSessionID)

	// Create command with resume flag
	p.cmd = exec.Command("claude", "--resume", claudeSessionID)
	p.cmd.Dir = p.directory
	p.cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"LANG=en_US.UTF-8",
		"LC_ALL=en_US.UTF-8",
	)

	// Start with PTY and initial size
	ptmx, err := pty.StartWithSize(p.cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		log.Printf("[Pane %s] Failed to resume Claude: %v", p.ID, err)
		p.status = StatusError
		return err
	}
	p.pty = ptmx
	p.status = StatusWaitingInput

	// Initialize tracker for Claude session
	now := time.Now()
	p.tracker.lastOutputTime = now
	p.tracker.stateChangedAt = now
	p.tracker.claudeActive = true
	p.tracker.claudeStartedAt = now

	log.Printf("[Pane %s] Claude session resumed successfully", p.ID)

	// Read output in goroutine
	go p.readOutput()

	// Start timeout monitor
	go p.monitorTimeouts()

	return nil
}

// Write sends input to the pane
func (p *Pane) Write(data []byte) (int, error) {
	p.mu.Lock()
	p.tracker.lastInputTime = time.Now()
	ptyRef := p.pty
	p.mu.Unlock()

	if ptyRef == nil {
		return 0, os.ErrClosed
	}
	return ptyRef.Write(data)
}

// Resize changes the terminal size
func (p *Pane) Resize(rows, cols uint16) error {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if p.pty == nil {
		return os.ErrClosed
	}
	return pty.Setsize(p.pty, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
}

// Stop terminates the pane
func (p *Pane) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cmd != nil && p.cmd.Process != nil {
		p.cmd.Process.Kill()
	}
	if p.pty != nil {
		p.pty.Close()
	}
	p.status = StatusStopped

	// Only close if not already closed
	select {
	case <-p.done:
		// Already closed
	default:
		close(p.done)
	}
	return nil
}

// GetStatus returns current status thread-safely
func (p *Pane) GetStatus() Status {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.status
}

// GetScrollback returns the terminal scrollback buffer
func (p *Pane) GetScrollback() []byte {
	p.mu.RLock()
	defer p.mu.RUnlock()
	result := make([]byte, len(p.scrollback))
	copy(result, p.scrollback)
	return result
}

// readOutput continuously reads from PTY and detects state
func (p *Pane) readOutput() {
	log.Printf("[Pane %s] readOutput goroutine started", p.ID)
	buf := make([]byte, 4096)
	var pending []byte // Holds incomplete UTF-8 sequences

	for {
		select {
		case <-p.done:
			log.Printf("[Pane %s] readOutput done signal received", p.ID)
			return
		default:
			n, err := p.pty.Read(buf)
			if err != nil {
				log.Printf("[Pane %s] PTY read error: %v", p.ID, err)
				p.mu.Lock()
				p.status = StatusStopped
				p.mu.Unlock()
				if p.onStatus != nil {
					p.onStatus(StatusStopped)
				}
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
					log.Printf("[Pane %s] Sending %d bytes", p.ID, len(data))

					// Save to scrollback buffer (keep last 1MB)
					p.mu.Lock()
					p.scrollback = append(p.scrollback, data...)
					if len(p.scrollback) > 1024*1024 {
						p.scrollback = p.scrollback[len(p.scrollback)-1024*1024:]
					}
					p.mu.Unlock()

					p.detectStatus(data)

					if p.onOutput != nil {
						p.onOutput(data)
					}
				}
			}
		}
	}
}

// monitorTimeouts watches for state timeouts and polls Claude transcript
func (p *Pane) monitorTimeouts() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			p.pollClaudeTranscript()
			p.checkTimeouts()
		}
	}
}

// pollClaudeTranscript reads Claude's transcript file for accurate state detection
func (p *Pane) pollClaudeTranscript() {
	p.mu.Lock()
	claudeActive := p.tracker.claudeActive
	directory := p.directory
	oldStatus := p.status
	p.mu.Unlock()

	if !claudeActive {
		return
	}

	// Get state from Claude's transcript file (source of truth)
	state, err := claude.GetClaudeState(directory)
	if err != nil {
		return
	}

	var newStatus Status
	switch state.Status {
	case "thinking":
		newStatus = StatusThinking
	case "executing":
		newStatus = StatusExecuting
	case "waiting_input":
		newStatus = StatusWaitingInput
	case "idle":
		// Claude session might have ended
		newStatus = StatusWaitingInput
	default:
		return // Don't change if unknown
	}

	if newStatus != oldStatus {
		p.mu.Lock()
		p.status = newStatus
		p.tracker.stateChangedAt = time.Now()
		p.tracker.confidence = 0.95 // High confidence from transcript
		onStatus := p.onStatus
		p.mu.Unlock()

		log.Printf("[Pane %s] Transcript state: %s -> %s (tool: %s)",
			p.ID, oldStatus, newStatus, state.CurrentTool)

		if onStatus != nil {
			go onStatus(newStatus)
		}
	}
}

// checkTimeouts evaluates if current state has timed out
func (p *Pane) checkTimeouts() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.status == StatusStopped || p.status == StatusError || p.status == StatusIdle {
		return
	}

	now := time.Now()
	timeSinceOutput := now.Sub(p.tracker.lastOutputTime)
	timeSinceInput := now.Sub(p.tracker.lastInputTime)
	timeSinceStateChange := now.Sub(p.tracker.stateChangedAt)

	oldStatus := p.status

	switch p.status {
	case StatusThinking:
		if timeSinceOutput > ThinkingTimeout {
			log.Printf("[Pane %s] Thinking timeout (%.1fs), transitioning to waiting_input",
				p.ID, timeSinceOutput.Seconds())
			p.status = StatusWaitingInput
			p.tracker.confidence = 0.6
		}

	case StatusExecuting:
		if timeSinceStateChange > ExecutingTimeout {
			log.Printf("[Pane %s] Executing timeout (%.1fs), transitioning to waiting_input",
				p.ID, timeSinceStateChange.Seconds())
			p.status = StatusWaitingInput
			p.tracker.confidence = 0.5
		}

	case StatusShell, StatusWaitingInput:
		if !p.tracker.lastInputTime.IsZero() &&
			timeSinceInput > InputToThinkingDelay &&
			timeSinceInput < 5*time.Second &&
			p.tracker.lastInputTime.After(p.tracker.lastOutputTime) {
			if p.tracker.claudeActive {
				p.status = StatusThinking
				p.tracker.confidence = 0.7
			}
		}
	}

	if p.status != oldStatus {
		p.tracker.stateChangedAt = now
		if p.onStatus != nil {
			status := p.status
			go p.onStatus(status)
		}
	}
}

// detectStatus analyzes output to determine pane state
func (p *Pane) detectStatus(data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	p.tracker.lastOutputTime = now

	// Update I/O rate tracking
	p.updateIORate(len(data), now)

	// Parse new data into lines and add to context buffer
	newLines := p.parseLines(string(data))
	p.addLinesToBuffer(newLines, now)

	// Hybrid detection: combine multiple signals
	oldStatus := p.status
	newStatus, confidence := p.analyzeState()

	// Only change state if confidence is high enough
	if newStatus != oldStatus {
		if confidence >= 0.6 || p.isStrongTransition(oldStatus, newStatus) {
			p.status = newStatus
			p.tracker.stateChangedAt = now
			p.tracker.confidence = confidence
			log.Printf("[Pane %s] State: %s -> %s (confidence: %.2f)",
				p.ID, oldStatus, newStatus, confidence)

			if p.onStatus != nil {
				go p.onStatus(newStatus)
			}
		}
	} else {
		p.tracker.confidence = confidence
	}
}

// updateIORate tracks output velocity
func (p *Pane) updateIORate(bytes int, now time.Time) {
	if now.Sub(p.tracker.outputWindowStart) > IOWindowDuration {
		p.tracker.outputRate = float64(p.tracker.outputBytes) / IOWindowDuration.Seconds()
		p.tracker.outputBytes = 0
		p.tracker.outputWindowStart = now
	}
	p.tracker.outputBytes += int64(bytes)
}

// parseLines splits data into individual lines with analysis
func (p *Pane) parseLines(data string) []LineEntry {
	rawLines := splitLines(data)
	entries := make([]LineEntry, 0, len(rawLines))

	for _, line := range rawLines {
		if len(trimSpace(line)) == 0 {
			continue
		}

		entry := LineEntry{
			Content:        line,
			Timestamp:      time.Now(),
			HasSpinner:     detectSpinner(line),
			HasToolPattern: detectToolPattern(line),
			HasClaudeUI:    detectClaudeUI(line),
			HasShellPrompt: detectShellPrompt(line),
		}
		entries = append(entries, entry)
	}
	return entries
}

// addLinesToBuffer adds lines to the circular buffer
func (p *Pane) addLinesToBuffer(lines []LineEntry, now time.Time) {
	for _, line := range lines {
		line.Timestamp = now
		p.tracker.lines = append(p.tracker.lines, line)
	}

	if len(p.tracker.lines) > p.tracker.maxLines {
		excess := len(p.tracker.lines) - p.tracker.maxLines
		p.tracker.lines = p.tracker.lines[excess:]
	}
}

// analyzeState performs hybrid state analysis
func (p *Pane) analyzeState() (Status, float64) {
	recentLines := p.getRecentLines(5)

	// Spinner = definitely thinking
	for _, line := range recentLines {
		if line.HasSpinner {
			p.tracker.claudeActive = true
			return StatusThinking, 0.95
		}
	}

	// Tool patterns = executing
	for _, line := range recentLines {
		if line.HasToolPattern {
			p.tracker.claudeActive = true
			return StatusExecuting, 0.90
		}
	}

	// Context analysis
	contextStatus, contextConf := p.analyzeContext()
	if contextConf >= 0.8 {
		return contextStatus, contextConf
	}

	// I/O behavior analysis
	ioStatus, ioConf := p.analyzeIOBehavior()
	if ioConf >= 0.7 {
		return ioStatus, ioConf
	}

	// Combine signals
	if contextConf >= 0.5 && ioConf >= 0.5 {
		if contextStatus == ioStatus {
			return contextStatus, (contextConf + ioConf) / 2
		}
	}

	if contextConf >= 0.5 {
		return contextStatus, contextConf
	}

	return p.status, 0.4
}

// getRecentLines returns the N most recent lines
func (p *Pane) getRecentLines(n int) []LineEntry {
	if len(p.tracker.lines) <= n {
		return p.tracker.lines
	}
	return p.tracker.lines[len(p.tracker.lines)-n:]
}

// analyzeContext looks at the full line buffer for patterns
func (p *Pane) analyzeContext() (Status, float64) {
	if len(p.tracker.lines) == 0 {
		if p.tracker.claudeActive {
			return StatusWaitingInput, 0.5
		}
		return StatusShell, 0.3
	}

	var spinnerCount, toolCount, claudeUICount, shellPromptCount int
	var lastClaudeUI, lastShellPrompt int = -1, -1

	for i, line := range p.tracker.lines {
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

	if spinnerCount > 0 {
		p.tracker.claudeActive = true
		return StatusThinking, 0.85
	}

	if toolCount > 0 {
		p.tracker.claudeActive = true
		return StatusExecuting, 0.80
	}

	// CRITICAL: If Claude is active, NEVER go back to shell state
	// Shell prompts inside Claude output (from Bash tool execution) are false positives
	if p.tracker.claudeActive {
		if claudeUICount > 0 {
			lastLine := p.tracker.lines[len(p.tracker.lines)-1]
			if looksLikeClaudePrompt(lastLine.Content) {
				return StatusWaitingInput, 0.85
			}
		}
		// Stay in waiting_input while Claude is active
		return StatusWaitingInput, 0.70
	}

	// Only reach here if claudeActive is false
	if claudeUICount > 0 && lastClaudeUI > lastShellPrompt {
		p.tracker.claudeActive = true
		lastLine := p.tracker.lines[len(p.tracker.lines)-1]
		if looksLikeClaudePrompt(lastLine.Content) {
			return StatusWaitingInput, 0.85
		}
		return StatusWaitingInput, 0.70
	}

	if shellPromptCount > 0 && lastShellPrompt > lastClaudeUI {
		return StatusShell, 0.80
	}

	return StatusShell, 0.50
}

// analyzeIOBehavior uses I/O patterns to infer state
func (p *Pane) analyzeIOBehavior() (Status, float64) {
	now := time.Now()
	timeSinceInput := now.Sub(p.tracker.lastInputTime)
	timeSinceOutput := now.Sub(p.tracker.lastOutputTime)

	if p.tracker.outputRate > 1000 {
		return StatusExecuting, 0.75
	}

	if !p.tracker.lastInputTime.IsZero() &&
		timeSinceInput < 10*time.Second &&
		p.tracker.lastInputTime.After(p.tracker.lastOutputTime) {
		if p.tracker.claudeActive {
			return StatusThinking, 0.65
		}
	}

	if timeSinceOutput > 5*time.Second && p.tracker.claudeActive {
		return StatusWaitingInput, 0.60
	}

	return p.status, 0.3
}

// isStrongTransition checks if state transition should override confidence threshold
func (p *Pane) isStrongTransition(from, to Status) bool {
	if from == StatusShell && (to == StatusThinking || to == StatusExecuting || to == StatusWaitingInput) {
		return true
	}
	if (from == StatusThinking || from == StatusExecuting) && to == StatusWaitingInput {
		return true
	}
	return false
}

// Helper functions for pattern detection (shared with session.go)
func splitLines(data string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			lines = append(lines, data[start:i])
			start = i + 1
		}
	}
	if start < len(data) {
		lines = append(lines, data[start:])
	}
	return lines
}

func trimSpace(s string) string {
	start := 0
	end := len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r' || s[end-1] == '\n') {
		end--
	}
	return s[start:end]
}

func detectSpinner(line string) bool {
	spinnerChars := "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
	for _, r := range spinnerChars {
		if containsRune(line, r) {
			return true
		}
	}
	return false
}

func detectToolPattern(line string) bool {
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

func detectClaudeUI(line string) bool {
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

func detectShellPrompt(line string) bool {
	line = trimSpace(line)
	if len(line) == 0 {
		return false
	}

	lastChar := line[len(line)-1]
	if lastChar == '$' || lastChar == '%' || lastChar == '#' {
		return true
	}

	if containsString(line, "❯") && !containsString(line, "Claude") {
		return true
	}

	if containsString(line, "@") && (containsString(line, ":") || containsString(line, "~")) {
		if !containsString(line, "Claude") && !containsString(line, "│") {
			return true
		}
	}

	return false
}

func looksLikeClaudePrompt(line string) bool {
	line = trimSpace(line)
	if len(line) >= 2 && line[len(line)-2:] == "> " {
		return true
	}
	if len(line) >= 1 && line[len(line)-1] == '>' {
		return true
	}
	if containsString(line, "> ") && containsString(line, "│") {
		return true
	}
	return false
}

// detectClaudeExit checks if Claude session has ended
func detectClaudeExit(line string) bool {
	exitPatterns := []string{
		"Session ended",
		"Goodbye!",
		"exited with code",
		"Session terminated",
	}
	for _, pattern := range exitPatterns {
		if containsString(line, pattern) {
			return true
		}
	}
	return false
}
