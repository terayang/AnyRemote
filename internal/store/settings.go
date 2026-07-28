// Secret-storage settings: which SecretStore backend holds the saved
// connections' secrets — the OS keychain (default) or the encrypted local
// file (FileSecrets, obfuscation grade). The choice persists in
// <dataDir>/settings.json and MigrateSecrets (store.go) moves existing
// secrets between backends when it changes.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// SecretBackend names a secret-storage mode as persisted in settings.json
// and exposed over the Wails bridge (GetSecretStorage / SetSecretStorage).
type SecretBackend string

const (
	// SecretBackendKeychain: secrets live in the OS keychain (default).
	SecretBackendKeychain SecretBackend = "keychain"
	// SecretBackendLocalFile: secrets live encrypted in <dataDir>/secrets.json
	// (see secrets_file.go for the security semantics).
	SecretBackendLocalFile SecretBackend = "localFile"
)

// ValidSecretBackend reports whether mode is a known secret-storage mode.
func ValidSecretBackend(mode SecretBackend) bool {
	return mode == SecretBackendKeychain || mode == SecretBackendLocalFile
}

// settingsFile mirrors the persisted <dataDir>/settings.json document.
type settingsFile struct {
	SecretStorage string `json:"secretStorage"`
}

func settingsPath(dataDir string) string { return filepath.Join(dataDir, "settings.json") }

// LoadSecretBackend reads settings.json; a missing or unreadable file (or an
// unknown persisted value, e.g. written by a newer build) falls back to the
// keychain default so the app always starts on a usable backend.
func LoadSecretBackend(dataDir string) SecretBackend {
	raw, err := os.ReadFile(settingsPath(dataDir))
	if err != nil {
		return SecretBackendKeychain
	}
	var settings settingsFile
	if err := json.Unmarshal(raw, &settings); err != nil {
		return SecretBackendKeychain
	}
	mode := SecretBackend(settings.SecretStorage)
	if !ValidSecretBackend(mode) {
		return SecretBackendKeychain
	}
	return mode
}

// SaveSecretBackend validates mode and persists it to settings.json
// atomically (tmp file + rename, mode 0600), the same convention as
// connections.json.
func SaveSecretBackend(dataDir string, mode SecretBackend) error {
	if !ValidSecretBackend(mode) {
		return fmt.Errorf("store: unknown secret storage mode %q", mode)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(settingsFile{SecretStorage: string(mode)}, "", "  ")
	if err != nil {
		return err
	}
	file := settingsPath(dataDir)
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// NewWithMode opens the store like New, choosing the secret backend from the
// persisted setting (LoadSecretBackend): keyringFactory for the keychain
// mode, a FileSecrets rooted at dataDir for the local-file mode. It returns
// the store and the mode it started on. keyringFactory is injected (rather
// than calling KeyringSecrets directly) so tests never touch the real
// keychain; it must not return nil.
func NewWithMode(dataDir string, keyringFactory func() SecretStore) (*Store, SecretBackend, error) {
	mode := LoadSecretBackend(dataDir)
	var secrets SecretStore
	switch mode {
	case SecretBackendLocalFile:
		secrets = NewFileSecrets(dataDir)
	default:
		mode = SecretBackendKeychain
		secrets = keyringFactory()
	}
	if secrets == nil {
		return nil, "", errors.New("store: no secret backend available for mode " + string(mode))
	}
	s := New(dataDir, secrets)
	s.mode = mode
	return s, mode, nil
}
