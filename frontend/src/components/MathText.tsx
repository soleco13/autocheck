import React from 'react'
import katex from 'katex'

// Renders text that may contain LaTeX expressions:
//   - $...$  or  $$...$$  (explicit delimiters — new format)
//   - bare LaTeX commands like \frac, \alpha, \sqrt, ^, _ etc. (legacy format)
//
// Falls back to raw text if KaTeX fails.

function renderMath(latex: string, display = false): string {
  try {
    return katex.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: false,
    })
  } catch {
    return latex
  }
}

// Splits text into segments: { type: 'text' | 'math' | 'math-display', content }
function tokenize(text: string): Array<{ type: 'text' | 'math' | 'math-display'; content: string }> {
  const segments: Array<{ type: 'text' | 'math' | 'math-display'; content: string }> = []

  // Match $$...$$ (display), then $...$ (inline)
  // Also match \(...\) inline and \[...\] display
  const RE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g

  let last = 0
  let m: RegExpExecArray | null

  while ((m = RE.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', content: text.slice(last, m.index) })
    }

    const raw = m[1]
    if (raw.startsWith('$$') || raw.startsWith('\\[')) {
      const inner = raw.startsWith('$$')
        ? raw.slice(2, -2)
        : raw.slice(2, -2)
      segments.push({ type: 'math-display', content: inner.trim() })
    } else {
      const inner = raw.startsWith('$')
        ? raw.slice(1, -1)
        : raw.slice(2, -2)
      segments.push({ type: 'math', content: inner.trim() })
    }
    last = m.index + raw.length
  }

  if (last < text.length) {
    segments.push({ type: 'text', content: text.slice(last) })
  }

  return segments
}

// Detect if a plain-text segment itself looks like LaTeX that wasn't delimited
// (e.g. server converted \frac{a}{b} → a/b but left \alpha, \sqrt, x^2 etc.)
const BARE_LATEX_RE = /\\(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|Xi|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega|sqrt|sum|prod|int|lim|frac|dfrac|cdot|times|div|pm|mp|le|ge|leq|geq|ne|neq|approx|equiv|infty|partial|nabla|to|rightarrow|leftarrow|Rightarrow|Leftarrow|in|notin|subset|supset|cup|cap|ldots|cdots|vdots|forall|exists|vec|hat|bar|dot|ddot|tilde|overline|underline|text|mathrm|mathbf|mathit|sin|cos|tan|log|ln|exp|max|min)\b|(?<![a-zA-Z])\^(?=[\d{])|(?<=[a-zA-Z\d}])\^(?=[-\d{a-zA-Z])|(?<![a-zA-Z])_\{/

function segmentNeedsKatex(text: string): boolean {
  return BARE_LATEX_RE.test(text)
}

interface MathTextProps {
  children: string
  className?: string
  style?: React.CSSProperties
  block?: boolean  // display block instead of inline
}

export function MathText({ children, className, style, block }: MathTextProps) {
  if (!children) return null

  const segments = tokenize(children)

  // If no explicit delimiters found but text looks like LaTeX, wrap whole thing
  if (segments.length === 1 && segments[0].type === 'text') {
    const t = segments[0].content
    if (segmentNeedsKatex(t)) {
      // Wrap in $$ for display or $ for inline
      const html = renderMath(t, !!block)
      if (block) {
        return (
          <div
            className={className}
            style={{ overflowX: 'auto', ...style }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )
      }
      return (
        <span
          className={className}
          style={style}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )
    }
    // Plain text, no LaTeX
    return block
      ? <div className={className} style={style}>{t}</div>
      : <span className={className} style={style}>{t}</span>
  }

  // Mixed content
  const parts = segments.map((seg, i) => {
    if (seg.type === 'text') {
      if (segmentNeedsKatex(seg.content)) {
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{ __html: renderMath(seg.content, false) }}
          />
        )
      }
      return <React.Fragment key={i}>{seg.content}</React.Fragment>
    }
    const html = renderMath(seg.content, seg.type === 'math-display')
    if (seg.type === 'math-display') {
      return (
        <div key={i} style={{ overflowX: 'auto', margin: '8px 0' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )
    }
    return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />
  })

  return block
    ? <div className={className} style={style}>{parts}</div>
    : <span className={className} style={style}>{parts}</span>
}
