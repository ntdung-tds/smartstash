/**
 * Sinh mã QR dạng SVG thuần JS bằng qrcode-generator (MIT, Kazuhiko Arase).
 * SVG dùng viewBox theo số module + quiet zone 4 module mỗi phía;
 * kích thước hiển thị thật do thuộc tính width/height (CSS mm) ở nơi dùng quyết.
 */
import qrcodeGenerator from 'qrcode-generator';

/** Số module vùng lặng (quiet zone) quanh QR — chuẩn QR yêu cầu tối thiểu 4 */
const QUIET_ZONE = 4;

/**
 * Ma trận module của mã QR cho chuỗi dữ liệu cho trước.
 * typeNumber 0 = tự động chọn phiên bản nhỏ nhất vừa dữ liệu; mức sửa lỗi 'M' (~15%).
 * Trả về mảng 2 chiều boolean: true = module tối. Ném lỗi nếu dữ liệu rỗng/quá dài.
 */
export function qrMatrix(data: string): boolean[][] {
  if (!data) throw new Error('QR data is empty');
  const qr = qrcodeGenerator(0, 'M');
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < count; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < count; col++) {
      line.push(qr.isDark(row, col));
    }
    matrix.push(line);
  }
  return matrix;
}

/**
 * Chuỗi SVG hoàn chỉnh cho một mã QR.
 * Các module tối được gộp theo từng hàng thành các đoạn path liên tục để HTML nhẹ.
 * Nền trắng vẽ bằng <rect> để máy in/máy quét luôn có tương phản đủ.
 */
export function qrSvgString(data: string): string {
  const matrix = qrMatrix(data);
  const count = matrix.length;
  const size = count + QUIET_ZONE * 2;
  const runs: string[] = [];
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!matrix[row][col]) {
        col++;
        continue;
      }
      let end = col;
      while (end + 1 < count && matrix[row][end + 1]) end++;
      const x = col + QUIET_ZONE;
      const y = row + QUIET_ZONE;
      const len = end - col + 1;
      runs.push(`M${x} ${y}h${len}v1H${x}z`);
      col = end + 1;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="#FFFFFF"/>` +
    `<path d="${runs.join('')}" fill="#000000"/>` +
    `</svg>`
  );
}
