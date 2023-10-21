import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  arrayToHeader,
  deserializeData,
  headerToArray,
  serializeData,
} from '../src/helpers.js';
import { demuxer, muxer } from '../src/index.js';
import type { Header } from '../src/types.js';

const createStreamFromArray = (arr: any[] | Uint8Array): ReadableStream => {
  return new ReadableStream({
    start(controller) {
      for (let item of arr) {
        controller.enqueue(item);
      }
      controller.close();
    },
  });
};

const readStreamToArray = async (stream: ReadableStream): Promise<any[]> => {
  const reader = stream.getReader();
  const result = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    result.push(value);
  }

  return result;
};

describe('mux/demux', () => {
  // Test mux/demux equivalence
  test('`demux` outputs are equivalent to `mux` inputs', async () => {
    // Create test data
    const originalData = [
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      ['a', 'b', 'c'],
      [new Uint8Array([99, 100])],
      [{ a: 1 }, { b: 2 }, { c: 3 }],
    ];

    // Create ReadableStreams from the test data
    const originalStreams = Object.values(originalData).map(
      createStreamFromArray,
    );

    // Mux the streams together
    const muxedStream = muxer(originalStreams);

    // Demux the stream
    const demuxedStreams = demuxer(muxedStream, originalStreams.length);

    // Read the demuxed streams back into arrays to match the shape of `originalData`
    const demuxedData = await Promise.all(
      demuxedStreams.map((stream) => readStreamToArray(stream)),
    );

    // Assert that the demuxed data is equal to the original data
    assert.deepStrictEqual(demuxedData, originalData);
  });

  // Test async is not blocking
  test('async is not blocking - streams do not wait on slowest stream', async () => {
    // Create test data
    const originalData = [
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      ['a', 'b', 'c'],
      [{ a: 1 }, { b: 2 }, { c: 3 }],
    ];

    const TIMEOUT = 1000;
    const SLOW_STREAM_TIME = TIMEOUT * originalData[1]!.length;

    const originalStreams = [
      createStreamFromArray(originalData[0]!),
      // Slow stream
      new ReadableStream({
        async start(controller) {
          for (let item of originalData[1]!) {
            // Wait first
            await new Promise((resolve) => {
              setTimeout(() => resolve(null), TIMEOUT);
            });
            controller.enqueue(item);
          }
          controller.close();
        },
      }),
      createStreamFromArray(originalData[2]!),
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

describe('data serialization', () => {
  describe('serializeData', () => {
    test('Uint8Array is not modified', () => {
      const input = new Uint8Array([0, 1, 2, 3, 200]);
      const { data, isRaw } = serializeData({ value: input });
      assert(isRaw === true);
      assert(data instanceof Uint8Array);
      assert.deepStrictEqual(data, input);
    });
  });

  describe('deserializeData', () => {
    test('Data marked isRaw is returned as Uint8Array', () => {
      const input = new Uint8Array([0, 1, 2, 3, 200]);
      const { data, isRaw } = serializeData({ value: input });
      assert(isRaw === true);
      assert(data instanceof Uint8Array);
      assert.deepStrictEqual(data, input);
    });
  });

  test('serializeData and deserializeData are inverse', () => {
    for (const input of [
      new Uint8Array([0, 1, 2, 3, 200]),
      'hello',
      3,
      null,
      [2, 3, 4],
      { a: 1 },
    ]) {
      const { data, isRaw } = serializeData({ value: input });
      const { value } = deserializeData({ data, isRaw });
      assert.deepStrictEqual(value, input);
    }
  });
});

// Test header conversion functions are inverse
describe('headers', () => {
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
