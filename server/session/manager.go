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
	Directory    string            `json:"directory"`
	ParentID     string            `json:"parent_id,omitempty"`
	WorktreePath string            `json:"worktree_path,omitempty"`
	Branch       string            `json:"branch,omitempty"`
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
		ID:           s.ID,
		Name:         s.Name,
		Status:       s.Status,
		Color:        s.Color,
		Position:     s.Position,
		Metadata:     s.Metadata,
		CreatedAt:    s.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		UpdatedAt:    s.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
		Directory:    s.Directory,
		ParentID:     s.ParentID,
		WorktreePath: s.WorktreePath,
		Branch:       s.Branch,
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

		session := &Session{
			ID:           info.ID,
			Name:         info.Name,
			Status:       StatusIdle, // Reset to idle on load (including error states)
			Color:        info.Color,
			Position:     info.Position,
			Metadata:     info.Metadata,
			Directory:    info.Directory,
			ParentID:     info.ParentID,
			WorktreePath: info.WorktreePath,
			Branch:       info.Branch,
			CreatedAt:    createdAt,
			UpdatedAt:    updatedAt,
			done:         make(chan struct{}),
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
