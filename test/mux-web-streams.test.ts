import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  arrayToHeader,
  deserializeData,
  headerToArray,
  serializeData,
} from '../src/helpers.js';
import { demuxer, muxer } from '../src/index.js';
import type { Header, SerializableData } from '../src/types.js';

const createStreamFromArray = (arr: readonly any[]): ReadableStream => {
  return new ReadableStream({
    start(controller) {
      for (let item of arr) {
        controller.enqueue(item);
      }
      controller.close();
    },
    cancel(reason) {
      console.error('Readable canceled', reason);
    },
  });
};

const readStreamToArray = async (stream: ReadableStream): Promise<any[]> => {
  const result: any[] = [];
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    result.push(value);
  }

  return result;
};

const inputData: SerializableData[][] = [
  [1, 2, 3],
  ['a', 'b', 'c', 'd'],
  [{ a: 1 }, { b: 2 }, { c: 3 }],
  [1, 2],
  ['A'],
  [[1, 2], 3, 'a', new Uint8Array([12, 1, 3, 100, 255, 0])],
  [true, false],
  [[1, 2], 3, null, 'a'],
  [[1, 2], 3, 'a'],
  [[1, 2], 3, false],
  [[1, 2], 3, 0],
  [[1, 2], 3, []],
  [new Uint8Array([12, 1, 3, 100, 255, 0])],
  [null, null, null],
  [[1, 2], 3, 'a', {}],
  [[1, 2], 3, null, 'a'],
  [{}, {}],
  [],
];

describe('mux/demux', () => {
  // Test mux/demux equivalence
  test('`demux` outputs are equivalent to `mux` inputs', async () => {
    // Create ReadableStreams from the test data
    const originalStreams = Object.values(inputData).map(createStreamFromArray);

    // Mux the streams together
    const muxedStream = muxer(originalStreams);

    // Demux the stream
    const demuxedStreams = demuxer(muxedStream, originalStreams.length);

    // Read the demuxed streams back into arrays to match the shape of `originalData`
    const demuxedData = await Promise.all(
      demuxedStreams.map((stream) => readStreamToArray(stream)),
    );

    // Assert that the demuxed data is equal to the original data
    assert.deepStrictEqual(demuxedData, inputData);
  });

  test('`mux` works on `Uint8Array` streams', async () => {
    const uint8Stream = new Response('hello world').body!;
    const muxedStream = muxer([uint8Stream]);
    const demuxedStream = demuxer(muxedStream, 1)[0]!;

    let result = '';
    for await (const chunk of demuxedStream as any as AsyncIterable<Uint8Array>) {
      assert.ok(chunk instanceof Uint8Array);
      result += new TextDecoder().decode(chunk);
    }
    assert.equal('hello world', result);
  });

  test('`demux` can handle chunks that were concatenated by network pipes', async () => {
    const testData = ['a', 'b', 'c'];
    const stream = createStreamFromArray(testData);
    const muxedStream = muxer([stream]);

    // Concatenate the multiplexed chunks (e.g., something that can happen over a network pipe)
    // e.g., when `fetch`ing a multiplexed stream from a server
    const chunksToConcat: Uint8Array[] = [];
    const concatenatedMuxedStream = muxedStream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          chunksToConcat.push(chunk);
          controller.enqueue(new Uint8Array([]));
        },
        flush(controller) {
          // Get total length of Uint8Arrays in `chunksToConcat`
          const totalLength = chunksToConcat.reduce(
            (acc, chunk) => acc + chunk.length,
            0,
          );
          // Create a new array with total length and merge all source arrays.\
          const concatenatedChunks = new Uint8Array(totalLength);
          let offset = 0;
          for (let chunk of chunksToConcat) {
            concatenatedChunks.set(chunk, offset);
            offset += chunk.length;
          }

          controller.enqueue(concatenatedChunks);
        },
      }),
    );

    // Demux normally
    const demuxedStream = demuxer(concatenatedMuxedStream, 1)[0]!;
    const resultData = await readStreamToArray(demuxedStream);

    assert.deepStrictEqual(resultData, testData);
  });

  // Test async is not blocking
  test('asynchronous input streams do not block - `mux` continues with fast streams while waiting on slow streams', async () => {
    // Create test data
    const originalData = [
      [1, 2, 3],
      ['a', 'b', 'c'],
      [{ a: 1 }, { b: 2 }, { c: 3 }],
    ] as const;

    const TIMEOUT = 1000;
    const SLOW_STREAM_TIME = TIMEOUT * originalData[1].length;

    const originalStreams = [
      createStreamFromArray(originalData[0]),
      // Slow stream
      new ReadableStream({
        async start(controller) {
          for (let item of originalData[1]) {
            // Wait first
            await new Promise((resolve) => {
              setTimeout(() => resolve(null), TIMEOUT);
            });
            controller.enqueue(item);
          }
          controller.close();
        },
      }),
      createStreamFromArray(originalData[2]),
    ];

    const startTime = Date.now();

    // Mux the streams together
    const muxedStream = muxer(originalStreams);

    // Track time to complete each stream
    const timeElapsedById: Record<number, any> = {};

    // Demux the stream
    const demuxedStreams = demuxer(muxedStream, originalStreams.length);
    const demuxedData = await Promise.all(
      demuxedStreams.map(async (stream, id) => {
        const data = await readStreamToArray(stream);
        const endTime = Date.now();
        const timeElapsed = endTime - startTime;
        timeElapsedById[id] = timeElapsed;
        return data;
      }),
    );

    // Assert the other streams have not waited on the slow stream to finish
    assert.ok(timeElapsedById[0] < SLOW_STREAM_TIME * 0.5);
    assert.ok(timeElapsedById[2] < SLOW_STREAM_TIME * 0.5);

    // Assert that the demuxed data is equal to the original data
    assert.deepStrictEqual(demuxedData, originalData);
  });
});

describe('serialization', () => {
  test('body conversion functions `serializeData` and `deserializeData` are inverse', () => {
    for (const input of inputData) {
      if (input.length === 0) continue;
      const { data, isRaw } = serializeData({ value: input[0]! });
      const { value } = deserializeData({ data, isRaw });
      assert.deepStrictEqual(value, input[0]);
    }
  });

  test('header conversion functions `headerToArray` and `arrayToHeader` are inverse', async () => {
    const header: Header = {
      id: 123,
      end: true,
      dataIsRaw: false,
    };

    const encodedHeader = headerToArray(header);
    const decodedHeader = arrayToHeader(encodedHeader);

    assert.deepStrictEqual(header, decodedHeader);
  });
});

describe('error handling', async () => {
  await test('`muxer` throwing can be handled by a client', async () => {
    const muxedStream = muxer(
      // Too many streams
      Array.from({ length: 500 }).map(() => createStreamFromArray([1, 2])),
    );

    const promise = new Promise<void>((resolve, reject) => {
      muxedStream.pipeTo(
        new WritableStream({
          close() {
            resolve();
          },
          abort(reason) {
            reject(reason);
          },
        }),
      );
    });

    await assert.rejects(
      promise,
      "Error: Muxer cannot have more than 250 input streams. Stream 'id' must be a number between 0 and 250",
    );
  });
});
