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
    this._buffer = Buffer.alloc(0);
  }

  // Append a chunk and drain all complete frames. Each frame is
  // { raw: Buffer, body: Buffer } where `raw` is the full on-wire message
  // (headers + body) and `body` is just the JSON payload.
  push(chunk) {
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    const frames = [];

    for (;;) {
      const headerEnd = this._buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        break; // headers not fully received yet
      }

      const headerText = this._buffer.toString('ascii', 0, headerEnd);
      const contentLength = parseContentLength(headerText);
      if (contentLength === null) {
        // Malformed header block: drop it and resync past the separator
        // rather than wedging the stream forever.
        this._buffer = this._buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + contentLength;
      if (this._buffer.length < bodyEnd) {
        break; // body not fully received yet
      }

      frames.push({
        raw: this._buffer.subarray(0, bodyEnd),
        body: this._buffer.subarray(bodyStart, bodyEnd),
      });
      this._buffer = this._buffer.subarray(bodyEnd);
    }

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
