# mux-web-streams

`mux-web-streams` is a TypeScript library that provides utilities for multiplexing and demultiplexing (AKA "muxing" and "demuxing") streams. It allows you to combine multiple streams into a single stream and then separate them back into individual streams. This works in browsers and in Node. It uses WHATWG standard [Web Streams](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API), which are also [available in Node](https://nodejs.org/api/webstreams.html).

At [Transcend](https://transcend.io/), we use `mux-web-streams` to stream LLM responses when using [langchain](https://github.com/langchain-ai/langchainjs) on Lamdba functions with Vercel. This allows us to stream responses as they're generated, while also passing other metadata to the client, such as [ChainValues](https://js.langchain.com/docs/modules/chains/).

## Installation

You can install `mux-web-streams` using npm:

```shell
npm install mux-web-streams
```

or yarn:

```shell
yarn add mux-web-streams
```

## Usage

To use `mux-web-streams`, import the desired functions from the library:

```typescript
import { demuxer, muxer } from 'mux-web-streams';
```

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

### muxer(streams: ReadableStream<ChunkData>[]): ReadableStream<Uint8Array>

Multiplexes an array of `ReadableStream`s into a single stream.

- `streams`: An array of `ReadableStream`s to be multiplexed.

### demuxer(stream: ReadableStream, numberOfStreams: number): ReadableStream<ChunkData>[]

Demultiplexes a single multiplexed `ReadableStream` into an array of `ReadableStream`s.

- `stream`: The multiplexed stream from `muxer()`.
- `numberOfStreams`: The number of streams passed into `muxer()`.

## Examples

### Streaming from a Vercel function

```typescript
// app/api/chat/route.ts
import { muxer } from 'mux-web-streams';

export async function POST(request: Request): Promise<Response> {
  // Create an array of ReadableStreams
  const chatResponseStream: ReadableStream<string> = createReadableStream();
  const chainValuesStream: ReadableStream<ChainValues> = createReadableStream();

  // Multiplex the streams into a single stream
  const multiplexedStream = muxer([chatResponseStream, chainValuesStream]);

  // Stream the result
  return new Response(multiplexedStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
```

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
