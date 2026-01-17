package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Manager handles multiple Claude Code sessions
type Manager struct {
	sessions   map[string]*Session
	mu         sync.RWMutex
	storageDir string
}

// SessionInfo is a serializable session representation
type SessionInfo struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Status       Status            `json:"status"`
	Color        string            `json:"color"`
	Position     *Position3D       `json:"position,omitempty"`
	Metadata     map[string]any    `json:"metadata,omitempty"`
	CreatedAt    string            `json:"created_at"`
	UpdatedAt    string            `json:"updated_at"`
	LastInputAt  string            `json:"last_input_at,omitempty"`
	Directory    string            `json:"directory"`
	ParentID     string            `json:"parent_id,omitempty"`
	WorktreePath   string            `json:"worktree_path,omitempty"`
	Branch         string            `json:"branch,omitempty"`
	RobotModel     string            `json:"robot_model,omitempty"`
	RobotColor     string            `json:"robot_color,omitempty"`
	RobotAccessory string            `json:"robot_accessory,omitempty"`
	HexQ           *int              `json:"hex_q,omitempty"`
	HexR           *int              `json:"hex_r,omitempty"`
}

// NewManager creates a new session manager
func NewManager(storageDir string) *Manager {
	// Ensure storage directory exists
	os.MkdirAll(storageDir, 0755)

	m := &Manager{
		sessions:   make(map[string]*Session),
		storageDir: storageDir,
	}

	// Load existing sessions from storage
	m.loadSessions()

	return m
}

// Create creates a new session
func (m *Manager) Create(name, directory string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	id := uuid.New().String()[:8] // Short ID for convenience
	session := NewSession(id, name, directory)
	m.sessions[id] = session

	// Save to disk
	m.saveSession(session)

	return session, nil
}

// Get retrieves a session by ID
func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, ok := m.sessions[id]
	return session, ok
}

// List returns all sessions
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	return list
}

// Delete removes a session
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[id]
	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}

	// Stop if running
	session.Stop()

	// Remove from map
	delete(m.sessions, id)

	// Remove from disk
	path := filepath.Join(m.storageDir, id+".json")
	os.Remove(path)

	// Remove scrollback file
	scrollbackPath := filepath.Join(m.storageDir, id+".scrollback")
	os.Remove(scrollbackPath)

	return nil
}

// saveSession persists a session to disk
func (m *Manager) saveSession(s *Session) error {
	info := SessionInfo{
		ID:             s.ID,
		Name:           s.Name,
		Status:         s.Status,
		Color:          s.Color,
		Position:       s.Position,
		Metadata:       s.Metadata,
		CreatedAt:      s.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		UpdatedAt:      s.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
		LastInputAt:    s.LastInputAt.Format("2006-01-02T15:04:05Z07:00"),
		Directory:      s.Directory,
		ParentID:       s.ParentID,
		WorktreePath:   s.WorktreePath,
		Branch:         s.Branch,
		RobotModel:     s.RobotModel,
		RobotColor:     s.RobotColor,
		RobotAccessory: s.RobotAccessory,
		HexQ:           s.HexQ,
		HexR:           s.HexR,
	}

	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}

	path := filepath.Join(m.storageDir, s.ID+".json")
	return os.WriteFile(path, data, 0644)
}

// loadSessions loads sessions from storage
func (m *Manager) loadSessions() {
	files, err := filepath.Glob(filepath.Join(m.storageDir, "*.json"))
	if err != nil {
		return
	}

	for _, file := range files {
		// Skip client-state.json
		if filepath.Base(file) == "client-state.json" {
			continue
		}

		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}

		var info SessionInfo
		if err := json.Unmarshal(data, &info); err != nil {
			continue
		}

		// Parse timestamps
		createdAt, _ := time.Parse("2006-01-02T15:04:05Z07:00", info.CreatedAt)
		updatedAt, _ := time.Parse("2006-01-02T15:04:05Z07:00", info.UpdatedAt)
		lastInputAt, _ := time.Parse("2006-01-02T15:04:05Z07:00", info.LastInputAt)

		session := &Session{
			ID:             info.ID,
			Name:           info.Name,
			Status:         StatusIdle, // Reset to idle on load (including error states)
			Color:          info.Color,
			Position:       info.Position,
			Metadata:       info.Metadata,
			Directory:      info.Directory,
			ParentID:       info.ParentID,
			WorktreePath:   info.WorktreePath,
			Branch:         info.Branch,
			RobotModel:     info.RobotModel,
			RobotColor:     info.RobotColor,
			RobotAccessory: info.RobotAccessory,
			HexQ:           info.HexQ,
			HexR:           info.HexR,
			CreatedAt:      createdAt,
			UpdatedAt:      updatedAt,
			LastInputAt:    lastInputAt,
			done:           make(chan struct{}),
			tracker:        newStateTracker(),
		}

		// Load scrollback if exists
		scrollbackPath := filepath.Join(m.storageDir, info.ID+".scrollback")
		if scrollbackData, err := os.ReadFile(scrollbackPath); err == nil {
			session.scrollback = scrollbackData
		}

		m.sessions[session.ID] = session
	}
}

// UpdateSession saves session state to disk
func (m *Manager) UpdateSession(s *Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.saveSession(s)
}

// SaveScrollback saves the scrollback buffer to disk
func (m *Manager) SaveScrollback(s *Session) error {
	scrollback := s.GetScrollback()
	if len(scrollback) == 0 {
		return nil
	}
	path := filepath.Join(m.storageDir, s.ID+".scrollback")
	return os.WriteFile(path, scrollback, 0644)
}

// GetStorageDir returns the storage directory path
func (m *Manager) GetStorageDir() string {
	return m.storageDir
}

// CreateExperiment creates a new session with a git worktree
func (m *Manager) CreateExperiment(parentID, branchName, worktreePath string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	parent, ok := m.sessions[parentID]
	if !ok {
		return nil, fmt.Errorf("parent session not found: %s", parentID)
	}

	// Create the session
	id := uuid.New().String()[:8]
	name := fmt.Sprintf("Exp: %s", branchName)

	session := &Session{
		ID:           id,
		Name:         name,
		Status:       StatusIdle,
		Color:        parent.Color, // Same color as parent
		Metadata:     make(map[string]any),
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
		Directory:    worktreePath,
		ParentID:     parentID,
		WorktreePath: worktreePath,
		Branch:       branchName,
		done:         make(chan struct{}),
		tracker:      newStateTracker(),
	}

	m.sessions[id] = session
	m.saveSession(session)

	return session, nil
}

// RemoveWorktree removes a git worktree when deleting an experiment
func (m *Manager) RemoveWorktree(s *Session) error {
	if s.WorktreePath == "" {
		return nil
	}
	// Will be called from handler after running git commands
	return nil
}

// ClientState represents the complete UI state for persistence
type ClientState struct {
	ActiveSession string         `json:"activeSession,omitempty"`
	SessionOrder  []string       `json:"sessionOrder,omitempty"`
	Theme         string         `json:"theme,omitempty"`
	View3D        bool           `json:"view3d"`
	Camera        *CameraState   `json:"camera,omitempty"`
	EmptyIslands  []HexPosition  `json:"emptyIslands,omitempty"` // Empty hex parcels (islands)
}

// HexPosition represents a hex grid coordinate
type HexPosition struct {
	Q int `json:"q"`
	R int `json:"r"`
}

// CameraState represents 3D camera position
type CameraState struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Z       float64 `json:"z"`
	TargetX float64 `json:"targetX"`
	TargetY float64 `json:"targetY"`
	TargetZ float64 `json:"targetZ"`
}

// GetClientState loads the client state from disk
func (m *Manager) GetClientState() (*ClientState, error) {
	path := filepath.Join(m.storageDir, "client-state.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Return default state
			return &ClientState{
				Theme:  "light",
				View3D: true,
			}, nil
		}
		return nil, err
	}

	var state ClientState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

// SaveClientState persists the client state to disk
func (m *Manager) SaveClientState(state *ClientState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	path := filepath.Join(m.storageDir, "client-state.json")
	return os.WriteFile(path, data, 0644)
}

// UpdateAllSessionCwds updates the cwd for all running sessions
func (m *Manager) UpdateAllSessionCwds() {
	m.mu.RLock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.RUnlock()

	for _, s := range sessions {
		if s.UpdateCwd() {
			m.mu.Lock()
			m.saveSession(s)
			m.mu.Unlock()
		}
	}
}

// SaveAllSessions saves all session states (called on shutdown)
func (m *Manager) SaveAllSessions() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, s := range m.sessions {
		// Update cwd if process is running
		s.UpdateCwd()
		// Save session and scrollback
		m.saveSession(s)
		scrollback := s.GetScrollback()
		if len(scrollback) > 0 {
			path := filepath.Join(m.storageDir, s.ID+".scrollback")
			os.WriteFile(path, scrollback, 0644)
		}
	}
}
