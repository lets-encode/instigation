import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	copyMetadata,
	createEncodedPiece,
	createPiece,
	formatRanges,
	initialPieces,
	nextPieceId,
	overlappingPiece,
	pagesCovered,
	pieceColour,
	pieceForBox,
	partitionPages,
	zonesOverlap,
	PIECE_COLOURS,
	type Piece
} from '../pieces.ts';

const box = (ulx: number, uly: number, lrx: number, lry: number) => ({ ulx, uly, lrx, lry });

function facsimilePiece(id: string, zones: Piece['zones']): Piece {
	return { ...createPiece([], 'facsimile'), id, zones };
}

test('numbers piece ids in sequence, skipping ones already taken', () => {
	assert.equal(nextPieceId([]), 'piece-01');
	const one = createPiece([]);
	assert.equal(one.id, 'piece-01');
	assert.equal(nextPieceId([one]), 'piece-02');
	// A gap left by a removed piece must not produce a duplicate id.
	const kept = { ...one, id: 'piece-02' };
	assert.equal(nextPieceId([kept]), 'piece-03');
});

test('cycles colours once there are more pieces than hues', () => {
	assert.equal(pieceColour(0), 'var(--zone-1)');
	assert.equal(pieceColour(PIECE_COLOURS - 1), `var(--zone-${PIECE_COLOURS})`);
	assert.equal(pieceColour(PIECE_COLOURS), 'var(--zone-1)');
});

test('copies metadata without sharing the contributor objects', () => {
	const original = createPiece([]).meta;
	original.title = 'First piece';
	original.contributors = [{ name: 'A. Editor', role: 'editor' }];
	const copy = copyMetadata(original);
	copy.title = 'Second piece';
	copy.contributors[0].name = 'B. Editor';
	assert.equal(original.title, 'First piece');
	assert.equal(original.contributors[0].name, 'A. Editor');
});

test('copies only the fields a piece can own', () => {
	const original = createPiece([]).meta;
	original.title = 'First piece';
	original.composer = 'L. van Beethoven';
	original.lyricist = 'J. W. von Goethe';
	original.note = 'Shared note.';
	original.publisher = 'Breitkopf & Härtel';
	original.date = '1802';
	original.shelfmark = 'Mus.Hs.16481';
	const copy = copyMetadata(original);
	assert.equal(copy.composer, 'L. van Beethoven');
	assert.equal(copy.lyricist, 'J. W. von Goethe');
	assert.equal(copy.note, 'Shared note.');
	assert.equal(copy.title, '');
	assert.equal(copy.publisher, '');
	assert.equal(copy.date, '');
	assert.equal(copy.shelfmark, '');
});

test('lists the pages a piece covers, deduplicated and in order', () => {
	const piece = facsimilePiece('piece-01', [
		{ surface: 2, ...box(0, 0, 10, 10) },
		{ surface: 0, ...box(0, 0, 10, 10) },
		{ surface: 2, ...box(20, 20, 30, 30) }
	]);
	assert.deepEqual(pagesCovered(piece), [0, 2]);
});

test('writes page numbers as ranges', () => {
	assert.equal(formatRanges([]), '');
	assert.equal(formatRanges([4]), '4');
	assert.equal(formatRanges([1, 2, 3]), '1–3');
	assert.equal(formatRanges([1, 2, 4]), '1–2, 4');
	assert.equal(formatRanges([1, 3, 5]), '1, 3, 5');
	assert.equal(
		formatRanges(Array.from({ length: 34 }, (_, i) => i + 1)),
		'1–34',
		'one unbroken run stays one range'
	);
});

test('two regions overlap only where they share area on the same page', () => {
	const a = { surface: 0, ...box(0, 0, 100, 100) };
	assert.equal(zonesOverlap(a, { surface: 0, ...box(50, 50, 150, 150) }), true);
	assert.equal(zonesOverlap(a, { surface: 1, ...box(50, 50, 150, 150) }), false, 'another page');
	assert.equal(zonesOverlap(a, { surface: 0, ...box(100, 0, 200, 100) }), false, 'edge to edge');
});

test('finds the other piece a region overlaps', () => {
	const pieces = [
		facsimilePiece('piece-01', [{ surface: 0, ...box(0, 0, 100, 200) }]),
		facsimilePiece('piece-02', [{ surface: 0, ...box(100, 0, 200, 200) }])
	];
	// Its own regions never count as a clash.
	assert.equal(overlappingPiece(pieces, 0, { surface: 0, ...box(0, 0, 100, 200) }), -1);
	assert.equal(overlappingPiece(pieces, 0, { surface: 0, ...box(90, 0, 150, 200) }), 1);
	assert.equal(overlappingPiece(pieces, 0, { surface: 1, ...box(0, 0, 200, 200) }), -1);
});

test('assigns a measure box to the piece whose region contains its centre', () => {
	const pieces = [
		facsimilePiece('piece-01', [{ surface: 0, ...box(0, 0, 100, 100) }]),
		facsimilePiece('piece-02', [{ surface: 0, ...box(100, 0, 200, 100) }])
	];
	assert.equal(pieceForBox(pieces, 0, box(10, 10, 40, 40)), 0);
	assert.equal(pieceForBox(pieces, 0, box(150, 10, 180, 40)), 1);
});

test('keeps a box whose edges spill past the region it is centred in', () => {
	const pieces = [facsimilePiece('piece-01', [{ surface: 0, ...box(0, 0, 100, 100) }])];
	assert.equal(pieceForBox(pieces, 0, box(90, 90, 130, 130)), -1, 'centre outside → unassigned');
	assert.equal(pieceForBox(pieces, 0, box(80, 80, 110, 110)), 0, 'centre inside → assigned');
});

test('reports no piece for a box on a page no region covers', () => {
	const pieces = [facsimilePiece('piece-01', [{ surface: 0, ...box(0, 0, 100, 100) }])];
	assert.equal(pieceForBox(pieces, 1, box(10, 10, 40, 40)), -1);
});

test('partitions detected boxes between the pieces that contain them', () => {
	// Two pieces split page 0 left/right; piece-01 also covers page 1.
	const pieces = [
		facsimilePiece('piece-01', [
			{ surface: 0, ...box(0, 0, 100, 200) },
			{ surface: 1, ...box(0, 0, 200, 200) }
		]),
		facsimilePiece('piece-02', [{ surface: 0, ...box(100, 0, 200, 200) }])
	];
	const detected = [
		{
			image: 'img/01.jpg',
			width: 200,
			height: 200,
			boxes: [box(10, 10, 40, 40), box(150, 10, 180, 40), box(400, 400, 450, 450)]
		},
		{ image: 'img/02.jpg', width: 200, height: 200, boxes: [box(20, 20, 60, 60)] }
	];
	const split = partitionPages(pieces, detected);

	assert.deepEqual(
		split[0].pages.map((p) => [p.image, p.measures.length]),
		[
			['img/01.jpg', 1],
			['img/02.jpg', 1]
		]
	);
	assert.deepEqual(
		split[1].pages.map((p) => [p.image, p.measures.length]),
		[['img/01.jpg', 1]]
	);
	// The box at (400,400) sits in no region and is dropped by both.
	const kept = split.reduce((n, s) => n + s.pages.reduce((m, p) => m + p.measures.length, 0), 0);
	assert.equal(kept, 3);
});

test('measured surfaces are numbered within the piece, not the source', () => {
	// The piece covers the source's pages 2 and 3 only.
	const pieces = [
		facsimilePiece('piece-01', [
			{ surface: 1, ...box(0, 0, 200, 200) },
			{ surface: 2, ...box(0, 0, 200, 200) }
		])
	];
	const blank = { image: 'img/01.jpg', width: 200, height: 200, boxes: [] };
	const detected = [
		blank,
		{ image: 'img/02.jpg', width: 200, height: 200, boxes: [] },
		{ image: 'img/03.jpg', width: 200, height: 200, boxes: [box(10, 10, 40, 40)] }
	];
	const [split] = partitionPages(pieces, detected);
	// Its own pages are 1 and 2; only its second page carries measures.
	assert.equal(split.pages.length, 2);
	assert.deepEqual(split.measuredSurfaces, [2]);
});

test('an encoded piece takes no pages', () => {
	const pieces = [{ ...createPiece([], 'encoded'), encodingName: 'a.mei' }];
	const detected = [{ image: 'img/01.jpg', width: 10, height: 10, boxes: [box(1, 1, 5, 5)] }];
	assert.deepEqual(partitionPages(pieces, detected), [{ pages: [], measuredSurfaces: [] }]);
});

test('starts a facsimile-only campaign with one piece', () => {
	const pieces = initialPieces([], true);
	assert.equal(pieces.length, 1);
	assert.equal(pieces[0].kind, 'facsimile');
	assert.deepEqual(pieces[0].zones, []);
});

test('createEncodedPiece links the upload and takes its title from the file name', () => {
	const existing = [createPiece([], 'physical-only')];
	const piece = createEncodedPiece(existing, 'sonata.musicxml');
	assert.equal(piece.kind, 'encoded');
	assert.equal(piece.encodingName, 'sonata.musicxml');
	assert.equal(piece.meta.title, 'sonata');
	assert.equal(piece.id, 'piece-02');
});

test('starts one encoded piece per upload, titled from the file name', () => {
	const pieces = initialPieces(['prelude.musicxml', 'fugue.mei'], false);
	assert.deepEqual(
		pieces.map((p) => [p.id, p.kind, p.meta.title, p.encodingName]),
		[
			['piece-01', 'encoded', 'prelude', 'prelude.musicxml'],
			['piece-02', 'encoded', 'fugue', 'fugue.mei']
		]
	);
});

test('combines encoded uploads with a facsimile piece for the page images', () => {
	const pieces = initialPieces(['prelude.musicxml'], true);
	assert.deepEqual(
		pieces.map((p) => p.kind),
		['encoded', 'facsimile']
	);
});

test('seeds one physical piece when there is neither an encoding nor an image', () => {
	const pieces = initialPieces([], false);
	assert.equal(pieces.length, 1);
	assert.equal(pieces[0].kind, 'physical-only');
	assert.equal(pieces[0].zones.length, 0);
});

test('encodings without images seed no physical piece alongside them', () => {
	const pieces = initialPieces(['sonata.mei'], false);
	assert.deepEqual(
		pieces.map((piece) => piece.kind),
		['encoded']
	);
});
