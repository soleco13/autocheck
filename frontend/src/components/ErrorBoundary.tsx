import { Component, ErrorInfo, ReactNode } from 'react'
import ErrorPage from '../pages/ErrorPage'

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
    return <ErrorPage code={500} />
  }
}
