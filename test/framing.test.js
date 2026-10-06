'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { FrameReader } = require('../plugins/csharp-lsp/proxy/framing');

const CHUNK = 64 * 1024;

function frame(body) {
  return Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`, 'ascii'), Buffer.from(body, 'utf8')]);
}

test('a 4 MB frame arriving in 64 KB chunks is reassembled byte for byte and copied once', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ü'.repeat(2 * 1024 * 1024) });
  const wire = frame(body);
  const reader = new FrameReader();
  const concat = Buffer.concat;
  let copied = 0;
  Buffer.concat = (list, length) => {
    const out = concat.call(Buffer, list, length);
    copied += out.length;
    return out;
  };
  const frames = [];
  try {
    for (let i = 0; i < wire.length; i += CHUNK) frames.push(...reader.push(wire.subarray(i, i + CHUNK)));
  } finally {
    Buffer.concat = concat;
  }

  assert.strictEqual(frames.length, 1);
  assert.ok(frames[0].raw.equals(wire));
  assert.ok(frames[0].body.equals(Buffer.from(body, 'utf8')));
  assert.ok(copied <= 2 * wire.length, `copied ${copied} bytes to reassemble a ${wire.length}-byte frame`);
});

test('a malformed header is dropped and the frames after it are read, at every chunk size', () => {
  const first = frame(JSON.stringify({ jsonrpc: '2.0', method: 'first', params: { s: 'ü' } }));
  const second = frame(JSON.stringify({ jsonrpc: '2.0', method: 'second' }));
  const wire = Buffer.concat([Buffer.from('X-Bogus: 1\r\n\r\n', 'ascii'), first, second]);
  for (let size = 1; size <= wire.length; size++) {
    const reader = new FrameReader();
    const frames = [];
    for (let i = 0; i < wire.length; i += size) frames.push(...reader.push(wire.subarray(i, i + size)));

    assert.strictEqual(frames.length, 2, `chunk size ${size}`);
    assert.ok(frames[0].raw.equals(first), `chunk size ${size}`);
    assert.ok(frames[1].raw.equals(second), `chunk size ${size}`);
  }
});
