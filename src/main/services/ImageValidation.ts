// 统一约束应用内背景资源，避免同一类文件在上传、备份和自定义协议中得到不同判断。
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const SUPPORTED_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".gif",
] as const;

export const MAX_BACKGROUND_IMAGE_BYTES = 10 * 1024 * 1024;

export function isSupportedImageExtension(extension: string): boolean {
  const normalized = extension.toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.some((item) => item === normalized);
}

export function isSafeImageFileName(fileName: string): boolean {
  return (
    path.basename(fileName) === fileName &&
    isSupportedImageExtension(path.extname(fileName))
  );
}

export function assertImageSignature(header: Buffer, extension: string): void {
  const normalized = extension.toLowerCase();
  const isPng =
    header.length >= 8 &&
    header
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg =
    header.length >= 3 &&
    header.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  const isGif =
    header.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString());
  const isWebp =
    header.length >= 12 &&
    header.subarray(0, 4).toString() === "RIFF" &&
    header.subarray(8, 12).toString() === "WEBP";
  const isBmp = header.length >= 2 && header.subarray(0, 2).toString() === "BM";
  const valid =
    normalized === ".png"
      ? isPng
      : normalized === ".jpg" || normalized === ".jpeg"
        ? isJpeg
        : normalized === ".gif"
          ? isGif
          : normalized === ".webp"
            ? isWebp
            : normalized === ".bmp"
              ? isBmp
              : false;
  if (!valid) throw new Error("图片内容与扩展名不匹配或无法解析");
}

export async function validateImageFile(filePath: string): Promise<void> {
  const extension = path.extname(filePath).toLowerCase();
  if (!isSupportedImageExtension(extension))
    throw new Error("不支持的图片格式");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("背景资源不是普通文件");
  if (stat.size > MAX_BACKGROUND_IMAGE_BYTES)
    throw new Error("图片大小超过 10MB 限制");
  assertImageSignature(await fs.readFile(filePath), extension);
}
