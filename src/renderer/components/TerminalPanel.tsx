import { useAppStore } from '../store'

interface TermLine {
  text: string
  kind: 'prompt' | 'output' | 'comment'
}

/** Mock shell transcript for the phase-1 UI prototype. */
function buildLines(host: string): TermLine[] {
  return [
    { text: `silicayang@silicamacbook-pro ~ % ssh ${host}`, kind: 'prompt' },
    { text: `Last login: Sun Jul 26 18:02:41 2026 from 192.168.50.1`, kind: 'comment' },
    { text: 'silicayang@mac ~ % uname -a', kind: 'prompt' },
    {
      text: 'Darwin mac.local 25.3.0 Darwin Kernel Version 25.3.0: arm64',
      kind: 'output'
    },
    { text: 'silicayang@mac ~ % uptime', kind: 'prompt' },
    { text: '18:05  up 12 days,  3:42, 2 users, load averages: 1.24 1.18 1.09', kind: 'output' },
    { text: 'silicayang@mac ~ % ', kind: 'prompt' }
  ]
}

const KIND_COLORS: Record<TermLine['kind'], string> = {
  prompt: '#7ee787',
  output: '#c9d1d9',
  comment: '#8b949e'
}

export default function TerminalPanel() {
  const targetAddress = useAppStore((s) => s.targetAddress)
  const lines = buildLines(targetAddress)

  return (
    <div className="terminal-panel mono">
      {lines.map((line, i) => (
        <div key={i} style={{ color: KIND_COLORS[line.kind] }}>
          {line.text}
          {i === lines.length - 1 && <span className="terminal-cursor" />}
        </div>
      ))}
    </div>
  )
}
