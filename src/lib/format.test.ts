import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewText } from './format'

test('previewText strips markdown so a sidebar snippet reads as prose', () => {
  const body = "We're sourcing for:\n\n## Role: Backend Engineer (Mid-Senior)\n- **Experience:** 5+ years\n- **Core requirements:**\n  - REST/gRPC API design\n\n1. LinkedIn\n2. GitHub\n\nUse `site:linkedin.com` and [this guide](https://example.com)."
  const text = previewText(body)
  assert.equal(
    text,
    "We're sourcing for: Role: Backend Engineer (Mid-Senior) Experience: 5+ years Core requirements: REST/gRPC API design LinkedIn GitHub Use site:linkedin.com and this guide.",
  )
  assert.doesNotMatch(text, /[#*`\[\]]|\n/)
})

test('previewText leaves plain prose alone', () => {
  assert.equal(previewText('Talent Scout here. Share a role and I will build a shortlist.'), 'Talent Scout here. Share a role and I will build a shortlist.')
})
