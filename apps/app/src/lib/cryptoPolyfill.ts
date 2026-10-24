import { getRandomBytes } from 'expo-crypto';

/**
 * Polyfill `crypto.getRandomValues` cho Hermes (JS engine của React Native).
 *
 * Hermes KHÔNG có Web Crypto API: `crypto.getRandomValues` bị thiếu khiến
 * crypto-js văng lỗi "Native crypto module could not be used to get secure
 * random number" mỗi khi cần số ngẫu nhiên an toàn (tạo salt/IV khi mã hoá
 * sao lưu, salt khi đặt mã PIN…). Test bằng node thì qua (node có sẵn Web
 * Crypto) nên lỗi chỉ lộ trên máy thật.
 *
 * Cách vá: mượn `getRandomBytes` của expo-crypto (native, CSPRNG của hệ điều
 * hành) để cài `global.crypto.getRandomValues` đúng chuẩn Web Crypto:
 * nhận MỌI typed array, điền bytes ngẫu nhiên vào đúng view đó (tôn trọng
 * byteOffset/byteLength) và trả về chính array được truyền vào.
 *
 * File này chạy side-effect ngay khi import và IDEMPOTENT: nếu môi trường
 * đã có sẵn getRandomValues xịn thì giữ nguyên, không ghi đè.
 */

type RandomValuesFn = <T extends ArrayBufferView>(array: T) => T;

interface CryptoLike {
  getRandomValues?: RandomValuesFn;
}

const g = globalThis as unknown as { crypto?: CryptoLike };

function installCryptoPolyfill(): void {
  try {
    if (typeof g.crypto?.getRandomValues === 'function') return;
    const getRandomValues: RandomValuesFn = <T extends ArrayBufferView>(array: T): T => {
      // getRandomValues chuẩn Web Crypto giới hạn 65.536 byte mỗi lần gọi
      if (array.byteLength > 65536) {
        throw new Error('crypto.getRandomValues: mảng vượt quá 65.536 byte');
      }
      const bytes = getRandomBytes(array.byteLength);
      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      view.set(bytes);
      return array;
    };
    if (!g.crypto) g.crypto = {};
    g.crypto.getRandomValues = getRandomValues;
  } catch {
    // Không cài được polyfill thì giữ nguyên hành vi cũ — nơi dùng crypto-js
    // sẽ tự báo lỗi rõ ràng thay vì app sập ngay khi khởi động.
  }
}

installCryptoPolyfill();
