import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from './sse';

const parse = (chunks: string[], flush = true): SseEvent[] => {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  chunks.forEach(parser.feed);
  if (flush) parser.end();
  return events;
};

describe('createSseParser', () => {
  it('emits one event per blank-line-terminated block, defaulting the name to message', () => {
    expect(parse(['event: message\ndata: {"a":1}\n\ndata: {"b":2}\n\n'])).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: '{"b":2}' },
    ]);
  });

  it('handles CRLF and bare CR line ends, including a CR LF pair split across chunks', () => {
    expect(parse(['data: one\r', '\n\r', '\ndata: two\r\rdata: three\n\n'])).toEqual([
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
      { event: 'message', data: 'three' },
    ]);
  });

  it('reassembles a line split across many chunks and joins multi-line data', () => {
    const big = 'x'.repeat(10_000);
    const text = `data: ${big}\ndata: tail\n\n`;
    const chunks = text.match(/[\s\S]{1,997}/g) ?? [];
    expect(parse(chunks)).toEqual([{ event: 'message', data: `${big}\ntail` }]);
  });

  it('ignores comments, ids, retry and data-less blocks; strips only one leading space', () => {
    expect(parse([': keep-alive\n\nid: 7\nretry: 100\n\nevent: ping\ndata:  two spaces\n\n'])).toEqual([
      { event: 'ping', data: ' two spaces' },
    ]);
  });

  it('flushes a trailing event that lacks the final blank line only on end()', () => {
    expect(parse(['data: last'], false)).toEqual([]);
    expect(parse(['data: last'])).toEqual([{ event: 'message', data: 'last' }]);
  });
});
