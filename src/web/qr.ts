import QRCode from 'qrcode';
import { AppError } from '../errors';

/**
 * QR rendering.
 *
 * A provider may return either a UPI intent string (we render it ourselves) or
 * a hosted image URL (we proxy it, so the customer's browser never talks to a
 * third party and the pay link token is not leaked in a Referer header).
 */

const MAX_IMAGE_BYTES = 512 * 1024;

export async function renderQrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}

export async function fetchProviderQrImage(url: string): Promise<{ body: Buffer; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Provider returned an invalid QR URL', 502);
  }
  if (parsed.protocol !== 'https:') {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Provider QR URL must use https', 502);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(parsed, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new AppError('PROVIDER_UNAVAILABLE', `QR image fetch failed (${res.status})`, 502);
    const contentType = res.headers.get('content-type') ?? '';
    if (!/^image\/(png|jpeg|webp)/.test(contentType)) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'Provider QR URL did not return an image', 502);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'Provider QR image is too large', 502);
    }
    return { body: Buffer.from(arrayBuffer), contentType };
  } finally {
    clearTimeout(timeout);
  }
}

/** Renders whichever QR form the provider gave us. */
export async function qrResponse(qrPayload: string): Promise<{ body: Buffer; contentType: string }> {
  if (/^https:\/\//i.test(qrPayload)) return fetchProviderQrImage(qrPayload);
  return { body: await renderQrPng(qrPayload), contentType: 'image/png' };
}
