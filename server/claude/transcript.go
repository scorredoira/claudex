package claude

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SessionIndex represents the sessions-index.json structure
type SessionIndex struct {
	Version int            `json:"version"`
	Entries []SessionEntry `json:"entries"`
}

// SessionEntry represents a session in the index
type SessionEntry struct {
	SessionID   string `json:"sessionId"`
	FullPath    string `json:"fullPath"`
	FileMtime   int64  `json:"fileMtime"`
	FirstPrompt string `json:"firstPrompt"`
	MessageCount int   `json:"messageCount"`
	Created     string `json:"created"`
	Modified    string `json:"modified"`
	GitBranch   string `json:"gitBranch"`
	ProjectPath string `json:"projectPath"`
	IsSidechain bool   `json:"isSidechain"`
}

// TranscriptLine represents a line in the JSONL transcript
type TranscriptLine struct {
	ParentUUID  string          `json:"parentUuid"`
	IsSidechain bool            `json:"isSidechain"`
	UserType    string          `json:"userType"`
	Cwd         string          `json:"cwd"`
	SessionID   string          `json:"sessionId"`
	Version     string          `json:"version"`
	GitBranch   string          `json:"gitBranch"`
	Slug        string          `json:"slug"`
	Type        string          `json:"type"` // "assistant" or "user"
	Message     TranscriptMsg   `json:"message"`
	UUID        string          `json:"uuid"`
	Timestamp   string          `json:"timestamp"`
	ToolResult  *ToolUseResult  `json:"toolUseResult,omitempty"`
}

// TranscriptMsg represents the message in a transcript line
type TranscriptMsg struct {
	Model      string         `json:"model"`
	ID         string         `json:"id"`
	Role       string         `json:"role"`
	Content    []ContentBlock `json:"content"`
	StopReason *string        `json:"stop_reason"`
	Usage      *TokenUsage    `json:"usage"`
}

// ContentBlock represents a content block (tool_use, tool_result, text, thinking)
type ContentBlock struct {
	Type      string          `json:"type"` // "tool_use", "tool_result", "text", "thinking"
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   string          `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
	Text      string          `json:"text,omitempty"`
	Thinking  string          `json:"thinking,omitempty"`
}

// ToolUseResult contains the result of a tool execution
type ToolUseResult struct {
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	Interrupted bool   `json:"interrupted"`
	IsImage     bool   `json:"isImage"`
}

// TokenUsage represents token usage information
type TokenUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

// ClaudeState represents the current state of a Claude Code session
type ClaudeState struct {
	Status         string       `json:"status"` // "idle", "thinking", "executing", "waiting_input"
	CurrentTool    string       `json:"currentTool,omitempty"`
	ToolTarget     string       `json:"toolTarget,omitempty"`
	LastActivity   string       `json:"lastActivity,omitempty"`
	Cwd            string       `json:"cwd,omitempty"`
	GitBranch      string       `json:"gitBranch,omitempty"`
	Model          string       `json:"model,omitempty"`
	TokensUsed     int          `json:"tokensUsed,omitempty"`
	SessionID      string       `json:"sessionId,omitempty"`
	PendingTools   []ToolInfo   `json:"pendingTools,omitempty"`
	RecentTools    []ToolInfo   `json:"recentTools,omitempty"`
}

// ToolInfo represents info about a tool use
type ToolInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Target    string `json:"target,omitempty"`
	Status    string `json:"status"` // "running", "completed", "error"
	StartTime string `json:"startTime,omitempty"`
	EndTime   string `json:"endTime,omitempty"`
}

// GetClaudeProjectDir returns the encoded directory path for a given working directory
func GetClaudeProjectDir(workDir string) string {
	// Claude Code encodes paths by replacing / with -
	encoded := strings.ReplaceAll(workDir, "/", "-")
	homeDir, _ := os.UserHomeDir()
	return filepath.Join(homeDir, ".claude", "projects", encoded)
}

// FindActiveSession finds the most recently modified session for a directory
func FindActiveSession(workDir string) (*SessionEntry, error) {
	projectDir := GetClaudeProjectDir(workDir)
	indexPath := filepath.Join(projectDir, "sessions-index.json")

	data, err := os.ReadFile(indexPath)
	if err != nil {
		return nil, err
	}

	var index SessionIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return nil, err
	}

	if len(index.Entries) == 0 {
		return nil, nil
	}

	// Sort by modified time (most recent first)
	sort.Slice(index.Entries, func(i, j int) bool {
		return index.Entries[i].FileMtime > index.Entries[j].FileMtime
	})

	return &index.Entries[0], nil
}

// GetClaudeState reads the transcript and determines current state
func GetClaudeState(workDir string) (*ClaudeState, error) {
	session, err := FindActiveSession(workDir)
	if err != nil || session == nil {
		return &ClaudeState{Status: "idle"}, nil
	}

	// Read the JSONL file
	state, err := parseTranscript(session.FullPath)
	if err != nil {
		return &ClaudeState{Status: "idle"}, nil
	}

	state.SessionID = session.SessionID
	state.GitBranch = session.GitBranch

	return state, nil
}

// parseTranscript reads and parses a JSONL transcript file
func parseTranscript(path string) (*ClaudeState, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	state := &ClaudeState{
		Status:       "idle",
		PendingTools: []ToolInfo{},
		RecentTools:  []ToolInfo{},
	}

	// Track pending tool_use that haven't received results
	pendingTools := make(map[string]ToolInfo)
	var recentTools []ToolInfo
	var lastLine TranscriptLine
	var totalTokens int

	scanner := bufio.NewScanner(file)
	// Increase buffer size for large lines
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	for scanner.Scan() {
		var line TranscriptLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}

		lastLine = line

		// Update cwd and model from any line
		if line.Cwd != "" {
			state.Cwd = line.Cwd
		}
		if line.Message.Model != "" {
			state.Model = line.Message.Model
		}

		// Track token usage
		if line.Message.Usage != nil {
			totalTokens += line.Message.Usage.InputTokens + line.Message.Usage.OutputTokens
		}

		// Process content blocks
		for _, block := range line.Message.Content {
			switch block.Type {
			case "tool_use":
				target := extractToolTarget(block.Name, block.Input)
				toolInfo := ToolInfo{
					ID:        block.ID,
					Name:      block.Name,
					Target:    target,
					Status:    "running",
					StartTime: line.Timestamp,
				}
				pendingTools[block.ID] = toolInfo

			case "tool_result":
				if info, ok := pendingTools[block.ToolUseID]; ok {
					info.EndTime = line.Timestamp
					if block.IsError {
						info.Status = "error"
					} else {
						info.Status = "completed"
					}
					recentTools = append(recentTools, info)
					delete(pendingTools, block.ToolUseID)
				}
			}
		}
	}

	state.TokensUsed = totalTokens
	state.LastActivity = lastLine.Timestamp

	// Convert pending tools map to slice
	for _, tool := range pendingTools {
		state.PendingTools = append(state.PendingTools, tool)
	}

	// Keep only last 5 recent tools
	if len(recentTools) > 5 {
		recentTools = recentTools[len(recentTools)-5:]
	}
	state.RecentTools = recentTools

	// Determine status based on last line and pending tools
	if len(state.PendingTools) > 0 {
		state.Status = "executing"
		state.CurrentTool = state.PendingTools[0].Name
		state.ToolTarget = state.PendingTools[0].Target
	} else if lastLine.Type == "assistant" {
		// Check if last content was thinking
		for _, block := range lastLine.Message.Content {
			if block.Type == "thinking" {
				state.Status = "thinking"
				break
			}
		}
		if state.Status != "thinking" {
			// Check stop_reason
			if lastLine.Message.StopReason != nil && *lastLine.Message.StopReason == "end_turn" {
				state.Status = "waiting_input"
			} else {
				state.Status = "thinking"
			}
		}
	} else if lastLine.Type == "user" {
		// User sent input, Claude should be processing
		state.Status = "thinking"
	}

	// Check if session is stale (no activity in last 5 minutes)
	if state.LastActivity != "" {
		lastTime, err := time.Parse(time.RFC3339, state.LastActivity)
		if err == nil && time.Since(lastTime) > 5*time.Minute {
			state.Status = "idle"
		}
	}

	return state, nil
}

// extractToolTarget extracts a meaningful target from tool input
func extractToolTarget(toolName string, input json.RawMessage) string {
	var data map[string]interface{}
	if err := json.Unmarshal(input, &data); err != nil {
		return ""
	}

	switch toolName {
	case "Read", "Write", "Edit":
		if path, ok := data["file_path"].(string); ok {
			return filepath.Base(path)
		}
	case "Bash":
		if cmd, ok := data["command"].(string); ok {
			// Truncate long commands
			if len(cmd) > 50 {
				return cmd[:50] + "..."
			}
			return cmd
		}
	case "Glob":
		if pattern, ok := data["pattern"].(string); ok {
			return pattern
		}
	case "Grep":
		if pattern, ok := data["pattern"].(string); ok {
			return pattern
		}
	case "Task":
		if desc, ok := data["description"].(string); ok {
			return desc
		}
	case "WebFetch":
		if url, ok := data["url"].(string); ok {
			return url
		}
	}

	return ""
}
