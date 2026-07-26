import { describe, expect, it } from 'vitest'
import { PROTOCOLS } from '../src/shared/protocols'

describe('PROTOCOLS metadata table', () => {
  it('covers exactly the 8 expected protocols', () => {
    const ids = PROTOCOLS.map((p) => p.id).sort()
    expect(ids).toEqual(['ftp', 'http', 'https', 'rdp', 'smb', 'ssh', 'telnet', 'vnc'])
  })

  it('has unique ids', () => {
    const ids = PROTOCOLS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has unique default ports', () => {
    const ports = PROTOCOLS.map((p) => p.defaultPort)
    expect(new Set(ports).size).toBe(ports.length)
  })

  it('has all required fields non-empty and well-formed', () => {
    for (const p of PROTOCOLS) {
      expect(p.name.trim()).not.toBe('')
      expect(p.descriptionKey).toMatch(/^protocols\.desc\.[a-z]+$/)
      expect(Number.isInteger(p.defaultPort)).toBe(true)
      expect(p.defaultPort).toBeGreaterThan(0)
      expect(p.defaultPort).toBeLessThanOrEqual(65535)
      expect(typeof p.mvpSupported).toBe('boolean')
    }
  })

  it('marks only ssh and vnc as MVP-supported', () => {
    const supported = PROTOCOLS.filter((p) => p.mvpSupported).map((p) => p.id)
    expect(supported.sort()).toEqual(['ssh', 'vnc'])
  })
})
