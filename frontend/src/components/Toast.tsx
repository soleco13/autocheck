import { Toaster } from 'react-hot-toast'

export function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        duration: 3500,
        style: {
          fontFamily: 'inherit',
          fontSize: '13.5px',
          borderRadius: '10px',
          boxShadow: '0 4px 16px rgba(17,24,39,0.1)',
          border: '1px solid rgba(17,24,39,0.06)',
        },
        success: {
          iconTheme: { primary: '#16a34a', secondary: '#fff' },
        },
        error: {
          iconTheme: { primary: '#dc2626', secondary: '#fff' },
          duration: 5000,
        },
      }}
    />
  )
}

export { toast } from 'react-hot-toast'
