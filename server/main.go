package main

import (
	"log"
	"net/http"
	"os"

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

	// Static files (web frontend) - from filesystem for development
	http.Handle("/", http.FileServer(http.Dir("../web")))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Claudex server starting on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
