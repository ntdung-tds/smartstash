/**
 * In nhãn QR ra giấy/PDF (Phase 4) — dựng trang A4 bằng HTML + expo-print.
 *
 * Cổng gói (Phase 6 — ĐÃ ÁP): tính năng này là của gói Pro
 * (PLAN_LIMITS.allowQrPrintPdf: FREE = false, PRO = true). Việc kiểm tra nằm
 * ở src/app/labels.tsx (ensureQrAllowed qua planService) — gói FREE sẽ thấy
 * popup nâng cấp thay vì in thật; service này không tự kiểm tra gói.
 */
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { qrSvgString } from './qrSvg';

/** Một nhãn in: code là chuỗi mã hoá vào QR (qr_code của vị trí / barcode của món, giữ nguyên gốc) */
export interface LabelData {
  code: string;
  title: string;
  subtitle?: string;
}

export type LabelSize = 'S' | 'M' | 'L';

interface SizeSpec {
  columns: number;
  labelWidthMm: number;
  labelHeightMm: number;
  qrMm: number;
  /** S xếp dọc (QR trên, chữ dưới); M/L xếp ngang (QR trái, chữ phải) */
  layout: 'column' | 'row';
  titlePt: number;
  subtitlePt: number;
}

const SIZE_SPECS: Record<LabelSize, SizeSpec> = {
  // Trang A4: vùng in 190mm ngang (210 − lề 10×2) — S: 3×63=189mm, 7 hàng = 21 nhãn
  S: { columns: 3, labelWidthMm: 63, labelHeightMm: 38, qrMm: 21, layout: 'column', titlePt: 11, subtitlePt: 8 },
  // M: 2×95=190mm, 5 hàng = 10 nhãn
  M: { columns: 2, labelWidthMm: 95, labelHeightMm: 55, qrMm: 33, layout: 'row', titlePt: 14, subtitlePt: 9.5 },
  // L: 1×190mm, 4 hàng = 4 nhãn
  L: { columns: 1, labelWidthMm: 190, labelHeightMm: 65, qrMm: 42, layout: 'row', titlePt: 17, subtitlePt: 10 },
};

/** Thoát các ký tự đặc biệt HTML trong nội dung do người dùng nhập */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function labelHtml(label: LabelData, spec: SizeSpec): string {
  const svg = qrSvgString(label.code);
  const subtitle = label.subtitle
    ? `<div class="sub">${escapeHtml(label.subtitle)}</div>`
    : '';
  return (
    `<div class="label">` +
    `<div class="qrbox"><div class="qr">${svg}</div><div class="code">${escapeHtml(label.code)}</div></div>` +
    `<div class="txt"><div class="name">${escapeHtml(label.title)}</div>${subtitle}</div>` +
    `</div>`
  );
}

/**
 * Dựng HTML hoàn chỉnh cho trang in A4.
 * Phân trang: MỘT container .sheet duy nhất chứa lưới nhãn; công cụ in của WebView
 * tự ngắt trang theo hàng, mỗi nhãn có break-inside: avoid nên không bao giờ bị
 * cắt đôi giữa hai trang — tin cậy hơn việc tự chia .sheet thủ công theo số nhãn/trang
 * (tránh trang trắng thừa khi số nhãn không chẵn).
 */
export function buildLabelsHtml(labels: LabelData[], size: LabelSize): string {
  const spec = SIZE_SPECS[size];
  const columnGapMm = spec.columns > 1 ? (190 - spec.columns * spec.labelWidthMm) / (spec.columns - 1) : 0;
  const items = labels.map((l) => labelHtml(l, spec)).join('');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .sheet {
    width: 210mm; padding: 10mm;
    display: grid;
    grid-template-columns: repeat(${spec.columns}, ${spec.labelWidthMm}mm);
    column-gap: ${columnGapMm}mm;
    row-gap: 0;
    justify-content: center;
  }
  .label {
    width: ${spec.labelWidthMm}mm; height: ${spec.labelHeightMm}mm;
    border: 0.4pt dashed #B9B3CC;
    padding: 2.5mm;
    display: flex;
    ${spec.layout === 'column'
      ? 'flex-direction: column; align-items: center; justify-content: center; gap: 1.2mm; text-align: center;'
      : 'flex-direction: row; align-items: center; gap: 4mm; text-align: left;'}
    break-inside: avoid;
    page-break-inside: avoid;
    overflow: hidden;
  }
  .qrbox { display: flex; flex-direction: column; align-items: center; gap: 0.8mm; flex: none; }
  .qr { width: ${spec.qrMm}mm; height: ${spec.qrMm}mm; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .code { font-family: 'Courier New', monospace; font-size: 6.5pt; color: #8A86A0; }
  .txt { ${spec.layout === 'row' ? 'flex: 1; min-width: 0;' : 'width: 100%;'} }
  .name {
    font-weight: 700; color: #241E42; font-size: ${spec.titlePt}pt; line-height: 1.25;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .sub {
    color: #6B6880; font-size: ${spec.subtitlePt}pt; line-height: 1.3; margin-top: 1mm;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
</style>
</head>
<body><div class="sheet">${items}</div></body>
</html>`;
}

/** Mở hộp thoại in hệ thống với trang nhãn đã dựng */
export async function printLabels(labels: LabelData[], size: LabelSize): Promise<void> {
  const html = buildLabelsHtml(labels, size);
  await Print.printAsync({ html });
}

/**
 * Tạo file PDF (A4: 595×842pt) rồi mở hộp chia sẻ hệ thống.
 * Trả về uri file PDF đã tạo (kể cả khi máy không hỗ trợ chia sẻ).
 */
export async function shareLabelsPdf(labels: LabelData[], size: LabelSize, dialogTitle: string): Promise<string> {
  const html = buildLabelsHtml(labels, size);
  const { uri } = await Print.printToFileAsync({ html, width: 595, height: 842 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle, UTI: '.pdf' });
  }
  return uri;
}
