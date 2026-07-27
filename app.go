package main

import (
	"context"
)

// App is the Wails-bound application facade. Bound methods are callable from
// the frontend via the generated wailsjs bindings; long-running data streams
// are pushed with runtime.EventsEmit.
type App struct {
	ctx context.Context
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts; the context is used for event
// emission and dialog parenting.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}
