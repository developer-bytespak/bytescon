// =============================================================
// DeliverableThread.buildTree — pure tree construction tests
// Validates the threaded-comment tree from a flat list.
// =============================================================

import { describe, it, expect } from 'vitest'
import { buildTree } from './DeliverableThread'

interface FlatComment {
  id: string
  deliverableId: string
  authorType: 'CONSULTANT' | 'CLIENT'
  authorId: string
  authorName: string
  body: string
  parentId: string | null
  isResolved: boolean
  createdAt: string
  updatedAt: string
}

function makeComment(id: string, parentId: string | null = null): FlatComment {
  return {
    id,
    deliverableId: 'deliv-1',
    authorType: 'CLIENT',
    authorId: 'user-1',
    authorName: 'Alice',
    body: `comment ${id}`,
    parentId,
    isResolved: false,
    createdAt: '2026-04-23T00:00:00Z',
    updatedAt: '2026-04-23T00:00:00Z',
  }
}

describe('buildTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildTree([])).toEqual([])
  })

  it('returns single root with no replies', () => {
    const tree = buildTree([makeComment('a')])
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('a')
    expect(tree[0].replies).toEqual([])
  })

  it('attaches reply to parent', () => {
    const tree = buildTree([
      makeComment('root'),
      makeComment('reply', 'root'),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].replies).toHaveLength(1)
    expect(tree[0].replies[0].id).toBe('reply')
  })

  it('handles multiple roots', () => {
    const tree = buildTree([
      makeComment('a'),
      makeComment('b'),
      makeComment('c'),
    ])
    expect(tree).toHaveLength(3)
    expect(tree.map(t => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('handles multiple replies to same parent', () => {
    const tree = buildTree([
      makeComment('root'),
      makeComment('r1', 'root'),
      makeComment('r2', 'root'),
      makeComment('r3', 'root'),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].replies).toHaveLength(3)
  })

  it('orphaned reply (parent missing) becomes a root — defensive', () => {
    // If parent was deleted but reply somehow remains, do not lose the comment
    const tree = buildTree([makeComment('orphan', 'missing-parent')])
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('orphan')
  })

  it('handles deeply nested chain (each child has one reply)', () => {
    const tree = buildTree([
      makeComment('a'),
      makeComment('b', 'a'),
      makeComment('c', 'b'),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].replies).toHaveLength(1)
    expect(tree[0].replies[0].id).toBe('b')
    expect(tree[0].replies[0].replies).toHaveLength(1)
    expect(tree[0].replies[0].replies[0].id).toBe('c')
  })

  it('does not lose comments when input is mixed-order', () => {
    // Reply listed before parent
    const tree = buildTree([
      makeComment('reply', 'root'),
      makeComment('root'),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('root')
    expect(tree[0].replies).toHaveLength(1)
    expect(tree[0].replies[0].id).toBe('reply')
  })
})
