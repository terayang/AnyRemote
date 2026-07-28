package main

import (
	"context"
	"fmt"
	"sync"

	"anyremote/internal/sshx"
	"anyremote/internal/vncbridge"
)

// App is the Wails-bound application facade. Bound methods (see bindings.go)
// are callable from the frontend via window.go.main.App.*; long-running data
// streams are pushed with runtime.EventsEmit.
type App struct {
	ctx context.Context

	// ssh owns every live SSH session (shell + SFTP share its connections).
	ssh *sshx.Manager

	bridgesMu sync.Mutex
	// bridges holds the live VNC WebSocket bridges by bridge id.
	bridges map[string]*vncbridge.Bridge
	// bridgeSeq numbers bridge ids ("bridge-N"), like the Electron main process.
	bridgeSeq int
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{
		ssh:     sshx.NewManager(),
		bridges: make(map[string]*vncbridge.Bridge),
	}
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
