import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { uuid } from '../utils';
import { registerMedia } from '../db/queries';
import type { MediaFile, MediaKind } from '../types';

const IMAGES_DIR = (FileSystem.documentDirectory ?? '') + 'images/';
const THUMBS_DIR = (FileSystem.documentDirectory ?? '') + 'thumbs/';

async function ensureDirs(): Promise<void> {
  for (const dir of [IMAGES_DIR, THUMBS_DIR]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  }
}

export interface PickedPhoto {
  uri: string; // ảnh gốc trong cache của hệ thống
  width: number;
  height: number;
}

/**
 * Lưu ảnh avatar người dùng (Trang chủ): cắt VUÔNG ở giữa, thu về tối đa
 * 512px, JPEG vào thư mục ảnh của app với tên kèm mốc thời gian (tên mới
 * mỗi lần đổi để Image không dính cache theo URI cũ). Trả URI bền trong
 * app — nơi gọi tự lưu vào app_kv ('avatar_uri') và xoá file cũ bằng
 * removeAvatarImage. Avatar KHÔNG đăng ký vào media_files (không thuộc
 * món/vị trí nào).
 */
export async function saveAvatarImage(photo: PickedPhoto): Promise<string> {
  await ensureDirs();
  const side = Math.min(photo.width, photo.height);
  const actions: ImageManipulator.Action[] = [];
  if (side > 0 && (photo.width !== photo.height)) {
    actions.push({
      crop: {
        originX: Math.max(0, Math.round((photo.width - side) / 2)),
        originY: Math.max(0, Math.round((photo.height - side) / 2)),
        width: side,
        height: side,
      },
    });
  }
  if (side > 512) actions.push({ resize: { width: 512 } });
  const out = await ImageManipulator.manipulateAsync(photo.uri, actions, {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  const destUri = `${IMAGES_DIR}avatar-${Date.now()}.jpg`;
  await FileSystem.copyAsync({ from: out.uri, to: destUri });
  return destUri;
}

/** Xoá file avatar cũ trong thư mục ảnh của app (best-effort, chỉ xoá file avatar-*) */
export async function removeAvatarImage(uri: string): Promise<void> {
  try {
    if (!uri.startsWith(IMAGES_DIR) || !uri.includes('avatar-')) return;
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // dọn dẹp là best-effort
  }
}

export async function takePhoto(): Promise<PickedPhoto | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  if (result.canceled || !result.assets?.[0]) return null;
  const a = result.assets[0];
  return { uri: a.uri, width: a.width, height: a.height };
}

export async function pickPhoto(): Promise<PickedPhoto | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
  if (result.canceled || !result.assets?.[0]) return null;
  const a = result.assets[0];
  return { uri: a.uri, width: a.width, height: a.height };
}

/**
 * Chọn NHIỀU ảnh từ thư viện trong 1 lần (allowsMultipleSelection, SDK 58).
 * selectionLimit = số slot còn lại để picker tự chặn; tầng gọi vẫn cắt
 * phòng thủ + báo giới hạn vì một số máy bỏ qua selectionLimit.
 */
export async function pickPhotos(limit: number): Promise<PickedPhoto[]> {
  if (limit <= 0) return [];
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [];
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsMultipleSelection: true,
    selectionLimit: limit,
  });
  if (result.canceled || !result.assets) return [];
  return result.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height }));
}

/**
 * Nén ảnh (cạnh dài tối đa 1280px, WebP trên Android / JPEG trên iOS — V21-10),
 * tạo thumbnail 300px, lưu vào thư mục app và đăng ký vào media_files.
 */
export async function processAndRegisterPhoto(
  photo: PickedPhoto,
  ownerType: MediaFile['owner_type'],
  ownerId: string,
  kind: MediaKind,
  isPrimary = false,
): Promise<MediaFile> {
  await ensureDirs();
  const mediaId = uuid();
  const isWebP = Platform.OS === 'android';
  const ext = isWebP ? 'webp' : 'jpg';
  const format = isWebP ? ImageManipulator.SaveFormat.WEBP : ImageManipulator.SaveFormat.JPEG;

  const resized = await ImageManipulator.manipulateAsync(
    photo.uri,
    photo.width > 1280 ? [{ resize: { width: 1280 } }] : [],
    { compress: 0.75, format },
  );
  const destUri = `${IMAGES_DIR}${mediaId}.${ext}`;
  await FileSystem.copyAsync({ from: resized.uri, to: destUri });

  const thumb = await ImageManipulator.manipulateAsync(
    resized.uri,
    [{ resize: { width: 300 } }],
    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
  );
  const thumbUri = `${THUMBS_DIR}${mediaId}.jpg`;
  await FileSystem.copyAsync({ from: thumb.uri, to: thumbUri });

  let sha256: string | null = null;
  let sizeBytes: number | null = null;
  try {
    const info = await FileSystem.getInfoAsync(destUri);
    if (info.exists && 'size' in info) sizeBytes = info.size ?? null;
    const base64 = await FileSystem.readAsStringAsync(destUri, { encoding: FileSystem.EncodingType.Base64 });
    sha256 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64.slice(0, 200000) + (sizeBytes ?? ''));
  } catch {
    // checksum là best-effort ở POC
  }

  return registerMedia({
    kind,
    owner_type: ownerType,
    owner_id: ownerId,
    local_uri: destUri,
    thumbnail_uri: thumbUri,
    sha256,
    size_bytes: sizeBytes,
    is_primary: isPrimary,
  });
}
