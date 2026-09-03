import QRCode from 'qrcode';

/**
 * Generates a standard SVG string representation of a QR code.
 * Fully compliant with ISO/IEC 18004 QR code specifications for camera scanners.
 */
export async function generateQrSvg(text: string, size: number = 180): Promise<string> {
  if (!text) return '';
  try {
    return await QRCode.toString(text, {
      type: 'svg',
      margin: 2,
      width: size,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
  } catch (err) {
    console.error('[QR] Failed to generate QR code SVG:', err);
    return '';
  }
}

/**
 * Generates a PNG Data URL of the QR code for highest fidelity camera scanning.
 */
export async function generateQrDataUrl(text: string, size: number = 240): Promise<string> {
  if (!text) return '';
  try {
    return await QRCode.toDataURL(text, {
      margin: 2,
      width: size,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
  } catch (err) {
    console.error('[QR] Failed to generate QR code DataURL:', err);
    return '';
  }
}
