import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { login } from '../api/client'
import { AppLogo } from '../components/AppLogo'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await login(email, password)
      qc.setQueryData(['me'], data)
      navigate('/')
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка авторизации')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #eff6ff 0%, #f0fdfa 100%)',
      padding: 24,
    }}>
      <div style={{
        background: 'var(--c-surface)', borderRadius: 20,
        boxShadow: 'var(--shadow-lg)', padding: '40px 36px',
        width: '100%', maxWidth: 400,
        border: '1px solid var(--c-border-solid)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <AppLogo size={56} />
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--c-text)' }}>
            AutoCheck
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--c-text-2)' }}>
            Автопроверка работ учеников
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--c-text-2)' }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="input"
              placeholder="teacher@school.ru"
              style={{ fontSize: 14 }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--c-text-2)' }}>
              Пароль
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="input"
              placeholder="Пароль от платформы good-teach"
              style={{ fontSize: 14 }}
            />
          </div>

          {error && (
            <div style={{
              display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 14px',
              borderRadius: 'var(--radius)', background: 'var(--c-danger-light)',
              border: '1px solid #fecaca',
            }}>
              <AlertCircle size={15} color="var(--c-danger)" style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 13, color: 'var(--c-danger)' }}>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary btn-lg"
            style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}
          >
            {loading
              ? <><span className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} />Вход...</>
              : 'Войти'
            }
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--c-text-3)', marginTop: 20 }}>
          Используйте данные от платформы good-teach
        </p>
      </div>
    </div>
  )
}
