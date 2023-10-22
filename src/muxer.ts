import { headerToArray, serializeData } from './helpers.js';
import type { Header, SerializableData } from './types.js';

/**
 * For each incoming stream, we assign an ID, a reader of that stream, and whether that stream is done
 */
type Reader = {
  /** The stream's assigned ID. Equal to the stream's original position in the array passed to `muxer()` */
  id: number;
  /** The stream's reader. This is used by muxer to read chunks out of each incoming stream */
  reader: ReadableStreamDefaultReader<SerializableData>;
  /** Whether this stream has a pending promise. This causes it to get skipped when picking the next stream. */
  busy: boolean;
  /** Whether this stream is done. */
  end: boolean;
};

type ReaderById = Record<number, Reader>;

/**
 * Selects the next stream reader.
 * We read chunks from incoming streams in a round robin fashion:
 * - Streams take turns being read from.
 * - Their turn is skipped if they are done, or if they're busy (have an unresolved promise for the previously-requested chunk)
 */
function getNextReader(
  readerById: ReaderById,
  lastReaderId: number,
): Reader | 'all-done' | 'all-busy' {
  let readers = Object.values(readerById);

  /**
   * Slice the array so that the next candidate reader is first.
   * e.g., if the reader IDs are `[0,1,2,3,4,5]` and the lastReaderId was `2`
   * then the new array would be `[3,4,5,0,1,2]`
   */
  readers = [
    ...readers.slice(lastReaderId + 1),
    ...readers.slice(0, lastReaderId + 1),
  ];

  // Filter out any readers that are done
  readers = readers.filter((reader) => !reader.end);
  if (readers.length === 0) {
    return 'all-done';
  }

  // Filter out any readers that are busy
  readers = readers.filter((reader) => !reader.busy);
  if (readers.length === 0) {
    return 'all-busy';
  }

  // Select the first reader in this prioritized and filtered list
  return readers[0]!;
}

/**
 * Helper to serialize data into a chunk
 * This is the serialized chunk is what actually gets enqueued.
 * It includes a metadata header, and an encoded body
 */
function serializeChunk({
  id,
  end,
  value,
}: Omit<Header, 'dataIsRaw'> & { value: SerializableData }): Uint8Array {
  const { data, isRaw } = serializeData({ value });

  // Create the header
  const header = headerToArray({
    id,
    end,
    dataIsRaw: isRaw,
  });

  return new Uint8Array([...header, ...data]);
}

/**
 * Helper to handle backpressure
 *
 * @param desiredSize `controller.desiredSize`
 * @returns whether we should write more
 */
function downstreamIsReady(
  desiredSize: ReadableByteStreamController['desiredSize'],
): boolean {
  if (desiredSize === null) {
    throw new Error('Unexpected value `null` for `controller.desiredSize`.');
  }

  return desiredSize > 0;
}

/**
 * Multiplexes an array of ReadableStreams into a single stream
 *
 * @param streams many streams
 * @returns one stream
 */
export const muxer = (
  streams: ReadableStream<SerializableData>[],
): ReadableStream<Uint8Array> => {
  // Validation
  if (streams.length === 0) {
    throw new Error('Expected at least one stream');
  }

  // A map to help keep track of each stream's reader
  const readerById: ReaderById = {};

  // Create a new reader for each stream.
  streams.forEach((stream, i) => {
    readerById[i] = {
      id: i,
      reader: stream.getReader(),
      busy: false,
      end: false,
    };
  });

  let lastReaderId: number | null = null;

  // Return a new ReadableStream that pulls from the individual stream readers in a round-robin fashion.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      /**
       * Repeatedly pick the next available stream, read a chunk from it, and add that chunk to the multiplexed output
       * This function is triggered by `pull()` AND by recursion whenever downstream readers are ready
       */
      if (!downstreamIsReady(controller.desiredSize)) return;

      // Pick the next available stream reader
      const currentReader =
        lastReaderId === null
          ? readerById[0]!
          : getNextReader(readerById, lastReaderId)!;

      // Base case. Every stream ended. We're done muxing!
      if (currentReader === 'all-done') {
        return controller.close();
      }

      // Corner case. Every stream is busy. Wait for the next call to `pull()`.
      if (currentReader === 'all-busy') {
        return;
      }

      // Get the reader details
      lastReaderId = currentReader.id;

      // Mark this reader busy until `reader.read()` resolves
      currentReader.busy = true;

      /**
       * Read from this stream, asynchronously.
       *
       * Important: We don't `await` this, because `reader.read()` may be a very slow promise.
       * Waiting for the response would pause reading for ALL streams.
       * Instead, we continue calling `attemptNextRead()` for streams which are available.
       */
      (async () => {
        // Read a chunk from the reader
        const result = await currentReader.reader.read();
        currentReader.busy = false;

        if (!result.done) {
          // This stream is not done and has a value we need to mux.
          // Prepare the chunk for the muxed output. This serializes the data into a byte array, and prepends a metadata header.
          const byteChunk = serializeChunk({
            id: currentReader.id,
            end: false,
            value: result.value,
          });

          // Write it to the muxed output
          controller.enqueue(byteChunk);
        } else {
          // This incoming stream is finished
          // Mark this incoming stream as done, so we no longer attempt to read from it.
          currentReader.end = true;

          // Release our reader's lock to the incoming stream
          currentReader.reader.releaseLock();

          // Send one last chunk into the muxer's output to signal that this stream is done.
          const byteChunk = serializeChunk({
            id: currentReader.id,
            end: true,
            value: 0x03, // "end of text" control code
          });
          controller.enqueue(byteChunk);
        }
      })();
    },

    // Cancel incoming streams if the muxer stream is canceled.
    cancel(reason) {
      Object.values(readerById).forEach(({ reader }) => {
        reader.cancel(`The muxer stream was canceled: ${reason}`);
      });
    },
  });
};
