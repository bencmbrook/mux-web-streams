# Mux (and Demux) Web Streams

`mux-web-streams` enables you to multiplex and demultiplex (AKA "mux" and "demux") streams. [Stream multiplexing](https://en.wikipedia.org/wiki/Multiplexing) combines multiple streams into a single stream, so that they can be sent over one communication channel, such as in a single HTTP response. Stream demultiplexing is the opposite operation – it takes a single stream and splits it into multiple streams.

`mux-web-streams` uses WHATWG-standard [Web Streams](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API), which work across [Browsers](https://caniuse.com/?search=ReadableStream), [Node](https://nodejs.org/api/webstreams.html), [Bun](https://bun.sh/docs/api/streams), [Deno](https://deno.land/api@v1.37.2?unstable=true&s=ReadableStream).

## Installation

You can install `mux-web-streams` from [npm](https://www.npmjs.com/package/mux-web-streams):

```shell
npm install mux-web-streams # or `pnpm` or `yarn`
```

This package has zero dependencies.

## Usage

There are two functions: `muxer` and `demuxer`.

### Multiplexing streams

The `muxer` function is used to multiplex an array of `ReadableStream`s into a single stream.

```typescript
import { muxer } from 'mux-web-streams';

// Multiplex readable streams into a single stream
const multiplexedReadableStream: ReadableStream<Uint8Array> = muxer([
  readableStream0,
  readableStream1,
  readableStream2,
  readableStream3,
  readableStream4,
]);
```

### Demultiplexing streams

The `demuxer` function is used to demultiplex a multiplexed stream back into the original array of `ReadableStream`s.

```typescript
import { demuxer } from 'mux-web-streams';

// Demultiplex the stream and listen for emitted streams
const [
  readableStream0,
  readableStream1,
  readableStream2,
  readableStream3,
  readableStream4,
] = demuxer(multiplexedReadableStream, 5);

// Use your streams!
readableStream0.pipeTo(/* ... */);
```

## API

### `muxer(streams: ReadableStream<SerializableData>[]): ReadableStream<Uint8Array>`

Multiplexes an array of `ReadableStream`s into a single stream.

- `streams`: An array of `ReadableStream`s to be multiplexed.

### `demuxer(stream: ReadableStream, numberOfStreams: number): ReadableStream<SerializableData>[]`

Demultiplexes a single multiplexed `ReadableStream` into an array of `ReadableStream`s.

- `stream`: The multiplexed stream from `muxer()`.
- `numberOfStreams`: The number of streams passed into `muxer()`.

### Type `SerializableData`

The `ReadableStream`s passed into `muxer()` must emit `SerializableData`. This can be a `Uint8Array`, or anything that's [deserializable from JSON](https://datatracker.ietf.org/doc/html/rfc7159#section-3), such as `string`, `number`, `boolean`, `null`, or objects and arrays composed of those primitive types.

## Examples

### Streaming from a Vercel function

Here's an example using Langchain on Vercel functions. We want to render the AI chat completion as it comes, while also passing the chain values to the client, allowing the end-user to review the source documents behind the chatbot's answer. The chain values return the source documents that were provided to the LLM chat model using a RAG architecture. A more elaborate example might include error messages and other data.

#### Server-side muxer

```typescript
// app/api/chat/route.ts
import { muxer } from 'mux-web-streams';

export async function POST(request: Request): Promise<Response> {
  // Get several ReadableStreams
  const chatResponseStream: ReadableStream<string> = createReadableStream();
  const chainValuesStream: ReadableStream<ChainValues> = createReadableStream();

  // Multiplex the streams into a single stream
  const multiplexedStream = muxer([chatResponseStream, chainValuesStream]);

  // Stream the multiplexed data
  return new Response(multiplexedStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
```

#### Client-side demuxer

```tsx
// components/chat.tsx

import type { ChainValues } from 'langchain/schema';
import { demuxer } from 'mux-web-streams';

export const Chat = () => {
  const [chatResponse, setChatResponse] = useState<string>('');
  const [chainValues, setChainValues] = useState<Record<string, any>>({});

  const onClick = async () => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ myInput: 0 }),
    });

    if (!res.body) {
      throw new Error('No body');
    }

    // Demultiplex the multiplexed stream
    const [chatResponseStream, chainValuesStream] = demuxer(res.body, 2);

    // Write generation to the UI as it comes
    chatResponseStream.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write(chunk) {
          // Update text of the most recently added element (the AI message)
          setChatResponse(chatResponse + chunk);
        },
      }),
    );

    // Render the chain values when they come
    chainValuesStream.pipeTo(
      new WritableStream({
        write(chunk) {
          setChainValues(JSON.parse(chunk));
        },
      }),
    );
  };

  return (
    <div>
      <button onClick={onClick}>Get multiplexed stream</button>
      <p>Demuxed results:</p>
      <ul>
        <li>Chat response: {chatResponse}</li>
        <li>
          Chain values:{' '}
          <pre>
            <code>{JSON.stringify(chainValues, null, 2)}</code>
          </pre>
        </li>
      </ul>
    </div>
  );
};
```

## License

MIT
