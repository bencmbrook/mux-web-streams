/**
 * The header prepended to each chunk passed by the muxer to the demuxer
 * This is serialized/deserialized to binary when transmitted
 */
export type Header = {
  /** An ID for the muxed stream. A number between 0 and 255, or 2^8-1 */
  id: number;
  /** Whether the stream has finished */
  end: boolean;
  /** Whether the chunk is intended to be a raw Uint8Array (and shouldn't be deserialized) */
  dataIsRaw: boolean;
};

type JSONValue = string | number | boolean | null | JSONObject | JSONArray;
type JSONObject = { [member: string]: JSONValue };
interface JSONArray extends Array<JSONValue> {}

/**
 * Acceptable datatypes to send over the stream
 */
export type SerializableData = JSONValue | Uint8Array;
