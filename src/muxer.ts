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
  const readers = Object.values(readerById);

  // The minimum value for the next reader ID, wrapping around to the first reader if necessary.
  const minimumNextId = (lastReaderId + 1) % readers.length;

  // Return the next stream reader, if there is one
  for (const candidate of readers) {
    if (candidate.end) continue;
    if (candidate.busy) continue;
    if (candidate.id >= minimumNextId) {
      return candidate;
    }
  }

  // There's no next reader... Try the current reader
  const current = readerById[lastReaderId]!;
  if (!current.end && !current.busy) {
    // The current stream is still going - keep going!
    return current;
  }

  // Every stream finished. No need to select another reader because we're done!
  if (readers.every((reader) => reader.end)) {
    return 'all-done';
  }

  // Every stream is busy. Don't select another reader - just wait.
  return 'all-busy';
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
}: Omit<Header, 'dataIsRaw'> & { value: SerializableData }): Uint8Array | null {
  const { data, isRaw } = serializeData({ value });

  // No data in this chunk; skip writing anything at all
  if (data.length === 0) {
    return null;
  }

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
      if (downstreamIsReady(controller.desiredSize)) {
        attemptNextRead();
      }

      /**
       * Repeatedly pick the next available stream, read a chunk from it, and add that chunk to the multiplexed output
       * This function is triggered by `pull()` AND by recursion whenever downstream readers are ready
       */
      function attemptNextRead() {
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
        const { id, reader } = currentReader;
        lastReaderId = id;

        /**
         * Read from this stream, asynchronously.
         *
         * Important: We don't `await` this, because `reader.read()` may be a very slow promise.
         * Waiting for the response would pause reading for ALL streams.
         * Instead, we continue calling `attemptNextRead()` for streams which are available.
         *
         * Important: We need to contiue calling the `attemptNextRead()` function while downstream readers are ready.
         * Instead of running a while loop (which wouldn't work with this async function),
         * this async function calls `attemptNextRead()` recursively.
         */
        (async () => {
          // Read a chunk from the reader
          currentReader.busy = true;
          const result = await reader.read();
          currentReader.busy = false;

          if (!result.done) {
            // This stream is not done and has a value we need to mux.
            // Prepare the chunk for the muxed output. This serializes the data into a byte array, and prepends a metadata header.
            const byteChunk = serializeChunk({
              id,
              end: result.done,
              value: result.value,
            });

            // If the byteChunk is not empty (sometimes streams have empty chunks)
            if (byteChunk) {
              // Write it to the muxed output
              controller.enqueue(byteChunk);
            }

            // If the downstream consumers are ready for more data
            if (downstreamIsReady(controller.desiredSize)) {
              // Recurse (read from the next available incoming stream)
              attemptNextRead();
            }
          } else {
            // This incoming stream is finished
            // Release our reader's lock to the incoming stream
            reader.releaseLock();

            // Mark this incoming stream as done, so we no longer attempt to read from it.
            readerById[id] = { ...readerById[id]!, end: true };

            // Send one last chunk into the muxer's output to signal that this stream is done.
            const byteChunk = serializeChunk({
              id,
              end: true,
              value: '\u0004', // arbitrarily chosen; value just needs to have length > 0 to distinguish cases
            });
            controller.enqueue(byteChunk!);
          }
        })();
      }
    },

    // Cancel incoming streams if the muxer stream is canceled.
    cancel(reason) {
      Object.values(readerById).forEach(({ reader }) =>
        reader.cancel(`The muxer stream was canceled: ${reason}`),
      );
    },
  });
};
