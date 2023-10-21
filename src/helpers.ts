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
    throw new Error(`Bad header: [${array.toString()}]`);
  }

  if (dv.getUint8(0) !== 0x01) {
    throw new Error(`Expected header control code 0x01, got ${dv.getUint8(0)}`);
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
  let decodedValue;
  let isRaw;

  if (value instanceof Uint8Array) {
    // If it's a Uint8Array, encode it as an Array for serialization
    decodedValue = Array.from(value);
    // And mark that it's raw in the chunk header so it can be revived in `deserializeData`
    isRaw = true;
  } else {
    decodedValue = value;
    isRaw = false;
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(decodedValue));
  return { data, isRaw };
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
  let value;

  // Decode the data into the original value
  const decoder = new TextDecoder();
  const decodedValue = JSON.parse(decoder.decode(data));

  if (isRaw) {
    // If it's marked raw, then it's a Uint8Array
    value = new Uint8Array(decodedValue);
  } else {
    value = decodedValue;
  }

  return { value };
}
