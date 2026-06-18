export type SseMessage = {
  data: string;
};

export async function* parseSseStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() ?? "";

      for (const message of messages) {
        const parsed = parseSseMessage(message);
        if (parsed) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    const finalMessage = parseSseMessage(buffer);
    if (finalMessage) {
      yield finalMessage;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseMessage(rawMessage: string): SseMessage | null {
  const dataLines = rawMessage
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  return {
    data: dataLines.join("\n"),
  };
}
