package ws

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// WorktreeInfo contains information about the current worktree
type WorktreeInfo struct {
	IsWorktree bool   `json:"is_worktree"`
	Branch     string `json:"branch,omitempty"`
	MainRepo   string `json:"main_repo,omitempty"`
	Path       string `json:"path,omitempty"`
}

// HandleWorktree handles worktree info and operations
func (h *Handler) HandleWorktree(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		h.getWorktreeInfo(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleWorktreeMerge merges the current worktree branch into master
func (h *Handler) HandleWorktreeMerge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	info := getWorktreeInfo()
	if !info.IsWorktree {
		http.Error(w, "Not in a worktree", http.StatusBadRequest)
		return
	}

	// Get the worktree path (current working directory of the web files)
	worktreePath := info.Path

	// First, commit any pending changes
	cmd := exec.Command("git", "add", "-A")
	cmd.Dir = worktreePath
	cmd.Run() // Ignore error if nothing to add

	cmd = exec.Command("git", "diff", "--cached", "--quiet")
	cmd.Dir = worktreePath
	if cmd.Run() != nil {
		// There are staged changes, commit them
		cmd = exec.Command("git", "commit", "-m", "WIP: Auto-commit before merge")
		cmd.Dir = worktreePath
		if out, err := cmd.CombinedOutput(); err != nil {
			http.Error(w, "Failed to commit changes: "+string(out), http.StatusInternalServerError)
			return
		}
	}

	// Go to main repo and merge
	mainRepo := info.MainRepo
	branch := info.Branch

	// Checkout master in main repo
	cmd = exec.Command("git", "checkout", "master")
	cmd.Dir = mainRepo
	if out, err := cmd.CombinedOutput(); err != nil {
		http.Error(w, "Failed to checkout master: "+string(out), http.StatusInternalServerError)
		return
	}

	// Merge the worktree branch
	cmd = exec.Command("git", "merge", branch, "--no-edit")
	cmd.Dir = mainRepo
	if out, err := cmd.CombinedOutput(); err != nil {
		http.Error(w, "Failed to merge: "+string(out), http.StatusInternalServerError)
		return
	}

	// Remove the worktree
	cmd = exec.Command("git", "worktree", "remove", worktreePath)
	cmd.Dir = mainRepo
	cmd.Run() // Best effort

	// Delete the branch
	cmd = exec.Command("git", "branch", "-d", branch)
	cmd.Dir = mainRepo
	cmd.Run() // Best effort

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "merged"})
}

// HandleWorktreeDiscard discards changes and removes the worktree
func (h *Handler) HandleWorktreeDiscard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	info := getWorktreeInfo()
	if !info.IsWorktree {
		http.Error(w, "Not in a worktree", http.StatusBadRequest)
		return
	}

	worktreePath := info.Path
	mainRepo := info.MainRepo
	branch := info.Branch

	// Force remove the worktree
	cmd := exec.Command("git", "worktree", "remove", "--force", worktreePath)
	cmd.Dir = mainRepo
	cmd.Run() // Best effort

	// Force delete the branch
	cmd = exec.Command("git", "branch", "-D", branch)
	cmd.Dir = mainRepo
	cmd.Run() // Best effort

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "discarded"})
}

func (h *Handler) getWorktreeInfo(w http.ResponseWriter, r *http.Request) {
	info := getWorktreeInfo()
	json.NewEncoder(w).Encode(info)
}

func getWorktreeInfo() WorktreeInfo {
	// Get current working directory (where the server was started)
	cwd, err := os.Getwd()
	if err != nil {
		return WorktreeInfo{IsWorktree: false}
	}

	// Find .git in parent directories
	gitPath := findGitPath(cwd)
	if gitPath == "" {
		return WorktreeInfo{IsWorktree: false}
	}

	// Check if .git is a file (worktree) or directory (main repo)
	gitInfo, err := os.Stat(gitPath)
	if err != nil {
		return WorktreeInfo{IsWorktree: false}
	}

	if gitInfo.IsDir() {
		// Main repo, not a worktree
		return WorktreeInfo{IsWorktree: false}
	}

	// It's a file, read it to get the main repo path
	content, err := os.ReadFile(gitPath)
	if err != nil {
		return WorktreeInfo{IsWorktree: false}
	}

	// Format: "gitdir: /path/to/.git/worktrees/branch-name"
	line := strings.TrimSpace(string(content))
	if !strings.HasPrefix(line, "gitdir: ") {
		return WorktreeInfo{IsWorktree: false}
	}

	gitDir := strings.TrimPrefix(line, "gitdir: ")
	// Extract main repo: go up from .git/worktrees/xxx to .git, then parent
	parts := strings.Split(gitDir, string(filepath.Separator))
	var mainGitIdx int
	for i, p := range parts {
		if p == ".git" {
			mainGitIdx = i
			break
		}
	}
	mainRepo := strings.Join(parts[:mainGitIdx], string(filepath.Separator))
	if mainRepo == "" {
		mainRepo = "/"
	}

	// Get current branch
	cmd := exec.Command("git", "branch", "--show-current")
	cmd.Dir = cwd
	branchOut, err := cmd.Output()
	branch := strings.TrimSpace(string(branchOut))

	return WorktreeInfo{
		IsWorktree: true,
		Branch:     branch,
		MainRepo:   mainRepo,
		Path:       filepath.Dir(gitPath),
	}
}

func findGitPath(dir string) string {
	current := dir
	for {
		gitPath := filepath.Join(current, ".git")
		if _, err := os.Stat(gitPath); err == nil {
			return gitPath
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}
