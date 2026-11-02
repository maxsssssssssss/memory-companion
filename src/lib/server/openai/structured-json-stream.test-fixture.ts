/** Synthetic transport only. Uses the real SDK and SSE decoder; never opens a socket. */
export function responseStreamFixture(response: { output?: unknown; [key: string]: unknown }, fragmentChars = 2) {
  const output = response.output as Array<{ id?: string; content: Array<{ text: string }> }>;
  const item = output[0];
  const text = item.content[0].text;
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { status: "in_progress" } }];
  for (let offset = 0; offset < text.length; offset += fragmentChars) events.push({
    type: "response.output_text.delta", item_id: item.id ?? "msg_synthetic_0000000000000000000000",
    output_index: 0, content_index: 0, delta: text.slice(offset, offset + fragmentChars), logprobs: [], sequence_number: events.length
  });
  events.push({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [], sequence_number: events.length });
  events.push({ type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0], sequence_number: events.length });
  events.push({ type: "response.output_item.done", output_index: 0, item, sequence_number: events.length });
  events.push({ type: "response.completed", response, sequence_number: events.length });
  return {
    events,
    eventBytes: events.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0),
    responseBytes: Buffer.byteLength(JSON.stringify(response)),
    textBytes: Buffer.byteLength(text),
    body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  };
}
