/**
 * cursor.js — Hotspot detection, CUR and ANI file format encoding.
 * All processing is client-side using Canvas and typed arrays.
 */

const CursorLib = (() => {
  // ─── Hotspot Detection ────────────────────────────────────────────

  /**
   * Detect the most likely hotspot (click-point / tip) of a cursor image.
   * Works by finding the "pointiest" edge pixel — the one with the fewest
   * opaque neighbours in a circular neighbourhood.
   *
   * @param {ImageData} imageData — RGBA pixel data
   * @returns {{x: number, y: number}} hotspot in pixel coordinates
   */
  function detectHotspot(imageData) {
    const { width, height, data } = imageData;

    // Build an alpha mask (true = opaque enough to count)
    const ALPHA_THRESHOLD = 30;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      mask[i] = data[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
    }

    // Quick bail: if the image is fully opaque or fully transparent
    let opaqueCount = 0;
    for (let i = 0; i < mask.length; i++) opaqueCount += mask[i];
    if (opaqueCount === 0) return { x: 0, y: 0 };
    if (opaqueCount === width * height) return { x: 0, y: 0 };

    // Find edge pixels (opaque pixels adjacent to at least one transparent pixel)
    const edges = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!mask[idx]) continue;
        // Check 4-neighbours for a transparent pixel
        const isEdge =
          x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
          !mask[idx - 1] || !mask[idx + 1] ||
          !mask[idx - width] || !mask[idx + width];
        if (isEdge) edges.push({ x, y });
      }
    }

    if (edges.length === 0) return { x: 0, y: 0 };

    // For each edge pixel, compute a "pointiness" score.
    // We count opaque pixels in a circular neighbourhood.
    // Fewer neighbours → more pointy.
    const R = Math.max(4, Math.round(Math.min(width, height) * 0.12));
    const R2 = R * R;

    let bestScore = Infinity;
    let candidates = [];

    for (const p of edges) {
      let count = 0;
      let total = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R2) continue;
          const nx = p.x + dx;
          const ny = p.y + dy;
          total++;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            count += mask[ny * width + nx];
          }
        }
      }
      const score = count / total; // lower = more pointy
      if (score < bestScore - 0.01) {
        bestScore = score;
        candidates = [p];
      } else if (Math.abs(score - bestScore) <= 0.01) {
        candidates.push(p);
      }
    }

    if (candidates.length === 0) return { x: 0, y: 0 };

    // Among equally pointy candidates, prefer top-left bias
    // (traditional cursor convention). We weight by distance from top-left.
    let best = candidates[0];
    let bestDist = best.x * 1.0 + best.y * 1.0; // simple manhattan-ish
    for (const c of candidates) {
      const d = c.x * 1.0 + c.y * 1.0;
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }

    return { x: best.x, y: best.y };
  }

  // ─── Image Resizing ───────────────────────────────────────────────

  /**
   * Resize an image (as HTMLImageElement or canvas) to the target size,
   * fitting within the square while maintaining aspect ratio and centering.
   * Returns a canvas of exactly targetSize × targetSize.
   *
   * @param {HTMLImageElement|HTMLCanvasElement} source
   * @param {number} targetSize
   * @returns {{ canvas: HTMLCanvasElement, offsetX: number, offsetY: number, scale: number }}
   */
  function resizeImage(source, targetSize) {
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');

    let sw = source.naturalWidth || source.width;
    let sh = source.naturalHeight || source.height;
    // SVGs may report 0 or default dimensions — fall back to square
    if (!sw || !sh) { sw = targetSize; sh = targetSize; }

    const scale = Math.min(targetSize / sw, targetSize / sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const ox = Math.round((targetSize - dw) / 2);
    const oy = Math.round((targetSize - dh) / 2);

    ctx.clearRect(0, 0, targetSize, targetSize);
    ctx.drawImage(source, ox, oy, dw, dh);

    return { canvas, offsetX: ox, offsetY: oy, scale };
  }

  // ─── CUR File Format ──────────────────────────────────────────────
  // A CUR file is almost identical to ICO but with type=2 and hotspot fields.
  // Modern CUR files can embed PNG data directly.

  /**
   * Build a .cur file from a canvas and hotspot.
   *
   * @param {HTMLCanvasElement} canvas — must be square, RGBA
   * @param {number} hotspotX
   * @param {number} hotspotY
   * @returns {Blob}
   */
  function buildCUR(canvas, hotspotX, hotspotY) {
    // Get PNG bytes from canvas
    const dataUrl = canvas.toDataURL('image/png');
    const pngBytes = dataURLToBytes(dataUrl);

    const size = canvas.width;
    // ICONDIR: 6 bytes  +  ICONDIRENTRY: 16 bytes  +  PNG data
    const fileSize = 6 + 16 + pngBytes.length;
    const buf = new ArrayBuffer(fileSize);
    const view = new DataView(buf);

    // ICONDIR
    view.setUint16(0, 0, true);          // reserved
    view.setUint16(2, 2, true);          // type = 2 (CUR)
    view.setUint16(4, 1, true);          // count = 1

    // ICONDIRENTRY
    view.setUint8(6, size >= 256 ? 0 : size);   // width (0 = 256)
    view.setUint8(7, size >= 256 ? 0 : size);   // height (0 = 256)
    view.setUint8(8, 0);                         // color count
    view.setUint8(9, 0);                         // reserved
    view.setUint16(10, hotspotX, true);          // hotspot X (CUR-specific)
    view.setUint16(12, hotspotY, true);          // hotspot Y (CUR-specific)
    view.setUint32(14, pngBytes.length, true);   // image data size
    view.setUint32(18, 22, true);                // offset to image data (6+16=22)

    // Copy PNG data
    const bytes = new Uint8Array(buf);
    bytes.set(pngBytes, 22);

    return new Blob([buf], { type: 'application/octet-stream' });
  }

  // ─── ANI File Format ──────────────────────────────────────────────
  // ANI is a RIFF container: RIFF 'ACON' { 'anih', 'rate', LIST 'fram' { 'icon' ... } }

  /**
   * Build an .ani file from multiple frames.
   *
   * @param {{ canvas: HTMLCanvasElement, hotspotX: number, hotspotY: number }[]} frames
   * @param {number} frameRate — frames per second
   * @returns {Blob}
   */
  function buildANI(frames, frameRate) {
    const numFrames = frames.length;

    // Build individual CUR blobs for each frame, then extract their bytes
    const curByteArrays = frames.map(f => {
      const blob = buildCURBytes(f.canvas, f.hotspotX, f.hotspotY);
      return blob;
    });

    // 'anih' chunk data: 36 bytes
    const anihSize = 36;
    const anihData = new ArrayBuffer(anihSize);
    const anihView = new DataView(anihData);
    anihView.setUint32(0, anihSize, true);   // cbSize (struct size)
    anihView.setUint32(4, numFrames, true);  // nFrames
    anihView.setUint32(8, numFrames, true);  // nSteps
    anihView.setUint32(12, 0, true);         // cx (0 = use icon size)
    anihView.setUint32(16, 0, true);         // cy
    anihView.setUint32(20, 0, true);         // cBitCount
    anihView.setUint32(24, 1, true);         // cPlanes
    // jifRate: 1 jiffie = 1/60 sec. Convert fps to jiffies.
    const jiffies = Math.max(1, Math.round(60 / frameRate));
    anihView.setUint32(28, jiffies, true);   // iDispRate (default rate in jiffies)
    anihView.setUint32(32, 0x01, true);      // flags: AF_ICON (frames are icons)

    // 'rate' chunk: 4 bytes per frame
    const rateData = new ArrayBuffer(4 * numFrames);
    const rateView = new DataView(rateData);
    for (let i = 0; i < numFrames; i++) {
      rateView.setUint32(i * 4, jiffies, true);
    }

    // 'seq ' chunk: 4 bytes per frame (sequential)
    const seqData = new ArrayBuffer(4 * numFrames);
    const seqView = new DataView(seqData);
    for (let i = 0; i < numFrames; i++) {
      seqView.setUint32(i * 4, i, true);
    }

    // Build LIST 'fram' content
    const framParts = [];
    for (const curBytes of curByteArrays) {
      // Each icon chunk: 'icon' + size(4) + data + padding
      const padded = curBytes.length % 2 === 0 ? curBytes : padArray(curBytes);
      const chunkHeader = new ArrayBuffer(8);
      const chunkView = new DataView(chunkHeader);
      chunkView.setUint8(0, 0x69); // 'i'
      chunkView.setUint8(1, 0x63); // 'c'
      chunkView.setUint8(2, 0x6F); // 'o'
      chunkView.setUint8(3, 0x6E); // 'n'
      chunkView.setUint32(4, curBytes.length, true);
      framParts.push(new Uint8Array(chunkHeader));
      framParts.push(padded);
    }

    // Compute sizes
    const framContentSize = framParts.reduce((s, p) => s + p.length, 0);
    const framListSize = 4 + framContentSize; // 'fram' + content

    // Build the full RIFF
    const parts = [];

    // Helper to push a chunk
    function pushChunk(tag, data) {
      const header = new ArrayBuffer(8);
      const hv = new DataView(header);
      for (let i = 0; i < 4; i++) hv.setUint8(i, tag.charCodeAt(i));
      hv.setUint32(4, data.byteLength, true);
      parts.push(new Uint8Array(header));
      const d = data instanceof Uint8Array ? data : new Uint8Array(data);
      parts.push(d);
      if (d.length % 2 !== 0) parts.push(new Uint8Array([0])); // padding
    }

    // 'anih'
    pushChunk('anih', anihData);

    // 'rate'
    pushChunk('rate', rateData);

    // 'seq '
    pushChunk('seq ', seqData);

    // LIST 'fram'
    const listHeader = new ArrayBuffer(12);
    const lv = new DataView(listHeader);
    lv.setUint8(0, 0x4C); // 'L'
    lv.setUint8(1, 0x49); // 'I'
    lv.setUint8(2, 0x53); // 'S'
    lv.setUint8(3, 0x54); // 'T'
    lv.setUint32(4, framListSize, true);
    lv.setUint8(8, 0x66);  // 'f'
    lv.setUint8(9, 0x72);  // 'r'
    lv.setUint8(10, 0x61); // 'a'
    lv.setUint8(11, 0x6D); // 'm'
    parts.push(new Uint8Array(listHeader));
    for (const p of framParts) parts.push(p);

    // Compute total RIFF content size
    const riffContentSize = 4 + parts.reduce((s, p) => s + p.length, 0); // 'ACON' + all parts

    // Build final buffer
    const riffHeader = new ArrayBuffer(12);
    const rv = new DataView(riffHeader);
    rv.setUint8(0, 0x52); // 'R'
    rv.setUint8(1, 0x49); // 'I'
    rv.setUint8(2, 0x46); // 'F'
    rv.setUint8(3, 0x46); // 'F'
    rv.setUint32(4, riffContentSize, true);
    rv.setUint8(8, 0x41);  // 'A'
    rv.setUint8(9, 0x43);  // 'C'
    rv.setUint8(10, 0x4F); // 'O'
    rv.setUint8(11, 0x4E); // 'N'

    const allParts = [new Uint8Array(riffHeader), ...parts];
    const totalSize = allParts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const p of allParts) {
      result.set(p, offset);
      offset += p.length;
    }

    return new Blob([result], { type: 'application/octet-stream' });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Convert a canvas to CUR file bytes (Uint8Array), not a Blob. */
  function buildCURBytes(canvas, hotspotX, hotspotY) {
    const dataUrl = canvas.toDataURL('image/png');
    const pngBytes = dataURLToBytes(dataUrl);

    const size = canvas.width;
    const fileSize = 6 + 16 + pngBytes.length;
    const buf = new ArrayBuffer(fileSize);
    const view = new DataView(buf);

    view.setUint16(0, 0, true);
    view.setUint16(2, 2, true);
    view.setUint16(4, 1, true);
    view.setUint8(6, size >= 256 ? 0 : size);
    view.setUint8(7, size >= 256 ? 0 : size);
    view.setUint8(8, 0);
    view.setUint8(9, 0);
    view.setUint16(10, hotspotX, true);
    view.setUint16(12, hotspotY, true);
    view.setUint32(14, pngBytes.length, true);
    view.setUint32(18, 22, true);

    const bytes = new Uint8Array(buf);
    bytes.set(pngBytes, 22);
    return bytes;
  }

  /** Convert data URL to Uint8Array of raw bytes. */
  function dataURLToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /** Pad a Uint8Array to even length. */
  function padArray(arr) {
    if (arr.length % 2 === 0) return arr;
    const padded = new Uint8Array(arr.length + 1);
    padded.set(arr);
    return padded;
  }

  // ─── Public API ───────────────────────────────────────────────────

  return {
    detectHotspot,
    resizeImage,
    buildCUR,
    buildANI,
  };
})();
