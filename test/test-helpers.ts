import type { SerializableData } from '../src/index.js';

export const createStreamFromArray = (
  arr: readonly any[],
  cancelCallback?: UnderlyingSourceCancelCallback,
): ReadableStream => {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= arr.length) {
        controller.close();
        return;
      }
      if (controller.desiredSize === null || controller.desiredSize <= 0) {
        return;
      }
      controller.enqueue(arr[i]);
      i += 1;
    },
    cancel(reason) {
      if (cancelCallback) return cancelCallback(reason);
    },
  });
};

export const readStreamToArray = async (
  stream: ReadableStream,
): Promise<any[]> => {
  const result: any[] = [];
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    result.push(value);
  }

  return result;
};

export const inputData: SerializableData[][] = [
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
