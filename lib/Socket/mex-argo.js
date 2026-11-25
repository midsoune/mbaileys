"use strict"

/**
 * Argo decoder for WhatsApp MEX (`<result format="argo">`) payloads.
 *
 * WhatsApp MEX replies can be Argo messages instead of JSON. The captured
 * responses start with the header byte 0x04, whose bitset value is 2
 * (`FLAG_SELF_DESCRIBING`): the `data` value is encoded with self-describing
 * (DESC) markers, so no wire schema is needed.
 *
 * The layout implemented here is the one produced by WhatsApp and read by the
 * MEX decoder in zapo-js (same author as `argo-codec`):
 *
 *   header(bitset) [user-flags(bitset)]
 *   block segment* (each = label length + bytes)
 *   core segment  (label length + bytes)
 *
 *   core = DESC data, then [error-count, ERROR*]
 *
 * Block segments carry no names on the wire. They are emitted in first-use
 * order, so a block is bound to the next unused segment the first time a DESC
 * marker needs it. This mirrors `argo-codec`'s DecoderState.block().
 *
 * DESC markers:
 *   -1 null, 0 false, 1 true, 2 object, 3 list,
 *    4 string, 5 bytes, 6 int, 7 float
 *
 * Labels are zig-zag varints: -1 null, -2 absent, -3 inline error, and
 * back-references start at -4 (`index = -label - 4`).
 *
 * This module is dependency-free but intentionally mirrors the label/bitset
 * primitives of `argo-codec` so it works whether or not that package is
 * installed.
 */

const LABEL_NULL = -1
const LABEL_ABSENT = -2
const LABEL_ERROR = -3
const LABEL_NON_NULL = 0
const BACKREF_BASE = -4

const DESC_NULL = -1
const DESC_FALSE = 0
const DESC_TRUE = 1
const DESC_OBJECT = 2
const DESC_LIST = 3
const DESC_STRING = 4
const DESC_BYTES = 5
const DESC_INT = 6
const DESC_FLOAT = 7

const FLAG_INLINE_EVERYTHING = 1 << 0
const FLAG_SELF_DESCRIBING = 1 << 1
const FLAG_OUT_OF_BAND_FIELD_ERRORS = 1 << 2
const FLAG_SELF_DESCRIBING_ERRORS = 1 << 3
const FLAG_NULL_TERMINATED_STRINGS = 1 << 4
const FLAG_NO_DEDUPLICATION = 1 << 5
const FLAG_HAS_USER_FLAGS = 1 << 6

const TEXT_DECODER = new TextDecoder("utf-8")

/** Minimal Reader mirroring argo-codec's Reader (varint / zig-zag / bitset). */
class Reader {
	constructor(arr, pos = 0, end = arr.length) {
		this.arr = arr
		this.pos = pos
		this.end = end
		this.view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength)
	}

	byte() {
		if (this.pos >= this.end) throw new RangeError("argo: unexpected end of buffer")
		return this.arr[this.pos++]
	}

	bytes(n) {
		if (!Number.isInteger(n) || n < 0) {
			throw new RangeError(`argo: invalid length ${n}`)
		}
		if (this.pos + n > this.end) {
			throw new RangeError(`argo: read ${n} byte(s) past end of buffer (${this.end - this.pos} left)`)
		}
		const out = this.arr.subarray(this.pos, this.pos + n)
		this.pos += n
		return out
	}

	f64() {
		if (this.pos + 8 > this.end) throw new RangeError("argo: read f64 past end of buffer")
		const out = this.view.getFloat64(this.pos, true)
		this.pos += 8
		return out
	}

	uvarint() {
		let n = 0
		let shift = 1
		let b
		do {
			if (this.pos >= this.end) throw new RangeError("argo: unexpected end of varint")
			b = this.arr[this.pos++]
			n += (b & 0x7f) * shift
			shift *= 128
		} while (b & 0x80)
		return n
	}

	label() {
		const z = this.uvarint()
		return z % 2 === 0 ? z / 2 : -((z + 1) / 2)
	}

	bitset() {
		let n = 0
		let bitPos = 0
		let more = true
		while (more) {
			if (this.pos >= this.end) throw new RangeError("argo: unexpected end of bitset")
			const byte = this.arr[this.pos++]
			n += (byte >> 1) * 2 ** bitPos
			bitPos += 7
			more = (byte & 1) === 1
		}
		return n
	}
}

function toBytes(content) {
	if (Buffer.isBuffer(content) || content instanceof Uint8Array) return content
	if (content instanceof ArrayBuffer) return new Uint8Array(content)
	throw new TypeError(`argo: expected Buffer/Uint8Array, got ${typeof content}`)
}

function decodeMexArgo(content) {
	const bytes = toBytes(content)
	if (bytes.length === 0) throw new Error("argo: empty MEX payload")

	const r = new Reader(bytes)
	const flags = r.bitset()

	if (flags & FLAG_OUT_OF_BAND_FIELD_ERRORS) {
		throw new Error("argo: OutOfBandFieldErrors payloads are not supported")
	}
	if (flags & FLAG_SELF_DESCRIBING_ERRORS) {
		throw new Error("argo: SelfDescribingErrors payloads are not supported")
	}
	if (flags & FLAG_HAS_USER_FLAGS) r.bitset()

	const inline = (flags & FLAG_INLINE_EVERYTHING) !== 0
	const state = {
		core: null,
		blockSlices: [],
		nextBlockIdx: 0,
		blocks: new Map(),
		inline,
		nullTerminated: (flags & FLAG_NULL_TERMINATED_STRINGS) !== 0,
		dedupe: (flags & FLAG_NO_DEDUPLICATION) === 0
	}

	if (inline) {
		state.core = r
	} else {
		const slices = []
		while (r.pos < r.end) {
			const len = r.label()
			slices.push(new Reader(r.bytes(len)))
		}
		if (slices.length === 0) throw new Error("argo: missing core segment")
		state.core = slices[slices.length - 1]
		state.blockSlices = slices.slice(0, -1)
	}

	const data = readDesc(state)
	const errors = []

	if (state.core.pos < state.core.end) {
		const count = state.core.label()
		if (count < 0) throw new Error(`argo: invalid error count ${count}`)
		for (let i = 0; i < count; i++) errors.push(readMexError(state))
	}

	return {
		data,
		errors,
		flags,
		selfDescribing: (flags & FLAG_SELF_DESCRIBING) !== 0,
		trailing: state.core.end - state.core.pos
	}
}

function getBlock(state, key, dedupe) {
	let block = state.blocks.get(key)
	if (block) return block

	if (state.inline) {
		block = { reader: state.core, inline: true, dedupe, seen: [] }
	} else {
		const reader = state.blockSlices[state.nextBlockIdx++]
		if (!reader) {
			throw new Error(
				`argo: block '${key}' has no segment (payload has ${state.blockSlices.length} block segment(s))`
			)
		}
		block = { reader, inline: false, dedupe, seen: [] }
	}

	state.blocks.set(key, block)
	return block
}

function readStringFromBlock(state, block) {
	const label = state.core.label()

	if (label <= BACKREF_BASE) {
		const index = -label + BACKREF_BASE
		if (index >= block.seen.length) {
			throw new Error(`argo: string back-reference ${label} is out of range`)
		}
		return block.seen[index]
	}
	if (label < 0) {
		throw new Error(`argo: unexpected string label ${label}`)
	}

	const data = block.inline ? state.core.bytes(label) : block.reader.bytes(label)
	if (state.nullTerminated) {
		if (block.inline) state.core.pos++
		else block.reader.pos++
	}

	const value = TEXT_DECODER.decode(data)
	if (block.dedupe) block.seen.push(value)
	return value
}

function readBytesFromBlock(state, block) {
	const label = state.core.label()

	if (label <= BACKREF_BASE) {
		const index = -label + BACKREF_BASE
		if (index >= block.seen.length) {
			throw new Error(`argo: bytes back-reference ${label} is out of range`)
		}
		return block.seen[index]
	}
	if (label < 0) {
		throw new Error(`argo: unexpected bytes label ${label}`)
	}

	const data = block.inline ? state.core.bytes(label) : block.reader.bytes(label)
	if (block.dedupe) block.seen.push(data)
	return data
}

function readDesc(state) {
	const marker = state.core.label()

	switch (marker) {
		case DESC_NULL:
			return null
		case DESC_FALSE:
			return false
		case DESC_TRUE:
			return true
		case DESC_STRING:
			return readStringFromBlock(state, getBlock(state, "String", true))
		case DESC_BYTES:
			return readBytesFromBlock(state, getBlock(state, "Bytes", true))
		case DESC_INT:
			return getBlock(state, "Int", false).reader.label()
		case DESC_FLOAT:
			return getBlock(state, "Float", false).reader.f64()
		case DESC_LIST: {
			const count = state.core.label()
			if (count < 0) throw new Error(`argo: invalid list length ${count}`)
			const out = new Array(count)
			for (let i = 0; i < count; i++) out[i] = readDesc(state)
			return out
		}
		case DESC_OBJECT: {
			const count = state.core.label()
			if (count < 0) throw new Error(`argo: invalid object size ${count}`)
			const block = getBlock(state, "String", true)
			const out = {}
			for (let i = 0; i < count; i++) {
				const key = readStringFromBlock(state, block)
				out[key] = readDesc(state)
			}
			return out
		}
		default:
			throw new Error(`argo: unknown self-describing marker ${marker}`)
	}
}

/**
 * MEX request error, encoded after `data` in the core segment:
 *   message:    String
 *   location?:  NULLABLE(ARRAY<{ line: Int, column: Int }>)
 *   path?:      NULLABLE(VARINT)
 *   extensions?: NULLABLE(DESC)
 */
function readMexError(state) {
	const message = readStringFromBlock(state, getBlock(state, "String", true))

	const locationLabel = state.core.label()
	let location = null
	if (locationLabel !== LABEL_ABSENT && locationLabel !== LABEL_NULL) {
		if (locationLabel < 0) {
			throw new Error(`argo: unexpected error location label ${locationLabel}`)
		}
		location = new Array(locationLabel)
		for (let i = 0; i < locationLabel; i++) {
			location[i] = {
				line: getBlock(state, "Int", false).reader.label(),
				column: getBlock(state, "Int", false).reader.label()
			}
		}
	}

	const pathLabel = state.core.label()
	const path = pathLabel === LABEL_ABSENT || pathLabel === LABEL_NULL ? null : pathLabel

	const extensionsLabel = state.core.label()
	let extensions = null
	if (extensionsLabel !== LABEL_ABSENT && extensionsLabel !== LABEL_NULL) {
		// NULLABLE of an unlabeled type consumes the non-null marker (0), then DESC.
		if (extensionsLabel !== LABEL_NON_NULL) {
			throw new Error(`argo: unexpected error extensions label ${extensionsLabel}`)
		}
		extensions = readDesc(state)
	}

	return { message, location, path, extensions }
}

function formatArgoErrors(errors) {
	return errors
		.map((error, index) => {
			const message = error.message || "Unknown error"
			const path = Array.isArray(error.path)
				? ` @${error.path.join(".")}`
				: error.path !== null && error.path !== undefined
					? ` @${error.path}`
					: ""
			const extensions = error.extensions ? ` ${safeStringify(error.extensions)}` : ""
			return `#${index + 1} ${message}${path}${extensions}`
		})
		.join("; ")
}

function safeStringify(value) {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** True when the binary content is not JSON text (i.e. an Argo message). */
function isBinaryArgoPayload(content) {
	if (typeof content === "string") return false
	if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) return false
	if (content.length === 0) return false
	// JSON text starts with '{', '[' or whitespace; Argo starts with a header byte.
	const first = content[0]
	return (
		first !== 0x7b &&
		first !== 0x5b &&
		first !== 0x20 &&
		first !== 0x0a &&
		first !== 0x0d &&
		first !== 0x09
	)
}

module.exports = {
	decodeMexArgo,
	formatArgoErrors,
	isBinaryArgoPayload,
	Reader
}
