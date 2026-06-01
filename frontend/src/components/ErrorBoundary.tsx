import { Component, ErrorInfo, ReactNode } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error.message, info.componentStack?.split('\n')[1] || '')
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--c-bg)', padding: 24,
      }}>
        <div style={{
          background: 'var(--c-surface)', borderRadius: 20, boxShadow: 'var(--shadow-lg)',
          padding: '40px 36px', width: '100%', maxWidth: 480,
          border: '1px solid var(--c-border-solid)', textAlign: 'center',
        }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--c-danger-light)', color: 'var(--c-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <AlertTriangle size={26} />
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>Что-то пошло не так</h2>
          <p style={{ fontSize: 14, color: 'var(--c-text-2)', margin: '0 0 24px', lineHeight: 1.6 }}>
            Произошла непредвиденная ошибка. Попробуйте обновить страницу.
          </p>
          <details style={{ marginBottom: 24, textAlign: 'left' }}>
            <summary style={{ fontSize: 12, color: 'var(--c-text-3)', cursor: 'pointer', marginBottom: 8 }}>
              Технические детали
            </summary>
            <pre style={{ fontSize: 11, color: 'var(--c-danger)', background: 'var(--c-danger-light)', padding: '10px 12px', borderRadius: 8, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {this.state.error.message}
            </pre>
          </details>
          <button
            className="btn btn-primary"
            onClick={() => window.location.reload()}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            <RefreshCw size={16} /> Обновить страницу
          </button>
        </div>
      </div>
    )
  }
}
