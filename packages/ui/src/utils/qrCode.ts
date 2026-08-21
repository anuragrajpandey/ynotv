/**
 * Lightweight, zero-dependency offline QR Code generator for YNOTV Phone Remote.
 * Generates pure SVG string for standard URLs.
 */

// Error correction tables and polynomial generator
const GF256_EXP: number[] = new Array(512);
const GF256_LOG: number[] = new Array(256);

(function initGF256() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_EXP[i + 255] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]];
}

function polyMul(p1: number[], p2: number[]): number[] {
  const res = new Array(p1.length + p2.length - 1).fill(0);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      res[i + j] ^= gfMul(p1[i], p2[j]);
    }
  }
  return res;
}

function getGeneratorPoly(numEcBytes: number): number[] {
  let g = [1];
  for (let i = 0; i < numEcBytes; i++) {
    g = polyMul(g, [1, GF256_EXP[i]]);
  }
  return g;
}

function calculateEcBytes(dataBytes: number[], numEcBytes: number): number[] {
  const g = getGeneratorPoly(numEcBytes);
  const msg = [...dataBytes, ...new Array(numEcBytes).fill(0)];
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = msg[i];
    if (factor !== 0) {
      for (let j = 0; j < g.length; j++) {
        msg[i + j] ^= gfMul(g[j], factor);
      }
    }
  }
  return msg.slice(dataBytes.length);
}

// Minimal QR Code Model (Version 3/4 Byte Mode, Error Correction Low/Medium)
export function generateQrSvg(text: string, size: number = 160): string {
  const utf8Bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 128) {
      utf8Bytes.push(c);
    } else if (c < 2048) {
      utf8Bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      utf8Bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }

  // Version selection
  let version = 3;
  let maxBytes = 42; // Version 3-M
  let numEc = 26;
  let moduleCount = 29;

  if (utf8Bytes.length > 34) {
    version = 4;
    maxBytes = 62; // Version 4-M
    numEc = 36;
    moduleCount = 33;
  }
  if (utf8Bytes.length > 54) {
    version = 6;
    maxBytes = 106;
    numEc = 48;
    moduleCount = 41;
  }

  // Build bit buffer
  const bitBuf: number[] = [];
  function pushBits(val: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      bitBuf.push((val >> i) & 1);
    }
  }

  // 0100 = 8-bit byte mode
  pushBits(4, 4);
  pushBits(utf8Bytes.length, 8);
  for (const b of utf8Bytes) {
    pushBits(b, 8);
  }

  // Terminator
  const totalDataBits = (maxBytes - numEc) * 8;
  while (bitBuf.length < totalDataBits && bitBuf.length % 8 !== 0) {
    bitBuf.push(0);
  }
  while (bitBuf.length < totalDataBits) {
    pushBits(0xec, 8);
    if (bitBuf.length < totalDataBits) pushBits(0x11, 8);
  }

  // Convert bits to bytes
  const dataBytes: number[] = [];
  for (let i = 0; i < bitBuf.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | (bitBuf[i + b] || 0);
    }
    dataBytes.push(byte);
  }

  const ecBytes = calculateEcBytes(dataBytes, numEc);
  const finalBytes = [...dataBytes, ...ecBytes];

  // Create grid
  const grid: (boolean | null)[][] = Array.from({ length: moduleCount }, () =>
    Array(moduleCount).fill(null)
  );

  function setFinder(row: number, col: number) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        if (
          r === 0 ||
          r === 6 ||
          c === 0 ||
          c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        ) {
          grid[row + r][col + c] = true;
        } else {
          grid[row + r][col + c] = false;
        }
      }
    }
    // Separator
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r;
        const nc = col + c;
        if (nr >= 0 && nr < moduleCount && nc >= 0 && nc < moduleCount && grid[nr][nc] === null) {
          grid[nr][nc] = false;
        }
      }
    }
  }

  // Set Finders
  setFinder(0, 0);
  setFinder(0, moduleCount - 7);
  setFinder(moduleCount - 7, 0);

  // Timing patterns
  for (let i = 8; i < moduleCount - 8; i++) {
    if (grid[6][i] === null) grid[6][i] = i % 2 === 0;
    if (grid[i][6] === null) grid[i][6] = i % 2 === 0;
  }

  // Dark module
  grid[4 * version + 9][8] = true;

  // Fill data with standard mask 0 ((row + col) % 2 == 0)
  let bitIdx = 0;
  const allBits: number[] = [];
  for (const b of finalBytes) {
    for (let bit = 7; bit >= 0; bit--) {
      allBits.push((b >> bit) & 1);
    }
  }

  let upward = true;
  for (let right = moduleCount - 1; right > 0; right -= 2) {
    if (right === 6) right--; // skip vertical timing column
    const cols = [right, right - 1];
    const rows = upward
      ? Array.from({ length: moduleCount }, (_, i) => moduleCount - 1 - i)
      : Array.from({ length: moduleCount }, (_, i) => i);

    for (const r of rows) {
      for (const c of cols) {
        if (grid[r][c] === null) {
          const bitVal = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
          const mask = (r + c) % 2 === 0;
          grid[r][c] = (bitVal ^ (mask ? 1 : 0)) === 1;
        }
      }
    }
    upward = !upward;
  }

  // Format bits (Mask 0, Level M: 101010000010010)
  const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
  for (let i = 0; i < 6; i++) grid[8][i] = formatBits[i] === 1;
  grid[8][7] = formatBits[6] === 1;
  grid[8][8] = formatBits[7] === 1;
  grid[7][8] = formatBits[8] === 1;
  for (let i = 9; i < 15; i++) grid[14 - i][8] = formatBits[i] === 1;

  for (let i = 0; i < 8; i++) grid[moduleCount - 1 - i][8] = formatBits[i] === 1;
  for (let i = 8; i < 15; i++) grid[8][moduleCount - 15 + i] = formatBits[i] === 1;

  // Render to SVG
  let path = '';
  const moduleSize = 1;
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (grid[r][c]) {
        path += `M${c + 2},${r + 2}h1v1h-1z `;
      }
    }
  }

  const totalDimension = moduleCount + 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDimension} ${totalDimension}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${totalDimension}" height="${totalDimension}" fill="#ffffff" rx="1"/><path d="${path.trim()}" fill="#0d1117"/></svg>`;
}
