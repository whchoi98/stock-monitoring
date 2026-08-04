import { describe, expect, it } from 'vitest'
import { createSseParser } from './sse.ts'

describe('createSseParser', () => {
  it('완전한 프레임 하나를 파싱한다 / parses one complete frame', () => {
    const p = createSseParser()
    expect(p.feed('event: delta\ndata: {"text":"a"}\n\n')).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
    ])
  })

  it('청크 경계에서 잘린 프레임을 이어 붙인다 / stitches a frame split across chunks', () => {
    const p = createSseParser()
    expect(p.feed('event: delta\nda')).toEqual([])
    expect(p.feed('ta: {"text":"a"}\n\n')).toEqual([{ event: 'delta', data: '{"text":"a"}' }])
  })

  it('한 청크의 여러 프레임을 모두 반환한다 / returns every frame in one chunk', () => {
    const p = createSseParser()
    const frames = p.feed('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(frames.map((f) => f.event)).toEqual(['a', 'b'])
  })

  it('멀티라인 data를 개행으로 합친다 / joins multi-line data with newlines', () => {
    const p = createSseParser()
    expect(p.feed('event: x\ndata: 1\ndata: 2\n\n')).toEqual([{ event: 'x', data: '1\n2' }])
  })

  it('CRLF도 처리한다 / handles CRLF', () => {
    const p = createSseParser()
    expect(p.feed('event: x\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'x', data: '1' }])
  })
})
