# Claudex

Gestor de múltiples sesiones de Claude Code. Permite ejecutar y monitorear varias instancias de Claude Code desde una interfaz web.

## Arquitectura

```
claudex/
├── server/              # Backend Go
│   ├── main.go          # Punto de entrada, servidor HTTP
│   ├── session/
│   │   ├── session.go   # Sesión PTY con Claude Code
│   │   └── manager.go   # Gestión de múltiples sesiones
│   └── ws/
│       └── handler.go   # WebSocket para comunicación en tiempo real
├── web/                 # Frontend
│   ├── index.html
│   ├── css/style.css    # Estilos con tema claro/oscuro
│   └── js/app.js        # xterm.js + WebSocket client
└── sessions/            # Persistencia de sesiones (JSON)
```

## Tecnologías

- **Backend**: Go con gorilla/websocket y creack/pty
- **Frontend**: Vanilla JS con xterm.js
- **Comunicación**: WebSocket con datos en Base64 para UTF-8 correcto

## Funcionalidades implementadas

- [x] Crear sesiones de Claude Code con nombre y directorio
- [x] Terminal web completa (xterm.js) con soporte UTF-8
- [x] Teclas especiales funcionan (Escape, Ctrl+C, flechas, etc.)
- [x] Estados de sesión: idle, thinking, executing, waiting_input, stopped
- [x] Indicador visual de estado en tarjetas (borde coloreado)
- [x] Tema claro/oscuro (toggle + persistencia en localStorage)
- [x] Terminal con tema claro/oscuro
- [x] Historial de terminal preservado al cerrar/abrir modal
- [x] Notificaciones cuando una sesión termina de procesar
- [x] Persistencia de sesiones en archivos JSON
- [x] Soporte para `~` en rutas de directorio

## Ejecutar

```bash
cd server
go build -o claudex .
./claudex
```

Abrir http://localhost:8080

## Modelo de datos

```go
type Session struct {
    ID        string
    Name      string
    Status    Status            // idle, thinking, executing, waiting_input, stopped
    Color     string            // Color hex para UI (preparado para Fase 2)
    Position  *Position3D       // Coordenadas 3D (preparado para Fase 2)
    Metadata  map[string]any    // Extensible
    Directory string            // Directorio de trabajo
}

type Position3D struct {
    Q     int     // Coordenada hexagonal Q
    R     int     // Coordenada hexagonal R
    Layer float64 // Capa vertical
}
```

## API WebSocket

Mensajes del cliente al servidor:
- `subscribe`: Suscribirse a output de una sesión
- `unsubscribe`: Desuscribirse
- `start`: Iniciar Claude Code en una sesión
- `stop`: Detener sesión
- `input`: Enviar input al terminal
- `resize`: Cambiar tamaño del terminal

Mensajes del servidor al cliente:
- `output`: Datos del terminal (Base64)
- `status`: Cambio de estado de sesión

## API REST

- `GET /api/sessions` - Lista de sesiones
- `POST /api/sessions/create` - Crear sesión `{name, directory}`

## Fase 2 (pendiente)

Mundo virtual 3D con rejilla de hexágonos:
- Navegación 3D por el espacio de sesiones
- Cada hexágono es una sesión
- Colores personalizables por sesión
- Visualización espacial del estado de múltiples sesiones

## Preparado para remoto (futuro)

La arquitectura está preparada para conexión remota:
- El backend podría conectarse a máquinas remotas vía SSH
- El modelo Session tiene campos extensibles para metadatos de conexión
