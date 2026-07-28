package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"anyremote/internal/sshx"
	"anyremote/internal/store"
	"anyremote/internal/vncbridge"
)

// App is the Wails-bound application facade. Bound methods (see bindings.go)
// are callable from the frontend via window.go.main.App.*; long-running data
// streams are pushed with runtime.EventsEmit.
type App struct {
	ctx context.Context

	// ssh owns every live SSH session (shell + SFTP share its connections).
	ssh *sshx.Manager

	// connections persists saved connections; secrets live in the OS keychain.
	connections *store.Store

	bridgesMu sync.Mutex
	// bridges holds the live VNC WebSocket bridges by bridge id.
	bridges map[string]*vncbridge.Bridge
	// bridgeSeq numbers bridge ids ("bridge-N"), like the Electron main process.
	bridgeSeq int
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{
		ssh:         sshx.NewManager(),
		connections: newConnectionStore(),
		bridges:     make(map[string]*vncbridge.Bridge),
	}
}

// newConnectionStore opens the saved-connection store at the default per-user
// config location (os.UserConfigDir()/AnyRemote/connections.json); secrets go
// to the OS keychain via the keyring-backed SecretStore. When the config dir
// cannot be resolved ($HOME or platform equivalent unset) the store falls
// back to the temp dir so the app stays usable for the session.
func newConnectionStore() *store.Store {
	configDir, err := os.UserConfigDir()
	if err != nil {
		configDir = os.TempDir()
	}
	return store.New(filepath.Join(configDir, "AnyRemote"), store.KeyringSecrets())
}

// startup is called when the app starts; the context is used for event
// emission and dialog parenting.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown releases every SSH session and VNC bridge (registered as
// OnShutdown in main.go), mirroring the Electron before-quit cleanup.
func (a *App) shutdown(_ context.Context) {
	a.ssh.CloseAll()
	a.bridgesMu.Lock()
	bridges := make([]*vncbridge.Bridge, 0, len(a.bridges))
	for id, bridge := range a.bridges {
		bridges = append(bridges, bridge)
		delete(a.bridges, id)
	}
	a.bridgesMu.Unlock()
	for _, bridge := range bridges {
		_ = bridge.Close()
	}
}

// nextBridgeID returns the next sequential bridge id ("bridge-N").
func (a *App) nextBridgeID() string {
	a.bridgeSeq++
	return fmt.Sprintf("bridge-%d", a.bridgeSeq)
}
