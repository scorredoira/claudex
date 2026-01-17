package main

import (
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"claudex/session"
	"claudex/ws"
)

func main() {
	// Session manager
	manager := session.NewManager("../sessions")

	// WebSocket handler
	wsHandler := ws.NewHandler(manager)

	// Routes
	http.HandleFunc("/ws", wsHandler.HandleConnection)
	http.HandleFunc("/api/sessions", wsHandler.HandleSessions)
	http.HandleFunc("/api/sessions/create", wsHandler.HandleCreateSession)
	http.HandleFunc("/api/sessions/experiment", wsHandler.HandleCreateExperiment)
	http.HandleFunc("/api/sessions/", wsHandler.HandleSessionUpdate)
	http.HandleFunc("/api/client-state", wsHandler.HandleClientState)

	// Static files (web frontend) - from filesystem for development
	http.Handle("/", http.FileServer(http.Dir("../web")))

	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
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
