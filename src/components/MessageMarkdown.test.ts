import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageMarkdown } from './MessageMarkdown'

const render = (text: string) => renderToStaticMarkup(createElement(MessageMarkdown, { text }))

test('renders headings, lists and emphasis as elements, not literal markdown', () => {
  const html = render('## Role: Backend Engineer\n\n- **Experience:** 5+ years\n- REST/gRPC APIs\n\n1. LinkedIn\n2. GitHub')
  assert.match(html, /<h2[^>]*>Role: Backend Engineer<\/h2>/)
  assert.match(html, /<ul[^>]*>[\s\S]*<li[^>]*><strong[^>]*>Experience:<\/strong> 5\+ years<\/li>/)
  assert.match(html, /<ol[^>]*>[\s\S]*<li[^>]*>GitHub<\/li>/)
  assert.doesNotMatch(html, /##|\*\*/)
})

test('renders inline code, code blocks and tables (GitHub flavour)', () => {
  const html = render('Use `site:linkedin.com/in` first.\n\n```sql\nselect 1;\n```\n\n| Channel | Yield |\n|---|---|\n| Referrals | high |')
  assert.match(html, /<code[^>]*>site:linkedin\.com\/in<\/code>/)
  assert.match(html, /<pre[^>]*>[\s\S]*select 1;[\s\S]*<\/pre>/)
  assert.match(html, /<table[^>]*>[\s\S]*<th[^>]*>Channel<\/th>[\s\S]*<td[^>]*>Referrals<\/td>/)
})

test('never renders raw HTML from the model and opens links safely', () => {
  const html = render('Hello <script>alert(1)</script> [docs](https://example.com/x)')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /<a[^>]*href="https:\/\/example\.com\/x"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/)
})

test('keeps plain prose as paragraphs with soft line breaks preserved', () => {
  const html = render('First line\nsecond line\n\nNew paragraph')
  assert.equal((html.match(/<p/g) ?? []).length, 2)
  assert.match(html, /First line<br\s*\/?>\s*second line/)
})
