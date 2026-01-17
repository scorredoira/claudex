<p align="center">
  <img src="docs/images/claudex-icon.svg" width="80" height="80" alt="Claudex">
</p>

<h1 align="center">Claudex</h1>

<p align="center">
  A multi-session manager for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> with an interactive 3D visualization.<br>
  Run and monitor multiple Claude Code instances from a single web interface.
</p>

![Claudex 3D World](docs/images/world-3d.png)

## Features

### Session Management
- **Multiple Sessions**: Run several Claude Code instances simultaneously
- **Auto-Resume**: Automatically resumes your last Claude Code session when opening a robot (sessions < 24h)
- **Session Experiments**: Fork any session to create experimental branches
- **Fullscreen Terminal**: Sessions open in fullscreen with complete xterm.js terminal
- **State Persistence**: Sessions, camera position, and UI preferences are saved server-side

### 3D World
- **Interactive Environment**: Navigate your sessions in a 3D world with cute robots on hexagonal tiles
- **Robot Customization**: Personalize each robot with different models, colors, and accessories
- **Living World**: Grass details with flowers, tufts, and small rocks; animated clouds
- **Separate Islands**: Create disconnected hex islands by double-clicking on empty space
- **Real-time Status**: Visual indicators show what each session is doing (idle, thinking, executing, waiting for input)

### Claude Code Integration
- **Claude State Detection**: Reads Claude Code JSONL transcripts to show current tool, model, and token usage in tooltips
- **Multiline Input**: Shift+Enter inserts newlines without executing (like native Claude Code)
- **Desktop Notifications**: Get notified when a session needs your attention

### UI
- **Light/Dark Theme**: Toggle between themes with persistent preference
- **Two Views**: 3D World or traditional Cards grid layout

![Terminal Session](docs/images/terminal-session.png)

## Quick Start

### Prerequisites

- Go 1.21+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and configured

### Run

```bash
cd server
go build -o claudex .
./claudex
```

Open http://localhost:9090

## Keyboard Shortcuts

### 3D View
| Shortcut | Action |
|----------|--------|
| **Click** on robot/tile | Open session |
| **Right-click** on robot/tile | Show action menu (experiment, customize, restart, delete) |
| **Click** on empty tile | Create new session |
| **Double-click** on empty space | Create new island |
| **Space** | Center camera on sessions |
| **Cmd/Ctrl** (hold) | Show session labels on tiles |

### Terminal
| Shortcut | Action |
|----------|--------|
| **Shift+Enter** | Insert newline (multiline input) |
| **Shift+Escape** | Close session |

## Architecture

```
claudex/
├── server/              # Go backend
│   ├── main.go          # HTTP server entry point
│   ├── claude/
│   │   └── transcript.go # Claude Code JSONL transcript reader
│   ├── session/
│   │   ├── session.go   # PTY session with Claude Code
│   │   └── manager.go   # Multi-session management
│   └── ws/
│       └── handler.go   # WebSocket for real-time communication
├── web/                 # Frontend
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js       # Main application logic
│       └── world3d.js   # Three.js 3D world
└── sessions/            # Session persistence (JSON)
```

## Technology Stack

- **Backend**: Go with [gorilla/websocket](https://github.com/gorilla/websocket) and [creack/pty](https://github.com/creack/pty)
- **Frontend**: Vanilla JavaScript with [xterm.js](https://xtermjs.org/) and [Three.js](https://threejs.org/)
- **Communication**: WebSocket with Base64 encoding for proper UTF-8 handling

## API

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions/create` | Create new session |
| DELETE | `/api/sessions/{id}` | Delete session |
| PUT | `/api/sessions/{id}/name` | Rename session |
| PUT | `/api/sessions/{id}/customize` | Update robot customization |
| POST | `/api/sessions/{id}/experiment` | Create experiment fork |
| GET | `/api/sessions/{id}/claude-state` | Get Claude Code state |
| GET | `/api/sessions/{id}/claude-session` | Check for resumable Claude session |
| GET | `/api/client-state` | Get UI state (camera, theme, etc.) |
| PUT | `/api/client-state` | Save UI state |

### WebSocket Messages

**Client → Server:**
- `subscribe` / `unsubscribe`: Session output subscription
- `start` / `stop`: Control Claude Code process
- `input`: Send terminal input
- `resize`: Update terminal dimensions

**Server → Client:**
- `output`: Terminal data (Base64)
- `status`: Session state changes

## License

MIT
