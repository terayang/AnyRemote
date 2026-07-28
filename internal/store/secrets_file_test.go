// Tests for the local-file SecretStore (secrets_file.go), the secret-storage
// settings (settings.go) and cross-backend migration (Store.MigrateSecrets).
// Internal package: the machine-UUID lookup is injected so the tests stay
// hermetic (the production keychain and the real hardware UUID are covered by
// manual UAT, except TestMachineUUID which smoke-tests the OS lookup).
package store

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// memSecrets is an in-memory SecretStore standing in for the OS keychain;
// the fail* switches simulate backend outages.
type memSecrets struct {
	values     map[string]string
	failSet    bool
	failGet    bool
	failDelete bool
}

func newMemSecrets() *memSecrets {
	return &memSecrets{values: map[string]string{}}
}

func (m *memSecrets) Set(key, value string) error {
	if m.failSet {
		return errors.New("injected set failure")
	}
	m.values[key] = value
	return nil
}

func (m *memSecrets) Get(key string) (string, error) {
	if m.failGet {
		return "", errors.New("injected get failure")
	}
	value, ok := m.values[key]
	if !ok {
		return "", ErrSecretNotFound
	}
	return value, nil
}

func (m *memSecrets) Delete(key string) error {
	if m.failDelete {
		return errors.New("injected delete failure")
	}
	if _, ok := m.values[key]; !ok {
		return ErrSecretNotFound
	}
	delete(m.values, key)
	return nil
}

// stubUUID returns a machine-UUID lookup that always reports id.
func stubUUID(id string) func() (string, error) {
	return func() (string, error) { return id, nil }
}

// failingUUID returns a machine-UUID lookup that always fails, forcing the
// secrets.key fallback.
func failingUUID() func() (string, error) {
	return func() (string, error) { return "", errors.New("injected uuid lookup failure") }
}

// newTestFileSecrets builds a FileSecrets rooted at dir with an injected
// machine-UUID lookup.
func newTestFileSecrets(dir string, machineID func() (string, error)) *FileSecrets {
	f := NewFileSecrets(dir)
	f.machineID = machineID
	return f
}

func requireCode(t *testing.T, err error, code ErrorCode) {
	t.Helper()
	var storeErr *StoreError
	if !errors.As(err, &storeErr) {
		t.Fatalf("expected *StoreError with code %s, got %v", code, err)
	}
	if storeErr.Code != code {
		t.Fatalf("expected code %s, got %s (%s)", code, storeErr.Code, storeErr.Message)
	}
}

// Set/Get/Delete roundtrip, including overwrite and not-found semantics.
func TestFileSecretsRoundtrip(t *testing.T) {
	f := newTestFileSecrets(t.TempDir(), stubUUID("uuid-under-test"))

	if _, err := f.Get("conn:a"); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("Get on empty store: expected ErrSecretNotFound, got %v", err)
	}
	if err := f.Set("conn:a", "first-secret"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	value, err := f.Get("conn:a")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if value != "first-secret" {
		t.Fatalf("Get: expected first-secret, got %q", value)
	}

	// Overwrite replaces the entry.
	if err := f.Set("conn:a", "second-secret"); err != nil {
		t.Fatalf("Set (overwrite): %v", err)
	}
	if value, err := f.Get("conn:a"); err != nil || value != "second-secret" {
		t.Fatalf("Get after overwrite: expected second-secret, got %q (%v)", value, err)
	}

	// A second key coexists; Delete removes only its own entry.
	if err := f.Set("conn:b", "other"); err != nil {
		t.Fatalf("Set (second key): %v", err)
	}
	if err := f.Delete("conn:a"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := f.Get("conn:a"); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("Get after Delete: expected ErrSecretNotFound, got %v", err)
	}
	if value, err := f.Get("conn:b"); err != nil || value != "other" {
		t.Fatalf("Delete must not touch other entries, got %q (%v)", value, err)
	}
	if err := f.Delete("conn:a"); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("Delete of a missing key: expected ErrSecretNotFound, got %v", err)
	}
}

// secrets.json holds only ciphertext: the plaintext is nowhere in the file,
// and the file is 0600.
func TestFileSecretsFileNoPlaintext(t *testing.T) {
	dir := t.TempDir()
	f := newTestFileSecrets(dir, stubUUID("uuid-under-test"))

	const plaintext = "Tr0ub4dor&3-plaintext-marker"
	if err := f.Set("conn:x", plaintext); err != nil {
		t.Fatalf("Set: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatalf("read secrets.json: %v", err)
	}
	if strings.Contains(string(raw), plaintext) {
		t.Fatalf("secrets.json must not contain the plaintext, got %s", raw)
	}
	info, err := os.Stat(filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatalf("stat secrets.json: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("secrets.json mode: expected 0600, got %o", info.Mode().Perm())
	}
}

// Same machine, different config dir: the UUID-derived key is stable, so a
// secrets.json copied to another directory on the same machine still
// decrypts; on a different machine (different UUID) it does not.
func TestFileSecretsKeyDerivationConsistency(t *testing.T) {
	dirA := t.TempDir()
	first := newTestFileSecrets(dirA, stubUUID("machine-A"))
	if err := first.Set("conn:a", "portable-only-on-same-machine"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dirA, "secrets.json"))
	if err != nil {
		t.Fatalf("read secrets.json: %v", err)
	}

	// Same machine UUID, another directory: decrypts.
	dirB := t.TempDir()
	if err := os.WriteFile(filepath.Join(dirB, "secrets.json"), raw, 0o600); err != nil {
		t.Fatalf("copy secrets.json: %v", err)
	}
	sameMachine := newTestFileSecrets(dirB, stubUUID("machine-A"))
	value, err := sameMachine.Get("conn:a")
	if err != nil {
		t.Fatalf("Get on same machine: %v", err)
	}
	if value != "portable-only-on-same-machine" {
		t.Fatalf("Get on same machine: unexpected value %q", value)
	}

	// Different machine UUID: same file is undecryptable.
	dirC := t.TempDir()
	if err := os.WriteFile(filepath.Join(dirC, "secrets.json"), raw, 0o600); err != nil {
		t.Fatalf("copy secrets.json: %v", err)
	}
	otherMachine := newTestFileSecrets(dirC, stubUUID("machine-B"))
	if _, err := otherMachine.Get("conn:a"); err == nil || errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("Get on another machine must fail decryption, got %v", err)
	}
}

// UUID lookup failure: a random key is generated once into secrets.key
// (0600, 32 bytes) and reused afterwards — even if the UUID lookup later
// recovers, the persisted key wins so existing entries stay decryptable.
func TestFileSecretsFallbackKeyFile(t *testing.T) {
	dir := t.TempDir()
	f := newTestFileSecrets(dir, failingUUID())
	if err := f.Set("conn:a", "fallback-protected"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	keyPath := filepath.Join(dir, "secrets.key")
	rawKey, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("expected secrets.key to be created: %v", err)
	}
	if len(rawKey) != 32 {
		t.Fatalf("secrets.key: expected 32 bytes, got %d", len(rawKey))
	}
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("stat secrets.key: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("secrets.key mode: expected 0600, got %o", info.Mode().Perm())
	}

	// Reopen with the UUID lookup still failing: the persisted key decrypts.
	reopened := newTestFileSecrets(dir, failingUUID())
	if value, err := reopened.Get("conn:a"); err != nil || value != "fallback-protected" {
		t.Fatalf("Get after reopen (uuid failing): expected fallback-protected, got %q (%v)", value, err)
	}

	// Reopen with the UUID lookup healthy: secrets.key still wins.
	recovered := newTestFileSecrets(dir, stubUUID("machine-A"))
	if value, err := recovered.Get("conn:a"); err != nil || value != "fallback-protected" {
		t.Fatalf("Get after uuid recovery: expected fallback-protected, got %q (%v)", value, err)
	}

	// The key file is reused, not regenerated, on every open.
	again, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("re-read secrets.key: %v", err)
	}
	if string(again) != string(rawKey) {
		t.Fatal("secrets.key must be reused, not regenerated")
	}
}

// Smoke test of the real OS lookup behind the production constructor: on
// macOS (ioreg IOPlatformUUID) and Windows (reg query MachineGuid) it must
// return a non-empty UUID. Other platforms take the secrets.key fallback.
func TestMachineUUID(t *testing.T) {
	switch runtime.GOOS {
	case "darwin", "windows":
		id, err := machineUUID()
		if err != nil {
			t.Fatalf("machineUUID: %v", err)
		}
		if id == "" {
			t.Fatal("machineUUID: expected a non-empty UUID")
		}
	default:
		t.Skip("no machine UUID source on " + runtime.GOOS)
	}
}

// settings.json roundtrip: persist + load, the JSON shape, and rejection of
// unknown modes. Missing/corrupt/unknown content loads as the keychain
// default.
func TestSecretBackendSettings(t *testing.T) {
	dir := t.TempDir()

	if got := LoadSecretBackend(dir); got != SecretBackendKeychain {
		t.Fatalf("missing settings.json: expected keychain default, got %q", got)
	}
	if err := SaveSecretBackend(dir, SecretBackend("bogus")); err == nil {
		t.Fatal("SaveSecretBackend must reject an unknown mode")
	}
	if err := SaveSecretBackend(dir, SecretBackendLocalFile); err != nil {
		t.Fatalf("SaveSecretBackend: %v", err)
	}
	if got := LoadSecretBackend(dir); got != SecretBackendLocalFile {
		t.Fatalf("expected localFile, got %q", got)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	if !strings.Contains(string(raw), `"secretStorage": "localFile"`) {
		t.Fatalf("unexpected settings.json content: %s", raw)
	}
	info, err := os.Stat(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("stat settings.json: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("settings.json mode: expected 0600, got %o", info.Mode().Perm())
	}

	// Corrupt content falls back to the keychain default.
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("corrupt settings.json: %v", err)
	}
	if got := LoadSecretBackend(dir); got != SecretBackendKeychain {
		t.Fatalf("corrupt settings.json: expected keychain default, got %q", got)
	}
	// An unknown persisted value (e.g. from a newer build) does the same.
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"secretStorage":"futureMode"}`), 0o600); err != nil {
		t.Fatalf("write unknown mode: %v", err)
	}
	if got := LoadSecretBackend(dir); got != SecretBackendKeychain {
		t.Fatalf("unknown mode: expected keychain default, got %q", got)
	}
}

// NewWithMode picks the backend from the persisted setting: keychain via the
// injected factory by default, FileSecrets for the local-file mode.
func TestNewWithMode(t *testing.T) {
	t.Run("default keychain", func(t *testing.T) {
		dir := t.TempDir()
		factoryCalled := false
		s, mode, err := NewWithMode(dir, func() SecretStore {
			factoryCalled = true
			return newMemSecrets()
		})
		if err != nil {
			t.Fatalf("NewWithMode: %v", err)
		}
		if mode != SecretBackendKeychain || s.Mode() != SecretBackendKeychain {
			t.Fatalf("expected keychain mode, got %q / %q", mode, s.Mode())
		}
		if !factoryCalled {
			t.Fatal("keychain mode must use the injected factory")
		}
	})

	t.Run("persisted localFile", func(t *testing.T) {
		dir := t.TempDir()
		if err := SaveSecretBackend(dir, SecretBackendLocalFile); err != nil {
			t.Fatalf("SaveSecretBackend: %v", err)
		}
		s, mode, err := NewWithMode(dir, func() SecretStore {
			t.Fatal("localFile mode must not call the keyring factory")
			return nil
		})
		if err != nil {
			t.Fatalf("NewWithMode: %v", err)
		}
		if mode != SecretBackendLocalFile || s.Mode() != SecretBackendLocalFile {
			t.Fatalf("expected localFile mode, got %q / %q", mode, s.Mode())
		}
		// The store is usable end to end: secrets land in secrets.json.
		summary, err := s.Save(Input{
			Name:      "local",
			Host:      "192.168.50.43",
			Protocols: []string{"ssh"},
			Username:  "u",
			Secret:    &Secret{Kind: "password", Data: "file-backed-secret"},
		})
		if err != nil {
			t.Fatalf("Save: %v", err)
		}
		conn, err := s.Get(summary.ID)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if conn.Secret == nil || conn.Secret.Data != "file-backed-secret" {
			t.Fatalf("expected the file-backed secret, got %+v", conn.Secret)
		}
		if _, err := os.Stat(filepath.Join(dir, "secrets.json")); err != nil {
			t.Fatalf("expected secrets.json to hold the secret: %v", err)
		}
	})

	t.Run("nil factory result", func(t *testing.T) {
		if _, _, err := NewWithMode(t.TempDir(), func() SecretStore { return nil }); err == nil {
			t.Fatal("a nil backend must be rejected")
		}
	})
}

// saveWithSecret seeds one connection carrying a secret.
func saveWithSecret(t *testing.T, s *Store, name, secretData string) Summary {
	t.Helper()
	input := Input{
		Name:      name,
		Host:      "100.103.82.44",
		Protocols: []string{"ssh"},
		Username:  "admin",
	}
	if secretData != "" {
		input.Secret = &Secret{Kind: "password", Data: secretData}
	}
	summary, err := s.Save(input)
	if err != nil {
		t.Fatalf("Save %q: %v", name, err)
	}
	return summary
}

// Migration keychain -> localFile: every stored secret moves to the new
// backend, old entries are removed, the setting persists, and the store
// hot-swaps; connections without a secret are untouched. Then the reverse
// migration brings everything back.
func TestMigrateSecrets(t *testing.T) {
	dir := t.TempDir()
	keychain := newMemSecrets()
	s := New(dir, keychain)

	first := saveWithSecret(t, s, "studio", "secret-one")
	second := saveWithSecret(t, s, "relay", "secret-two")
	third := saveWithSecret(t, s, "nas", "secret-three")
	noSecret := saveWithSecret(t, s, "secretless", "")
	if len(keychain.values) != 3 {
		t.Fatalf("expected 3 keychain entries, got %d", len(keychain.values))
	}

	fileBackend := newTestFileSecrets(dir, stubUUID("machine-A"))
	if err := s.MigrateSecrets(SecretBackendLocalFile, fileBackend); err != nil {
		t.Fatalf("MigrateSecrets: %v", err)
	}

	// The store hot-swapped: mode, setting file, and readable secrets.
	if s.Mode() != SecretBackendLocalFile {
		t.Fatalf("expected localFile mode after migration, got %q", s.Mode())
	}
	if got := LoadSecretBackend(dir); got != SecretBackendLocalFile {
		t.Fatalf("settings.json: expected localFile, got %q", got)
	}
	for _, want := range []struct {
		summary Summary
		secret  string
	}{{first, "secret-one"}, {second, "secret-two"}, {third, "secret-three"}} {
		conn, err := s.Get(want.summary.ID)
		if err != nil {
			t.Fatalf("Get %q after migration: %v", want.summary.Name, err)
		}
		if conn.Secret == nil || conn.Secret.Data != want.secret {
			t.Fatalf("Get %q after migration: expected %q, got %+v", want.summary.Name, want.secret, conn.Secret)
		}
	}
	// The secret-less connection is unaffected.
	conn, err := s.Get(noSecret.ID)
	if err != nil {
		t.Fatalf("Get secret-less connection: %v", err)
	}
	if conn.Secret != nil {
		t.Fatalf("secret-less connection must stay secret-less, got %+v", conn.Secret)
	}
	// The old backend is empty (every entry deleted after its copy).
	if len(keychain.values) != 0 {
		t.Fatalf("old backend must be empty after migration, got %v", keychain.values)
	}

	// Reverse migration: localFile -> a fresh keychain backend.
	back := newMemSecrets()
	if err := s.MigrateSecrets(SecretBackendKeychain, back); err != nil {
		t.Fatalf("MigrateSecrets (back): %v", err)
	}
	if s.Mode() != SecretBackendKeychain {
		t.Fatalf("expected keychain mode after reverse migration, got %q", s.Mode())
	}
	if got := LoadSecretBackend(dir); got != SecretBackendKeychain {
		t.Fatalf("settings.json: expected keychain, got %q", got)
	}
	if len(back.values) != 3 {
		t.Fatalf("expected 3 entries in the restored keychain, got %d", len(back.values))
	}
	for _, key := range []string{"conn:" + first.ID, "conn:" + second.ID, "conn:" + third.ID} {
		if _, err := fileBackend.Get(key); !errors.Is(err, ErrSecretNotFound) {
			t.Fatalf("file backend entry %q must be deleted, got %v", key, err)
		}
	}
	conn, err = s.Get(second.ID)
	if err != nil {
		t.Fatalf("Get after reverse migration: %v", err)
	}
	if conn.Secret == nil || conn.Secret.Data != "secret-two" {
		t.Fatalf("expected secret-two after reverse migration, got %+v", conn.Secret)
	}
}

// Migration failures: an unreadable old backend or an unwritable new one
// aborts with ENCRYPTION_UNAVAILABLE, the store keeps the previous backend
// and mode, and settings.json is not written.
func TestMigrateSecretsFailure(t *testing.T) {
	t.Run("old backend unreadable", func(t *testing.T) {
		dir := t.TempDir()
		keychain := newMemSecrets()
		s := New(dir, keychain)
		saveWithSecret(t, s, "studio", "secret-one")

		keychain.failGet = true
		err := s.MigrateSecrets(SecretBackendLocalFile, newTestFileSecrets(dir, stubUUID("machine-A")))
		requireCode(t, err, ErrEncryptionUnavailable)
		if !strings.Contains(err.Error(), "studio") {
			t.Fatalf("error must name the failing connection, got %q", err.Error())
		}
		if s.Mode() != SecretBackendKeychain {
			t.Fatalf("mode must stay keychain, got %q", s.Mode())
		}
		if _, statErr := os.Stat(filepath.Join(dir, "settings.json")); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("settings.json must not be written on failure, stat: %v", statErr)
		}
		// The store still runs on the old backend.
		keychain.failGet = false
		conn, getErr := s.Get(s.List()[0].ID)
		if getErr != nil || conn.Secret == nil || conn.Secret.Data != "secret-one" {
			t.Fatalf("store must still use the old backend, got %+v (%v)", conn.Secret, getErr)
		}
	})

	t.Run("new backend unwritable", func(t *testing.T) {
		dir := t.TempDir()
		keychain := newMemSecrets()
		s := New(dir, keychain)
		saveWithSecret(t, s, "studio", "secret-one")

		failingNew := newMemSecrets()
		failingNew.failSet = true
		err := s.MigrateSecrets(SecretBackendLocalFile, failingNew)
		requireCode(t, err, ErrEncryptionUnavailable)
		if s.Mode() != SecretBackendKeychain {
			t.Fatalf("mode must stay keychain, got %q", s.Mode())
		}
		// Nothing was deleted from the old backend.
		if len(keychain.values) != 1 {
			t.Fatalf("old backend must keep its entries, got %v", keychain.values)
		}
	})

	t.Run("invalid mode and nil backend", func(t *testing.T) {
		s := New(t.TempDir(), newMemSecrets())
		if err := s.MigrateSecrets(SecretBackend("bogus"), newMemSecrets()); err == nil {
			t.Fatal("an unknown mode must be rejected")
		}
		if err := s.MigrateSecrets(SecretBackendLocalFile, nil); err == nil {
			t.Fatal("a nil backend must be rejected")
		}
	})
}
