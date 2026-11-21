// Settings saved under the old app name move to the new one, without
// overwriting anything already saved under the new name.
import { describe, it, expect, beforeEach } from 'vitest'
import { moveRenamedKeys } from './storageRename'

beforeEach(() => localStorage.clear())

describe('moveRenamedKeys', () => {
  it('moves every bytescon key to the same bytesgov key, and keeps other keys', () => {
    localStorage.setItem('bytescon_auth', '{"token":"t"}')
    localStorage.setItem('bytescon:profile-incomplete', '1')
    localStorage.setItem('bytescon_tutorial_seen_pipeline', 'yes')
    localStorage.setItem('other_app', 'x')
    moveRenamedKeys(localStorage)
    expect(localStorage.getItem('bytesgov_auth')).toBe('{"token":"t"}')
    expect(localStorage.getItem('bytesgov:profile-incomplete')).toBe('1')
    expect(localStorage.getItem('bytesgov_tutorial_seen_pipeline')).toBe('yes')
    expect(localStorage.getItem('bytescon_auth')).toBeNull()
    expect(localStorage.getItem('other_app')).toBe('x')
  })
  it('never overwrites a value already saved under the new name', () => {
    localStorage.setItem('bytescon_auth', 'old')
    localStorage.setItem('bytesgov_auth', 'new')
    moveRenamedKeys(localStorage)
    expect(localStorage.getItem('bytesgov_auth')).toBe('new')
    expect(localStorage.getItem('bytescon_auth')).toBeNull()
  })
})
