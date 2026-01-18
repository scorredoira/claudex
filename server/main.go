package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"claudex/session"
	"claudex/ws"
)

type Config struct {
	Port int `json:"port"`
}

func loadConfig() Config {
	config := Config{Port: 9090} // defaults

	configPath := os.ExpandEnv("$HOME/.claudex/config.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return config
	}

	json.Unmarshal(data, &config)
	return config
}

func main() {
	config := loadConfig()

	// Session manager - use global path so sessions are shared across worktrees
	sessionsDir := os.ExpandEnv("$HOME/.claudex/sessions")
	manager := session.NewManager(sessionsDir)

	// WebSocket handler
	wsHandler := ws.NewHandler(manager)

	// Routes
	http.HandleFunc("/ws", wsHandler.HandleConnection)
	http.HandleFunc("/api/sessions", wsHandler.HandleSessions)
	http.HandleFunc("/api/sessions/create", wsHandler.HandleCreateSession)
	http.HandleFunc("/api/sessions/experiment", wsHandler.HandleCreateExperiment)
	http.HandleFunc("/api/sessions/", wsHandler.HandleSessionUpdate)
	http.HandleFunc("/api/client-state", wsHandler.HandleClientState)
	http.HandleFunc("/api/worktree", wsHandler.HandleWorktree)
	http.HandleFunc("/api/worktree/merge", wsHandler.HandleWorktreeMerge)
	http.HandleFunc("/api/worktree/discard", wsHandler.HandleWorktreeDiscard)

	// Static files (web frontend)
	webDir := os.ExpandEnv("$HOME/.claudex/web")
	http.Handle("/", http.FileServer(http.Dir(webDir)))

	port := os.Getenv("PORT")
	if port == "" {
		port = fmt.Sprintf("%d", config.Port)
	}

	// Handle shutdown gracefully - save all session states
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		log.Println("Shutting down, saving session states...")
		manager.SaveAllSessions()
		os.Exit(0)
	}()

	log.Printf("Claudex server starting on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
