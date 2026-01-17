package session

import (
	"sync"
	"time"
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
	lastInputTime     time.Time   // When user last sent input
	lastOutputTime    time.Time   // When we last received output
	stateChangedAt    time.Time   // When state last changed
	confidence        float64     // Confidence in current state (0.0 - 1.0)
	outputBytes       int64       // Bytes received in current window
	outputWindowStart time.Time   // Start of measurement window
	outputRate        float64     // Bytes per second
	lines             []LineEntry // Circular buffer of recent lines
	maxLines          int         // Max lines to keep (default 50)
	claudeActive      bool        // Whether we think Claude is running
	claudeStartedAt   time.Time   // When Claude was detected as started
}

// LineEntry represents a line with its timestamp
type LineEntry struct {
	Content        string
	Timestamp      time.Time
	HasSpinner     bool
	HasToolPattern bool
	HasClaudeUI    bool
	HasShellPrompt bool
}

// Timeout configuration
const (
	ThinkingTimeout      = 60 * time.Second         // Max time in thinking before assuming waiting
	ExecutingTimeout     = 5 * time.Minute          // Max time executing a tool
	NoOutputTimeout      = 30 * time.Second         // No output = probably waiting for input
	InputToThinkingDelay = 500 * time.Millisecond   // After input, wait before assuming thinking
	IOWindowDuration     = 2 * time.Second          // Window for I/O rate calculation
)

// Position3D represents coordinates in the 3D hex world
type Position3D struct {
	Q     int     `json:"q"`
	R     int     `json:"r"`
	Layer float64 `json:"layer"`
}

// PaneLayout represents the layout of panes within a session
type PaneLayout struct {
	ID        string       `json:"id"`
	Direction string       `json:"direction,omitempty"` // "horizontal" or "vertical"
	Size      float64      `json:"size,omitempty"`      // Size percentage (0-100)
	Children  []PaneLayout `json:"children,omitempty"`  // For splits
	PaneID    string       `json:"pane_id,omitempty"`   // For leaf nodes
}

// Session represents a Claude Code terminal session
type Session struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Status       Status            `json:"status"`
	Color        string            `json:"color"`
	Position     *Position3D       `json:"position,omitempty"`
	Metadata     map[string]any    `json:"metadata,omitempty"`
	CreatedAt    time.Time         `json:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at"`
	LastInputAt  time.Time         `json:"last_input_at,omitempty"`
	Directory    string            `json:"directory"`
	ParentID     string            `json:"parent_id,omitempty"`
	WorktreePath string            `json:"worktree_path,omitempty"`
	Branch       string            `json:"branch,omitempty"`

	// Robot customization
	RobotModel     string `json:"robot_model,omitempty"`
	RobotColor     string `json:"robot_color,omitempty"`
	RobotAccessory string `json:"robot_accessory,omitempty"`

	// Hex grid position
	HexQ *int `json:"hex_q,omitempty"`
	HexR *int `json:"hex_r,omitempty"`

	// Claude Code session tracking
	LastClaudeSessionID string `json:"last_claude_session_id,omitempty"`

	// Multi-pane support
	PaneLayout *PaneLayout `json:"pane_layout,omitempty"`

	// Internal fields (not serialized)
	panes          map[string]*Pane
	mu             sync.RWMutex
	onStatusChange func(Status)
}

// NewSession creates a new session with default values
func NewSession(id, name, directory string) *Session {
	now := time.Now()
	return &Session{
		ID:        id,
		Name:      name,
		Status:    StatusIdle,
		Color:     "#6366f1",
		Metadata:  make(map[string]any),
		CreatedAt: now,
		UpdatedAt: now,
		Directory: directory,
		panes:     make(map[string]*Pane),
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

// CreatePane creates a new pane in this session
func (s *Session) CreatePane(paneID string) *Pane {
	s.mu.Lock()
	defer s.mu.Unlock()

	pane := NewPane(paneID, s.Directory)
	s.panes[paneID] = pane

	// Update layout
	if s.PaneLayout == nil {
		s.PaneLayout = &PaneLayout{
			ID:     "root",
			PaneID: paneID,
			Size:   100,
		}
	}

	s.UpdatedAt = time.Now()
	return pane
}

// GetPane returns a pane by ID
func (s *Session) GetPane(paneID string) *Pane {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.panes[paneID]
}

// GetPanes returns all panes
func (s *Session) GetPanes() map[string]*Pane {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]*Pane)
	for k, v := range s.panes {
		result[k] = v
	}
	return result
}

// GetMainPane returns the first/main pane (for backward compatibility)
func (s *Session) GetMainPane() *Pane {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.PaneLayout != nil && s.PaneLayout.PaneID != "" {
		return s.panes[s.PaneLayout.PaneID]
	}
	// Return any pane if layout doesn't specify
	for _, pane := range s.panes {
		return pane
	}
	return nil
}

// GetPaneCount returns the number of panes
func (s *Session) GetPaneCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.panes)
}

// RemovePane removes a pane from the session
func (s *Session) RemovePane(paneID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	pane, ok := s.panes[paneID]
	if !ok {
		return false
	}

	pane.Stop()
	delete(s.panes, paneID)
	s.removePaneFromLayout(paneID)
	s.UpdatedAt = time.Now()
	return true
}

// removePaneFromLayout removes a pane from the layout tree
func (s *Session) removePaneFromLayout(paneID string) {
	if s.PaneLayout == nil {
		return
	}

	if s.PaneLayout.PaneID == paneID {
		s.PaneLayout = nil
		return
	}

	s.PaneLayout = s.removePaneFromLayoutNode(s.PaneLayout, paneID)
}

func (s *Session) removePaneFromLayoutNode(node *PaneLayout, paneID string) *PaneLayout {
	if node == nil {
		return nil
	}

	var newChildren []PaneLayout
	for _, child := range node.Children {
		if child.PaneID == paneID {
			continue
		}
		updated := s.removePaneFromLayoutNode(&child, paneID)
		if updated != nil {
			newChildren = append(newChildren, *updated)
		}
	}

	if len(newChildren) == 1 {
		return &newChildren[0]
	}

	node.Children = newChildren
	return node
}

// SplitPane splits an existing pane into two
func (s *Session) SplitPane(paneID, newPaneID, direction string) *Pane {
	s.mu.Lock()
	defer s.mu.Unlock()

	newPane := NewPane(newPaneID, s.Directory)
	s.panes[newPaneID] = newPane
	s.splitPaneInLayout(paneID, newPaneID, direction)
	s.UpdatedAt = time.Now()
	return newPane
}

func (s *Session) splitPaneInLayout(paneID, newPaneID, direction string) {
	if s.PaneLayout == nil {
		return
	}
	s.PaneLayout = s.splitPaneInLayoutNode(s.PaneLayout, paneID, newPaneID, direction)
}

func (s *Session) splitPaneInLayoutNode(node *PaneLayout, paneID, newPaneID, direction string) *PaneLayout {
	if node == nil {
		return nil
	}

	if node.PaneID == paneID {
		return &PaneLayout{
			ID:        node.ID,
			Direction: direction,
			Children: []PaneLayout{
				{PaneID: paneID, Size: 50},
				{PaneID: newPaneID, Size: 50},
			},
		}
	}

	for i, child := range node.Children {
		node.Children[i] = *s.splitPaneInLayoutNode(&child, paneID, newPaneID, direction)
	}

	return node
}

// Start launches a shell in the main pane (backward compatibility)
func (s *Session) Start(rows, cols uint16, onOutput func([]byte)) error {
	// Create main pane if it doesn't exist
	pane := s.GetMainPane()
	if pane == nil {
		pane = s.CreatePane("main")
	}

	onStatus := func(status Status) {
		s.mu.Lock()
		s.Status = status
		s.UpdatedAt = time.Now()
		cb := s.onStatusChange
		s.mu.Unlock()
		if cb != nil {
			cb(status)
		}
	}

	err := pane.Start(rows, cols, onOutput, onStatus)
	if err == nil {
		s.mu.Lock()
		s.Status = StatusShell
		s.UpdatedAt = time.Now()
		s.mu.Unlock()
	}
	return err
}

// Resume resumes a previous Claude Code session (backward compatibility)
func (s *Session) Resume(claudeSessionID string, rows, cols uint16, onOutput func([]byte)) error {
	pane := s.GetMainPane()
	if pane == nil {
		pane = s.CreatePane("main")
	}

	onStatus := func(status Status) {
		s.mu.Lock()
		s.Status = status
		s.UpdatedAt = time.Now()
		cb := s.onStatusChange
		s.mu.Unlock()
		if cb != nil {
			cb(status)
		}
	}

	s.mu.Lock()
	s.LastClaudeSessionID = claudeSessionID
	s.mu.Unlock()

	err := pane.Resume(claudeSessionID, rows, cols, onOutput, onStatus)
	if err == nil {
		s.mu.Lock()
		s.Status = StatusWaitingInput
		s.UpdatedAt = time.Now()
		s.mu.Unlock()
	}
	return err
}

// Write sends input to the main pane (backward compatibility)
func (s *Session) Write(data []byte) (int, error) {
	pane := s.GetMainPane()
	if pane == nil {
		return 0, nil
	}
	s.SetLastInputAt(time.Now())
	return pane.Write(data)
}

// Resize changes the terminal size of the main pane (backward compatibility)
func (s *Session) Resize(rows, cols uint16) error {
	pane := s.GetMainPane()
	if pane == nil {
		return nil
	}
	return pane.Resize(rows, cols)
}

// Stop terminates all panes in the session
func (s *Session) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, pane := range s.panes {
		pane.Stop()
	}

	s.Status = StatusStopped
	s.UpdatedAt = time.Now()
	return nil
}

// Reset prepares the session for restart
func (s *Session) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, pane := range s.panes {
		pane.Stop()
	}

	s.panes = make(map[string]*Pane)
	s.PaneLayout = nil
	s.Status = StatusIdle
	s.UpdatedAt = time.Now()
}

// SetLastClaudeSessionID updates the Claude session ID
func (s *Session) SetLastClaudeSessionID(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastClaudeSessionID = sessionID
	s.UpdatedAt = time.Now()
}

// GetLastClaudeSessionID returns the stored Claude session ID
func (s *Session) GetLastClaudeSessionID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.LastClaudeSessionID
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

// SetPosition updates the 3D position
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

// GetScrollback returns the terminal scrollback buffer from main pane
func (s *Session) GetScrollback() []byte {
	pane := s.GetMainPane()
	if pane == nil {
		return nil
	}
	return pane.GetScrollback()
}

// GetProcessCwd returns the current working directory of the shell process
func (s *Session) GetProcessCwd() (string, error) {
	pane := s.GetMainPane()
	if pane == nil {
		return s.Directory, nil
	}
	return pane.GetProcessCwd()
}

// UpdateCwd updates the Directory field with the current process cwd
func (s *Session) UpdateCwd() bool {
	cwd, err := s.GetProcessCwd()
	if err != nil {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if cwd != s.Directory {
		s.Directory = cwd
		s.UpdatedAt = time.Now()
		return true
	}
	return false
}

// Helper functions
func findLastValidUTF8(data []byte) int {
	n := len(data)
	if n == 0 {
		return 0
	}

	for i := 1; i <= 3 && i <= n; i++ {
		b := data[n-i]
		if b&0x80 == 0 {
			return n
		}
		if b&0xC0 == 0xC0 {
			expectedLen := 0
			if b&0xE0 == 0xC0 {
				expectedLen = 2
			} else if b&0xF0 == 0xE0 {
				expectedLen = 3
			} else if b&0xF8 == 0xF0 {
				expectedLen = 4
			}
			if i < expectedLen {
				return n - i
			}
			return n
		}
	}
	return n
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

// StartPane starts a specific pane
func (s *Session) StartPane(paneID string, rows, cols uint16, onOutput func([]byte), onStatus func(Status)) error {
	pane := s.GetPane(paneID)
	if pane == nil {
		pane = s.CreatePane(paneID)
	}

	return pane.Start(rows, cols, onOutput, onStatus)
}

// WriteToPane sends input to a specific pane
func (s *Session) WriteToPane(paneID string, data []byte) (int, error) {
	pane := s.GetPane(paneID)
	if pane == nil {
		return 0, nil
	}
	return pane.Write(data)
}

// ResizePane changes the terminal size of a specific pane
func (s *Session) ResizePane(paneID string, rows, cols uint16) error {
	pane := s.GetPane(paneID)
	if pane == nil {
		return nil
	}
	return pane.Resize(rows, cols)
}

// GetPaneScrollback returns the scrollback buffer for a specific pane
func (s *Session) GetPaneScrollback(paneID string) []byte {
	pane := s.GetPane(paneID)
	if pane == nil {
		return nil
	}
	return pane.GetScrollback()
}

// UpdateSessionStatus updates the session's overall status based on pane statuses
func (s *Session) UpdateSessionStatus() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.panes) == 0 {
		s.Status = StatusIdle
		return
	}

	// Use the "most active" status
	highestPriority := StatusIdle
	priorities := map[Status]int{
		StatusIdle:         0,
		StatusStopped:      1,
		StatusShell:        2,
		StatusWaitingInput: 3,
		StatusExecuting:    4,
		StatusThinking:     5,
		StatusError:        6,
	}

	for _, pane := range s.panes {
		paneStatus := pane.GetStatus()
		if priorities[paneStatus] > priorities[highestPriority] {
			highestPriority = paneStatus
		}
	}

	s.Status = highestPriority
	s.UpdatedAt = time.Now()
}

// GetLayoutJSON returns the pane layout as JSON-serializable structure
func (s *Session) GetLayoutJSON() *PaneLayout {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.PaneLayout
}

// SetLayoutFromJSON sets the pane layout from JSON
func (s *Session) SetLayoutFromJSON(layout *PaneLayout) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.PaneLayout = layout
	s.UpdatedAt = time.Now()
}
