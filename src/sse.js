/** Parse a stream of bytes/strings into Server-Sent Events: { event, data }. */
function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

export async function* parseSSE(chunks) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n?/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const ev = parseBlock(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (ev) yield ev;
    }
  }
  buffer += decoder.decode();
  const last = parseBlock(buffer.replace(/\r\n?/g, '\n'));
  if (last) yield last;
}
