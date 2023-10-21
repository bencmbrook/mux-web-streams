import type { Header, SerializableData } from './types.js';

export const HEADER_LENGTH = 4; // bytes
const NUMBER_OFFSET = 5;

// Maximum acceptable numbers
const MAX_UINT8 = 2 ** 8 - 1 - NUMBER_OFFSET;

/**
 * This helper function converts a header to a Uint8Array.
 * It uses the DataView API to write the header fields into an ArrayBuffer,
 * then creates a Uint8Array view of the buffer.
 */
export function headerToArray(header: Header): Uint8Array {
  if (header.id > MAX_UINT8 || header.id < 0) {
    throw Error(`stream 'id' must be a number between 0 and ${MAX_UINT8}`);
  }

  const buffer = new ArrayBuffer(HEADER_LENGTH);
  const dv = new DataView(buffer);

  // Start Heading control code
  dv.setUint8(0, 0x01);

  // Add header data (offset to avoid conflicts with control code)
  dv.setUint8(1, header.id + NUMBER_OFFSET);
  dv.setUint8(2, Number(header.end) + NUMBER_OFFSET);
  dv.setUint8(3, Number(header.dataIsRaw) + NUMBER_OFFSET);

  return new Uint8Array(buffer);
}

/**
 * This helper function converts a Uint8Array to a Header.
 * It uses the DataView API to read the header fields from the array's buffer.
 */
export function arrayToHeader(array: Uint8Array): Header {
  const dv = new DataView(array.buffer);
  if (dv.byteLength < HEADER_LENGTH) {
    console.error('Bad header', dv.buffer);
  }

  return {
    // Extract header data
    id: dv.getUint8(1) - NUMBER_OFFSET,
    end: Boolean(dv.getUint8(2) - NUMBER_OFFSET),
    dataIsRaw: Boolean(dv.getUint8(3) - NUMBER_OFFSET),
  };
}

/**
 * Serialize the chunk value for the `data` portion of the byte array
 */
export function serializeData({ value }: { value: SerializableData }): {
  data: Uint8Array;
  isRaw: boolean;
} {
  if (value instanceof Uint8Array) {
    // Don't transform if this is already a buffer
    return { data: value, isRaw: true };
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(value));
  return { data, isRaw: false };
}

/**
 * Deserialize the `data` portion of the byte array
 */
export function deserializeData({
  data,
  isRaw,
}: {
  data: Uint8Array;
  isRaw: boolean;
}): { value: SerializableData } {
  if (isRaw) {
    return { value: data };
  }

  // Decode the data into the original value
  const decoder = new TextDecoder();
  const str = decoder.decode(data);

  // Parse JSON into an object where applicable
  let value;
  try {
    value = JSON.parse(str);
  } catch {
    value = str;
  }

  return { value };
}
