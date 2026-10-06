'use strict';

// Incremental reader for LSP's `Content-Length` wire framing:
//
//   Content-Length: <N>\r\n
//   [optional other headers]\r\n
//   \r\n
//   <N bytes of UTF-8 JSON>
//
// Bytes arrive in arbitrary chunks, so a single read may contain a partial
// header, multiple whole messages, or a body split across reads. `push` buffers
// raw bytes and returns every complete frame it can, leaving any remainder for
// the next call. Frames are returned as raw Buffers so callers can forward the
// exact bytes they received; the proxy must never re-encode a passed-through
// message.

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');

class FrameReader {
  constructor() {
    // Unconsumed bytes are kept as a chunk list and joined only when a frame
    // can complete, so a large body arriving in many chunks is copied once
    // instead of once per chunk.
    this._chunks = [];
    this._length = 0;
    this._needed = 0; // total buffered bytes required before the pending frame is complete
  }

  // Append a chunk and drain all complete frames. Each frame is
  // { raw: Buffer, body: Buffer } where `raw` is the full on-wire message
  // (headers + body) and `body` is just the JSON payload.
  push(chunk) {
    this._chunks.push(chunk);
    this._length += chunk.length;
    if (this._length < this._needed) {
      return []; // pending body still incomplete
    }

    let buffer = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._length);
    const frames = [];
    this._needed = 0;

    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        break; // headers not fully received yet
      }

      const headerText = buffer.toString('ascii', 0, headerEnd);
      const contentLength = parseContentLength(headerText);
      if (contentLength === null) {
        // Malformed header block: drop it and resync past the separator
        // rather than wedging the stream forever.
        buffer = buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) {
        this._needed = bodyEnd; // body not fully received yet
        break;
      }

      frames.push({
        raw: buffer.subarray(0, bodyEnd),
        body: buffer.subarray(bodyStart, bodyEnd),
      });
      buffer = buffer.subarray(bodyEnd);
    }

    this._chunks = buffer.length === 0 ? [] : [buffer];
    this._length = buffer.length;
    return frames;
  }
}

function parseContentLength(headerText) {
  for (const line of headerText.split('\r\n')) {
    const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

// Serialize a JS object into a framed LSP message (for the notifications we
// inject ourselves).
function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, json]);
}

module.exports = { FrameReader, encodeMessage };
