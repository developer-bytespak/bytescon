import { describe, it, expect } from 'vitest'
import { noAiKeyMessage } from './aiMessages'

describe('noAiKeyMessage', () => {
  it('tells an admin where to add the key, and anyone else whom to ask', () => {
    expect(noAiKeyMessage(true)).toMatch(/^AI isn't set up for this account yet\. Add your AI provider key in Settings → AI Intelligence Provider\.$/)
    expect(noAiKeyMessage(false)).toMatch(/Ask an administrator/)
    expect(noAiKeyMessage(true)).not.toMatch(/contact your administrator/)
  })
})
