/**
 * 증분 SSE 프레임 파서 — fetch ReadableStream 청크는 프레임 경계와 무관하게 잘린다.
 * An incremental SSE frame parser; fetch stream chunks split anywhere, not at frame boundaries.
 * (EventSource는 GET 전용이라 POST SSE는 직접 파싱한다 / EventSource is GET-only, so POST SSE is parsed by hand.)
 */
export interface SseEvent {
  event: string
  data: string
}

export function createSseParser(): { feed(chunk: string): SseEvent[] } {
  let buffer = ''
  return {
    feed(chunk: string): SseEvent[] {
      buffer += chunk.replace(/\r\n/g, '\n')
      const events: SseEvent[] = []
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) data.push(line.slice(6))
        }
        if (data.length > 0) events.push({ event, data: data.join('\n') })
        boundary = buffer.indexOf('\n\n')
      }
      return events
    },
  }
}
