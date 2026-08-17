import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { maybeGunzip } from './tokenize';

/**
 * Regression tests for the dictionary loader.
 *
 * Whether the dictionary arrives compressed depends on who serves it:
 * adapter-node's sirv sets `Content-Encoding: gzip` from the `.gz` extension so
 * fetch inflates transparently, while Vite's dev server does not. Decompressing
 * unconditionally worked locally and failed in production with an opaque
 * AbortError. Sniffing the magic number is what makes it survive both.
 */

const bytes = (b: Buffer): ArrayBuffer =>
	b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const decode = (buf: ArrayBufferLike) => new TextDecoder().decode(new Uint8Array(buf));

describe('maybeGunzip', () => {
	it('inflates data that is still gzipped (vite dev server)', async () => {
		const payload = 'ダミー辞書データ';
		const out = await maybeGunzip(bytes(gzipSync(Buffer.from(payload, 'utf8'))));
		expect(decode(out)).toBe(payload);
	});

	it('passes through data the transport already inflated (adapter-node)', async () => {
		const payload = 'ダミー辞書データ';
		const raw = bytes(Buffer.from(payload, 'utf8'));
		const out = await maybeGunzip(raw);
		expect(decode(out)).toBe(payload);
	});

	it('does not mistake binary starting with zeros for gzip', async () => {
		// The real base.dat begins 00 00, which is what exposed the bug.
		const raw = bytes(Buffer.from([0x00, 0x00, 0x01, 0x02, 0x03]));
		const out = await maybeGunzip(raw);
		expect(new Uint8Array(out)).toEqual(new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]));
	});

	it('handles an empty response without throwing', async () => {
		const out = await maybeGunzip(new ArrayBuffer(0));
		expect(out.byteLength).toBe(0);
	});
});
