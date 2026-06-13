import { describe, expect, it } from 'vitest'
import { StreamCommitter } from './streamCommit.js'

function contentOf(chunks: ReturnType<StreamCommitter['onDone']>): string {
  return chunks
    .filter((chunk) => !chunk.spacer)
    .map((chunk) => chunk.text)
    .join('')
}

describe('StreamCommitter', () => {
  it('does not commit the same tail twice when onDone is called again', () => {
    const c = new StreamCommitter(false)

    expect(c.onText('final tail without newline')).toEqual([])
    const firstDone = c.onDone()
    const secondDone = c.onDone()

    expect(contentOf(firstDone)).toBe('final tail without newline')
    expect(secondDone).toEqual([])
  })

  it('does not recommit text that was already flushed by newline', () => {
    const c = new StreamCommitter(false)

    const chunks = c.onText('line one\n')
    const done = c.onDone()

    expect(contentOf(chunks)).toBe('line one')
    expect(done.filter((chunk) => !chunk.spacer)).toEqual([])
  })

  it('commits reasoning tail only once when text starts', () => {
    const c = new StreamCommitter(true)

    expect(c.onReasoning('thinking tail')).toEqual([])
    const textChunks = c.onText('answer')
    const doneChunks = c.onDone()

    expect(contentOf(textChunks)).toBe('thinking tail')
    expect(contentOf(doneChunks)).toBe('answer')
  })

  it('soft-flushes long unbroken answer text so the live region stays short', () => {
    const c = new StreamCommitter(false)
    const text =
      'Story begins during the Cultural Revolution, when the physicist Ye Wenjie loses faith in humanity after betrayal and tragedy. '.repeat(
        5,
      )

    const chunks = c.onText(text)

    expect(chunks.filter((chunk) => !chunk.spacer).length).toBeGreaterThan(0)
    expect(c.liveText.length).toBeGreaterThan(0)
    expect(c.liveText.length).toBeLessThan(text.length)
    expect(contentOf([...chunks, ...c.onDone()])).toBe(text)
  })

  it('soft-flushes long unbroken reasoning text without leaking it into answer text', () => {
    const c = new StreamCommitter(true)
    const reasoning = 'The model is planning the structure of a long response before writing the visible answer. '.repeat(5)

    const reasoningChunks = c.onReasoning(reasoning)
    const textChunks = c.onText('final answer')
    const doneChunks = c.onDone()

    expect(reasoningChunks.filter((chunk) => !chunk.spacer).length).toBeGreaterThan(0)
    expect(contentOf([...reasoningChunks, ...textChunks].filter((chunk) => chunk.variant === 'reasoning'))).toBe(
      reasoning,
    )
    expect(contentOf(doneChunks.filter((chunk) => chunk.variant === 'text'))).toBe('final answer')
  })
})
