import { HEADER_LENGTH, arrayToHeader, deserializeData } from './helpers';
import type { ChunkData } from './types';

/**
 * The chunks that demuxer receives are sometimes not the same as the chunks muxer sends...
 * Specifically, the chunks that demuxer receives might be multiple chunks from muxer, but concatenated.
 *
 * This function splits the big concatenated chunk into the actual chunks muxer sent (we need the same format).
 * We know where the concatenations happen because we have a special code at the start of each chunk's header: `0x01`.
 */
function getMuxedChunks(chunk: Uint8Array): Uint8Array[] {
  const muxedChunks: number[][] = [];

  let headerBytesRemaining = 0;
  chunk.forEach((byte) => {
    // 'Start Heading' control code. This means there's a new header, which also means a new chunk!
    if (byte === 0x01) {
      // Create new muxed chunk
      const muxedChunk: number[] = [byte];
      muxedChunks.push(muxedChunk);
      // We want to read the rest of the header
      headerBytesRemaining = HEADER_LENGTH;
    } else if (headerBytesRemaining > 0) {
      // Read more of the header into the current chunk
      muxedChunks[muxedChunks.length - 1].push(byte);
      headerBytesRemaining = headerBytesRemaining - 1;
    } else {
      // This byte must the body, since we're no longer in the header.
      muxedChunks[muxedChunks.length - 1].push(byte);
    }
  });

  // Convert each muxedChunk back to a Uint8Array
  return muxedChunks.map((muxedChunk) => new Uint8Array(muxedChunk));
}

/**
 * Demultiplexes a stream and returns the original streams
 *
 * @param stream - the multiplexed stream
 * @param numberOfStreams - how many streams are being muxed
 * @returns the same array of ReadableStreams originally passed into muxer()
 */
export const demuxer = <
  DemuxedReadableStreams extends ReadableStream<ChunkData>[]
>(
  stream: ReadableStream<Uint8Array>,
  numberOfStreams: number
): DemuxedReadableStreams => {
  // A mapping of demuxed stream controllers, which we will use to write to and close the streams we resolved.
  const demuxedStreamControllerById: Map<
    number,
    { demuxedStreamController: ReadableStreamDefaultController<ChunkData> }
  > = new Map();

  // Create an array of demuxed streams to match what was originally passed into muxer()
  const demuxedReadableStreams: ReadableStream<ChunkData>[] = Array.from({
    length: numberOfStreams,
  }).map(
    (_, index) =>
      new ReadableStream<ChunkData>({
        start(newController) {
          demuxedStreamControllerById.set(index, {
            demuxedStreamController: newController,
          });
        },
      })
  );

  // Pipe this input stream into a WritableStream which recreates the original streams and emits them as events when they start writing
  stream.pipeTo(
    new WritableStream<Uint8Array>({
      async write(chunk) {
        // The chunk received here may be a concatenation of multiple chunks from `muxer` (network pipes may buffer them together).
        // Split up the chunks so they match the original chunks we enqueued in `muxer`.
        const muxedChunks = getMuxedChunks(chunk);

        muxedChunks.forEach((muxedChunk: Uint8Array) => {
          // Read the header, which is a byte array of metadata prepended to the chunk
          const header = arrayToHeader(muxedChunk);

          // Get this demuxed stream's controller
          const { demuxedStreamController } = demuxedStreamControllerById.get(
            header.id
          )!;

          if (header.end) {
            // If this chunk represents the end of the stream, close the controller.
            demuxedStreamController.close();
          } else {
            // Get the data portion of this muxedChunk (i.e., slice the header out)
            const data = muxedChunk.slice(HEADER_LENGTH);

            // Deserialize the data
            const { value } = deserializeData({
              data,
              isRaw: header.dataIsRaw,
            });

            // Otherwise, enqueue the muxedChunk to the appropriate stream.
            demuxedStreamController.enqueue(value);
          }
        });
      },
      close() {},
      abort(error: string) {
        const formattedError = `The demuxer stream was aborted: ${error}`;
        for (const [
          id,
          { demuxedStreamController },
        ] of demuxedStreamControllerById.entries()) {
          demuxedStreamController.error(formattedError);
        }
      },
    })
  );

  return demuxedReadableStreams as DemuxedReadableStreams;
};
